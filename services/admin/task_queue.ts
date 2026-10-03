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
    RETURNS void LANGUAGE sql AS $enqueue$
      INSERT INTO localembed.tasks(configuration_id, entity, source_id, operation)
      VALUES (revision, entity_name, identifier, change_operation)
      ON CONFLICT(configuration_id, entity, source_id) DO UPDATE SET
        generation = localembed.tasks.generation + 1,
        operation = EXCLUDED.operation, requested_at = clock_timestamp(),
        status = CASE WHEN localembed.tasks.status IN ('processing','failed') THEN localembed.tasks.status ELSE 'pending' END,
        attempts = CASE WHEN localembed.tasks.status IN ('processing','failed') THEN localembed.tasks.attempts ELSE 0 END,
        last_error = CASE WHEN localembed.tasks.status = 'failed' THEN localembed.tasks.last_error ELSE NULL END
    $enqueue$;`,
  );
}

export async function installCapture(
  tx: postgres.TransactionSql,
  entity: Configuration['entities'][number],
  revision: string | number,
): Promise<void> {
  const fn = table(`localembed.capture_${entity.name}`);
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

  const compared = [...new Set([entity.source.id.column, ...(entity.fields ?? [])])];
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
    DROP TRIGGER IF EXISTS ${quote(`localembed_${entity.name}`)} ON ${table(entity.source.table)};
    CREATE TRIGGER ${quote(`localembed_${entity.name}`)} AFTER INSERT OR UPDATE OR DELETE
      ON ${table(entity.source.table)} FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
}
