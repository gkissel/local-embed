import type postgres from 'postgres';
import type { Configuration } from './apply.ts';

const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
const table = (s: string) => s.split('.').map(quote).join('.');
const literal = (s: string) => "'" + s.replaceAll("'", "''") + "'";

/** Caller owns the administrative lock and has locked source tables before upgrading. */
export async function installTaskQueue(tx: postgres.TransactionSql): Promise<void> {
  await tx.unsafe(`CREATE TABLE IF NOT EXISTS localembed.tasks (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    configuration_id bigint NOT NULL REFERENCES localembed.configurations(id),
    entity text NOT NULL, source_id text NOT NULL,
    operation text NOT NULL CHECK (operation IN ('upsert','delete')),
    status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, last_error text);
    ALTER TABLE localembed.tasks ADD COLUMN IF NOT EXISTS generation bigint NOT NULL DEFAULT 1;
    ALTER TABLE localembed.tasks ADD COLUMN IF NOT EXISTS processed_generation bigint NOT NULL DEFAULT 0;
    ALTER TABLE localembed.tasks ADD COLUMN IF NOT EXISTS lease_until timestamptz;
    ALTER TABLE localembed.tasks ADD COLUMN IF NOT EXISTS last_error text;
    ALTER TABLE localembed.tasks ADD COLUMN IF NOT EXISTS lease_token uuid;
    ALTER TABLE localembed.tasks ADD COLUMN IF NOT EXISTS execution_deadline timestamptz;
    ALTER TABLE localembed.tasks ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE localembed.tasks ADD COLUMN IF NOT EXISTS retry_generation bigint NOT NULL DEFAULT 1;
    ALTER TABLE localembed.tasks ADD COLUMN IF NOT EXISTS error_code text;
    ALTER TABLE localembed.tasks ADD COLUMN IF NOT EXISTS provider_status integer;
    ALTER TABLE localembed.tasks ADD COLUMN IF NOT EXISTS requested_at timestamptz NOT NULL DEFAULT now();`);
  const [installed] = await tx`SELECT to_regclass('localembed.tasks_key') AS installed`;
  if (!installed.installed) {
    // Fold the old append-only queue under an exclusive lock. Increment attempts to
    // fence legacy workers, which used attempts as their execution identity.
    await tx.unsafe(`LOCK TABLE localembed.tasks IN ACCESS EXCLUSIVE MODE;
      CREATE TEMP TABLE folded_tasks ON COMMIT DROP AS
      SELECT min(id) AS id, configuration_id, entity, source_id,
        sum(generation)::bigint AS generation, max(attempts) + 1 AS attempts,
        CASE WHEN bool_or(status IN ('pending','processing')) THEN 'pending'
             WHEN bool_or(status = 'failed') THEN 'failed' ELSE 'done' END AS status,
        (array_agg(operation ORDER BY id DESC))[1] AS operation,
        max(last_error) AS last_error
      FROM localembed.tasks GROUP BY configuration_id, entity, source_id;
      DELETE FROM localembed.tasks t USING folded_tasks f
      WHERE t.configuration_id = f.configuration_id AND t.entity = f.entity
        AND t.source_id = f.source_id AND t.id <> f.id;
      UPDATE localembed.tasks t SET generation = f.generation,
        processed_generation = CASE WHEN f.status = 'done' THEN f.generation ELSE 0 END,
        attempts = f.attempts, status = f.status, operation = f.operation,
        last_error = f.last_error, lease_until = NULL, lease_token = NULL, execution_deadline = NULL
      FROM folded_tasks f WHERE t.id = f.id;
      CREATE UNIQUE INDEX tasks_key ON localembed.tasks(configuration_id, entity, source_id);`);
  }
  await tx.unsafe(
    `CREATE INDEX IF NOT EXISTS tasks_ready ON localembed.tasks (requested_at, id) WHERE status IN ('pending', 'processing');
    DROP INDEX IF EXISTS localembed.tasks_available;
    CREATE OR REPLACE FUNCTION localembed.enqueue_task(revision bigint, entity_name text, identifier text, change_operation text)
    RETURNS void LANGUAGE plpgsql AS $enqueue$
    BEGIN
      IF NOT localembed.revision_eligible(revision, entity_name) THEN RETURN; END IF;
      INSERT INTO localembed.tasks(configuration_id, entity, source_id, operation)
      VALUES (revision, entity_name, identifier, change_operation)
      ON CONFLICT(configuration_id, entity, source_id) DO UPDATE SET
        generation = localembed.tasks.generation + 1,
        operation = EXCLUDED.operation, requested_at = clock_timestamp(),
        next_attempt_at = CASE WHEN localembed.tasks.status IN ('processing','failed') THEN localembed.tasks.next_attempt_at ELSE clock_timestamp() END,
        retry_generation = CASE WHEN localembed.tasks.status IN ('processing','failed') THEN localembed.tasks.retry_generation ELSE localembed.tasks.generation + 1 END,
        status = CASE WHEN localembed.tasks.status IN ('processing','failed') THEN localembed.tasks.status ELSE 'pending' END,
        attempts = CASE WHEN localembed.tasks.status IN ('processing','failed') THEN localembed.tasks.attempts ELSE 0 END,
        error_code = CASE WHEN localembed.tasks.status = 'failed' THEN localembed.tasks.error_code ELSE NULL END,
        provider_status = CASE WHEN localembed.tasks.status = 'failed' THEN localembed.tasks.provider_status ELSE NULL END,
        last_error = CASE WHEN localembed.tasks.status = 'failed' THEN localembed.tasks.last_error ELSE NULL END;
    END;
    $enqueue$;`,
  );
}

export async function installCapture(
  tx: postgres.TransactionSql,
  entity: Configuration['entities'][number],
  revision: string | number,
  namespaced = false,
  entityIndex = 0,
): Promise<void> {
  const captureName = namespaced ? `r${revision}_e${entityIndex}` : entity.name;
  const fn = table(`localembed.capture_${captureName}`);
  const id = quote(entity.source.id.column);
  const idType =
    { uuid: 'uuid', bigint: 'bigint', text: 'text', ulid: 'text' }[entity.source.id.type];
  const lock = table(`localembed.lock_source_${entity.name}`);
  // FOR SHARE requires UPDATE privileges in PostgreSQL. Expose only a fixed,
  // identifier-bound locking read so the worker retains SELECT-only source access.
  await tx.unsafe(`CREATE OR REPLACE FUNCTION ${lock}(identifier text)
    RETURNS SETOF ${table(entity.source.table)} LANGUAGE sql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog AS $lock$
      SELECT * FROM ${table(entity.source.table)} WHERE ${id} = $1::${idType} FOR SHARE
    $lock$;
    REVOKE ALL ON FUNCTION ${lock}(text) FROM PUBLIC`);

  for (const [index, dep] of (entity.dependencies ?? []).entries()) {
    const lockDep = table(`localembed.lock_dep_${entity.name}_${index}`);
    const type = { uuid: 'uuid', bigint: 'bigint', text: 'text', ulid: 'text' }[dep.target.id.type];
    await tx.unsafe(`CREATE OR REPLACE FUNCTION ${lockDep}(identifier text)
      RETURNS SETOF ${table(dep.target.table)} LANGUAGE sql VOLATILE SECURITY DEFINER
      SET search_path = pg_catalog AS $lock$
      SELECT * FROM ${table(dep.target.table)} WHERE ${
      quote(dep.target.id.column)
    } = $1::${type} FOR SHARE
      $lock$; REVOKE ALL ON FUNCTION ${lockDep}(text) FROM PUBLIC`);
  }
  if (entity.source.detection.mode === 'polling') return;

  const compared = [
    ...new Set([
      entity.source.id.column,
      ...(entity.fields ?? []),
      ...(entity.dependencies ?? []).map((dep) => dep.source_column),
    ]),
  ];
  // JSONB comparison also supports JSON source columns, which lack SQL equality.
  const values = (record: string) =>
    compared.map((field) => `${record}.${quote(field)}`).join(', ');
  await tx.unsafe(`CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $capture$
    BEGIN
      IF TG_OP = 'UPDATE' AND
        jsonb_build_array(${values('OLD')}) IS NOT DISTINCT FROM jsonb_build_array(${
    values('NEW')
  }) THEN
        RETURN NEW;
      END IF;
      IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.${id} IS DISTINCT FROM NEW.${id}) THEN
        PERFORM localembed.enqueue_task(${revision}, ${
    literal(entity.name)
  }, OLD.${id}::text, 'delete');
      END IF;
      IF TG_OP <> 'DELETE' THEN
        PERFORM localembed.enqueue_task(${revision}, ${
    literal(entity.name)
  }, NEW.${id}::text, 'upsert');
        RETURN NEW;
      END IF;
      RETURN OLD;
    END $capture$;
    DROP TRIGGER IF EXISTS ${quote(`localembed_${captureName}`)} ON ${table(entity.source.table)};
    CREATE TRIGGER ${quote(`localembed_${captureName}`)} AFTER INSERT OR UPDATE OR DELETE
      ON ${table(entity.source.table)} FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  for (const [index, dep] of (entity.dependencies ?? []).entries()) {
    const depFn = table(`localembed.capture_dep_${captureName}_${index}`);
    const targetId = quote(dep.target.id.column);
    const foreign = quote(dep.source_column);
    const fields = [...new Set([dep.target.id.column, ...dep.fields])];
    const values = (record: string) =>
      fields.map((field) => `${record}.${quote(field)}`).join(', ');
    // Fan-out locks task keys in stable source-ID order. No root row locks are taken.
    await tx.unsafe(`CREATE OR REPLACE FUNCTION ${depFn}() RETURNS trigger LANGUAGE plpgsql AS $dep$
      DECLARE affected record;
      BEGIN
        IF TG_OP = 'UPDATE' AND jsonb_build_array(${
      values('OLD')
    }) IS NOT DISTINCT FROM jsonb_build_array(${values('NEW')}) THEN RETURN NEW; END IF;
        FOR affected IN SELECT root.${id}::text AS identifier FROM ${
      table(entity.source.table)
    } root
          WHERE (TG_OP <> 'INSERT' AND root.${foreign} = OLD.${targetId})
             OR (TG_OP <> 'DELETE' AND root.${foreign} = NEW.${targetId})
          ORDER BY root.${id}
        LOOP
          PERFORM localembed.enqueue_task(${revision}, ${
      literal(entity.name)
    }, affected.identifier, 'upsert');
        END LOOP;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $dep$;
      DROP TRIGGER IF EXISTS ${quote(`le_dep_${captureName}_${index}`)} ON ${
      table(dep.target.table)
    };
      CREATE TRIGGER ${
      quote(`le_dep_${captureName}_${index}`)
    } AFTER INSERT OR UPDATE OR DELETE ON ${
      table(dep.target.table)
    } FOR EACH ROW EXECUTE FUNCTION ${depFn}()`);
  }
}

/** Remove only capture objects, retaining destinations/history and shared locking helpers. */
export async function removeCapture(
  tx: postgres.TransactionSql,
  entity: Configuration['entities'][number],
  revision: string | number,
  namespaced: boolean,
  entityIndex: number,
): Promise<void> {
  if (entity.source.detection.mode === 'polling') return;
  const name = namespaced ? `r${revision}_e${entityIndex}` : entity.name;
  await tx.unsafe(
    `DROP TRIGGER IF EXISTS ${quote(`localembed_${name}`)} ON ${table(entity.source.table)};
    DROP FUNCTION IF EXISTS ${table(`localembed.capture_${name}`)}()`,
  );
  for (const [index, dep] of (entity.dependencies ?? []).entries()) {
    await tx.unsafe(
      `DROP TRIGGER IF EXISTS ${quote(`le_dep_${name}_${index}`)} ON ${table(dep.target.table)};
      DROP FUNCTION IF EXISTS ${table(`localembed.capture_dep_${name}_${index}`)}()`,
    );
  }
}
