import { validManagedIndex } from './indexes.ts';
import postgres from 'postgres';
import { removeCapture } from './task_queue.ts';
import type { Configuration } from './apply.ts';
import { fingerprint, render } from '../worker/worker.ts';
import { idType, quote, readContent, table } from '../worker/content.ts';

/** One active and one staged revision per entity, with immutable generation configuration. */
export async function installRevisions(tx: postgres.TransactionSql): Promise<void> {
  await tx.unsafe(`CREATE TABLE IF NOT EXISTS localembed.entity_revisions (
    configuration_id bigint NOT NULL REFERENCES localembed.configurations(id), entity text NOT NULL,
    state text NOT NULL CHECK(state IN ('active','staging','retired')), capture_namespace boolean NOT NULL DEFAULT false,
    PRIMARY KEY(configuration_id, entity));
    ALTER TABLE localembed.entity_revisions ADD COLUMN IF NOT EXISTS retired_at timestamptz;
    ALTER TABLE localembed.entity_revisions ADD COLUMN IF NOT EXISTS retired_execution_until timestamptz;
    ALTER TABLE localembed.entity_revisions ADD COLUMN IF NOT EXISTS cleaned_at timestamptz;
    UPDATE localembed.entity_revisions SET retired_at = clock_timestamp() WHERE state = 'retired' AND retired_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS entity_active ON localembed.entity_revisions(entity) WHERE state = 'active';
    CREATE UNIQUE INDEX IF NOT EXISTS entity_staging ON localembed.entity_revisions(entity) WHERE state = 'staging';
    CREATE OR REPLACE FUNCTION localembed.revision_eligible(revision bigint, entity_name text)
    RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $eligible$
      DECLARE current_state text;
      BEGIN
        SELECT state INTO current_state FROM localembed.entity_revisions
        WHERE configuration_id = revision AND entity = entity_name FOR SHARE;
        RETURN coalesce(current_state IN ('active','staging'), false);
      END $eligible$;
    REVOKE ALL ON FUNCTION localembed.revision_eligible(bigint, text) FROM PUBLIC;
    CREATE TABLE IF NOT EXISTS localembed.admin_actions (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, action text NOT NULL,
      actor text NOT NULL DEFAULT current_user, details jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp());
    CREATE OR REPLACE FUNCTION localembed.immutable_configuration() RETURNS trigger LANGUAGE plpgsql AS $immutable$
      BEGIN IF NEW.configuration IS DISTINCT FROM OLD.configuration THEN
        RAISE EXCEPTION 'Applied configurations are immutable; stage a new revision';
      END IF; RETURN NEW; END $immutable$;
    DROP TRIGGER IF EXISTS configurations_immutable ON localembed.configurations;
    CREATE TRIGGER configurations_immutable BEFORE UPDATE ON localembed.configurations
      FOR EACH ROW EXECUTE FUNCTION localembed.immutable_configuration()`);
  // Import legacy revisions once, retaining the newest declaration of each entity as active.
  await tx.unsafe(`INSERT INTO localembed.entity_revisions(configuration_id, entity, state)
    SELECT c.id, e->>'name', CASE WHEN c.id = max(c.id) OVER (PARTITION BY e->>'name') THEN 'active' ELSE 'retired' END
    FROM localembed.configurations c CROSS JOIN LATERAL jsonb_array_elements(c.configuration->'entities') e
    WHERE NOT EXISTS (SELECT 1 FROM localembed.entity_revisions known WHERE known.configuration_id = c.id)
    ON CONFLICT DO NOTHING`);
}

export async function reprocess(
  url: string,
  revision: string,
  entity: string,
  identifier?: string,
): Promise<number> {
  if (!/^\d+$/.test(revision)) throw new Error('Revision must be a numeric identifier');
  const sql = postgres(url, { max: 1 });
  let count = 0;
  try {
    // Bounded transaction batches; a repeated command never resets non-failed work.
    while (true) {
      const size = await sql.begin(async (tx) => {
        const [state] =
          await tx`SELECT state FROM localembed.entity_revisions WHERE configuration_id = ${revision} AND entity = ${entity} FOR SHARE`;
        if (!state || state.state === 'retired') {
          throw new Error('Revision is not eligible for reprocessing');
        }
        const rows =
          await tx`SELECT id, generation, attempts, error_code, provider_status FROM localembed.tasks
          WHERE configuration_id = ${revision} AND entity = ${entity} AND status = 'failed'
          AND (${identifier ?? null}::text IS NULL OR source_id = ${identifier ?? null})
          ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`;
        for (const row of rows) {
          await tx`INSERT INTO localembed.admin_actions(action, details) VALUES ('reprocess', ${
            tx.json(row)
          })`;
          await tx`UPDATE localembed.tasks SET status = 'pending', attempts = 0, retry_generation = generation,
            next_attempt_at = clock_timestamp(), requested_at = clock_timestamp(), last_error = NULL,
            error_code = NULL, provider_status = NULL, lease_token = NULL, lease_until = NULL, execution_deadline = NULL WHERE id = ${row.id}`;
        }
        return rows.length;
      });
      count += size;
      if (size < 100) break;
    }
    return count;
  } finally {
    await sql.end();
  }
}

export async function activate(url: string, revision: string): Promise<void> {
  if (!/^\d+$/.test(revision)) throw new Error('Revision must be a numeric identifier');
  const sql = postgres(url, { max: 1 });
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(78129412)`;
      const [row] =
        await tx`SELECT configuration FROM localembed.configurations WHERE id = ${revision}`;
      if (!row) throw new Error('Unknown revision');
      const config = row.configuration as Configuration;
      const sources = new Set(
        config.entities.flatMap((
          entity,
        ) => [entity.source.table, ...(entity.dependencies ?? []).map((dep) => dep.target.table)]),
      );
      // Block source writers before acquiring exclusive revision ownership; workers can finish.
      for (const source of [...sources].sort()) {
        await tx.unsafe(`LOCK TABLE ${table(source)} IN SHARE ROW EXCLUSIVE MODE`);
      }
      const states =
        await tx`SELECT * FROM localembed.entity_revisions WHERE configuration_id = ${revision} ORDER BY entity FOR UPDATE`;
      if (
        states.length === config.entities.length &&
        states.every((state) => state.state === 'active')
      ) return;
      if (
        states.length !== config.entities.length ||
        states.some((state) => state.state !== 'staging')
      ) throw new Error('Only a staged revision can be activated');
      for (const entity of config.entities) {
        const [backfill] =
          await tx`SELECT complete, indexed FROM localembed.backfills WHERE configuration_id = ${revision} AND entity = ${entity.name}`;
        if (!backfill?.complete || !backfill.indexed) {
          throw new Error('Finish backfill and index creation before activation');
        }
        const pending =
          await tx`SELECT 1 FROM localembed.tasks WHERE configuration_id = ${revision} AND entity = ${entity.name} AND status <> 'done' LIMIT 1`;
        if (pending.length) throw new Error('Drain staged tasks before activation');
        const provider = config.providers.find((item) => item.name === entity.provider)!;
        if (!await validManagedIndex(tx, entity, provider)) {
          throw new Error('Destination needs a valid matching HNSW index');
        }
        let cursor: string | null = null;
        while (true) {
          const ids: { identifier: string }[] = await tx.unsafe(
            `SELECT ${quote(entity.source.id.column)}::text AS identifier FROM ${
              table(entity.source.table)
            } WHERE ($1::${idType(entity.source.id.type)} IS NULL OR ${
              quote(entity.source.id.column)
            } > $1::${idType(entity.source.id.type)}) ORDER BY ${
              quote(entity.source.id.column)
            } LIMIT 100`,
            [cursor],
          );
          for (const item of ids) {
            const content = await readContent(tx, entity, item.identifier);
            const hash = await fingerprint(entity, provider, render(entity, content!));
            const [stored] = await tx.unsafe(
              `SELECT fingerprint FROM ${table(entity.destination.table)} WHERE source_id = $1::${
                idType(entity.source.id.type)
              }`,
              [item.identifier],
            );
            if (stored?.fingerprint !== hash) {
              throw new Error(
                'Staged destination is outdated; reconcile and drain before activation',
              );
            }
          }
          if (ids.length < 100) break;
          cursor = ids.at(-1)!.identifier;
        }
        const orphan = await tx.unsafe(
          `SELECT 1 FROM ${table(entity.destination.table)} d WHERE NOT EXISTS (SELECT 1 FROM ${
            table(entity.source.table)
          } s WHERE s.${quote(entity.source.id.column)} = d.source_id) LIMIT 1`,
        );
        if (orphan.length) throw new Error('Reconcile orphan embeddings before activation');
        // Lock old revision rows after the candidate: administrators serialize on the advisory lock.
        const old =
          await tx`SELECT v.configuration_id, v.capture_namespace, c.configuration FROM localembed.entity_revisions v JOIN localembed.configurations c ON c.id = v.configuration_id WHERE v.entity = ${entity.name} AND v.state = 'active' FOR UPDATE OF v`;
        for (const previous of old) {
          const oldConfig = previous.configuration as Configuration;
          const oldEntity = oldConfig.entities.find((item) => item.name === entity.name)!;
          await removeCapture(
            tx,
            oldEntity,
            previous.configuration_id,
            previous.capture_namespace,
            oldConfig.entities.indexOf(oldEntity),
          );
          await tx`UPDATE localembed.entity_revisions SET state = 'retired', retired_at = clock_timestamp(), retired_execution_until = (SELECT max(execution_deadline) FROM localembed.tasks WHERE configuration_id = ${previous.configuration_id} AND entity = ${entity.name}) WHERE configuration_id = ${previous.configuration_id} AND entity = ${entity.name}`;
          await tx`UPDATE localembed.tasks SET superseded_from_status = status, status = 'superseded', lease_token = NULL, lease_until = NULL, execution_deadline = NULL
            WHERE configuration_id = ${previous.configuration_id} AND entity = ${entity.name} AND status <> 'done'`;
        }
        await tx`UPDATE localembed.entity_revisions SET state = 'active' WHERE configuration_id = ${revision} AND entity = ${entity.name}`;
      }
      await tx`INSERT INTO localembed.admin_actions(action, details) VALUES ('activate', ${
        tx.json({ revision })
      })`;
    });
  } finally {
    await sql.end();
  }
}

export async function cancelRevision(url: string, revision: string): Promise<void> {
  if (!/^\d+$/.test(revision)) throw new Error('Revision must be a numeric identifier');
  const sql = postgres(url, { max: 1 });
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(78129412)`;
      const [row] =
        await tx`SELECT configuration FROM localembed.configurations WHERE id = ${revision}`;
      if (!row) throw new Error('Unknown revision');
      const config = row.configuration as Configuration;
      const sources = new Set(
        config.entities.flatMap((
          entity,
        ) => [entity.source.table, ...(entity.dependencies ?? []).map((dep) => dep.target.table)]),
      );
      for (const source of [...sources].sort()) {
        await tx.unsafe(`LOCK TABLE ${table(source)} IN SHARE ROW EXCLUSIVE MODE`);
      }
      const states =
        await tx`SELECT entity, state, capture_namespace FROM localembed.entity_revisions WHERE configuration_id = ${revision} ORDER BY entity FOR UPDATE`;
      if (!states.length || states.some((state) => state.state !== 'staging')) {
        throw new Error('Only a staged revision can be cancelled');
      }
      for (const [index, entity] of config.entities.entries()) {
        await removeCapture(
          tx,
          entity,
          revision,
          states.find((state) => state.entity === entity.name)!.capture_namespace,
          index,
        );
      }
      await tx`UPDATE localembed.entity_revisions SET state = 'retired', retired_at = clock_timestamp(), retired_execution_until = (SELECT max(execution_deadline) FROM localembed.tasks WHERE configuration_id = ${revision}) WHERE configuration_id = ${revision}`;
      await tx`UPDATE localembed.tasks SET superseded_from_status = status, status = 'superseded', lease_token = NULL, lease_until = NULL, execution_deadline = NULL WHERE configuration_id = ${revision} AND status <> 'done'`;
      await tx`INSERT INTO localembed.admin_actions(action, details) VALUES ('cancel', ${
        tx.json({ revision })
      })`;
    });
  } finally {
    await sql.end();
  }
}
