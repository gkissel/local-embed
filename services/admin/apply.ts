import AjvModule from 'ajv/dist/2020.js';
import formatsModule from 'ajv-formats';
import postgres from 'postgres';
import schema from '../../contracts/schema/localembed.v1.schema.json' with { type: 'json' };

type Provider = {
  name: string;
  type: 'tei' | 'openai';
  endpoint: string;
  model: string;
  dimensions: number;
  metric: 'cosine' | 'dot_product' | 'l2';
  secret_env: string;
};
type Entity = {
  name: string;
  source: { table: string; id: { column: string; type: string }; detection: { mode: string } };
  provider: string;
  fields?: string[];
  dependencies?: unknown[];
  template: string;
  destination: { table: string; hnsw?: { m?: number; ef_construction?: number } };
};
export type Configuration = { version: string; providers: Provider[]; entities: Entity[] };
type Validator = {
  (value: unknown): boolean;
  errors?: { instancePath: string; message?: string }[];
};
type Ajv = { compile(value: unknown): Validator };
const Constructor = AjvModule as unknown as new (options: object) => Ajv;
const ajv = new Constructor({ allErrors: true, strict: true });
(formatsModule as unknown as (value: Ajv) => void)(ajv);
const validate = ajv.compile(schema);

export function validateConfiguration(value: unknown): Configuration {
  if (!validate(value)) {
    throw new Error(
      (validate.errors ?? []).map((e) => `${e.instancePath || '/'}: ${e.message}`).join('\n'),
    );
  }
  const config = value as Configuration;
  const names = new Set<string>();
  for (const provider of config.providers) {
    if (names.has(provider.name)) throw new Error(`Duplicate provider: ${provider.name}`);
    names.add(provider.name);
    if (provider.dimensions > 2000) {
      throw new Error(`${provider.name}: vector HNSW supports at most 2000 dimensions`);
    }
  }
  const entities = new Set<string>();
  const destinations = new Set<string>();
  for (const entity of config.entities) {
    if (entities.has(entity.name)) throw new Error(`Duplicate entity: ${entity.name}`);
    entities.add(entity.name);
    if (!names.has(entity.provider)) {
      throw new Error(`${entity.name}: unknown provider ${entity.provider}`);
    }
    if (!entity.destination.table.startsWith('localembed.')) {
      throw new Error(`${entity.name}: destination must use localembed schema`);
    }
    if (['localembed.tasks', 'localembed.configurations'].includes(entity.destination.table)) {
      throw new Error(`${entity.name}: reserved destination`);
    }
    if (destinations.has(entity.destination.table)) {
      throw new Error(`Duplicate destination: ${entity.destination.table}`);
    }
    destinations.add(entity.destination.table);
    if (entity.source.table.startsWith('localembed.')) {
      throw new Error(`${entity.name}: source must be outside localembed`);
    }
    if (entity.source.detection.mode !== 'trigger' || entity.dependencies?.length) {
      throw new Error(
        `${entity.name}: only trigger mode without dependencies is supported by this command`,
      );
    }
    for (const match of entity.template.matchAll(/\{\{([^}]+)\}\}/g)) {
      if (!entity.fields?.includes(match[1])) {
        throw new Error(`${entity.name}: template field ${match[1]} is not declared`);
      }
    }
    for (
      const identifier of [
        entity.name,
        ...entity.source.table.split('.'),
        entity.source.id.column,
        ...(entity.fields ?? []),
        ...entity.destination.table.split('.'),
      ]
    ) {
      if (identifier.length > 48) {
        throw new Error(`${entity.name}: identifiers must be at most 48 characters`);
      }
    }
  }
  return config;
}
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const table = (value: string) => value.split('.').map(quote).join('.');

export async function preflight(provider: Provider): Promise<void> {
  const secret = Deno.env.get(provider.secret_env);
  if (!secret) {
    throw new Error(`${provider.name}: missing environment variable ${provider.secret_env}`);
  }
  const url = new URL(provider.endpoint);
  url.pathname = url.pathname.replace(/\/$/, '') +
    (provider.type === 'tei' ? '/embed' : '/embeddings');
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify(
      provider.type === 'tei'
        ? { inputs: ['preflight'] }
        : { input: ['preflight'], model: provider.model, dimensions: provider.dimensions },
    ),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${provider.name}: provider preflight returned HTTP ${response.status}`);
  }
  const body = await response.json();
  const vector = provider.type === 'tei' ? body?.[0] : body?.data?.[0]?.embedding;
  if (
    !Array.isArray(vector) || vector.length !== provider.dimensions ||
    !vector.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    throw new Error(
      `${provider.name}: preflight embedding must contain ${provider.dimensions} finite numbers`,
    );
  }
}

/** Validate and provision atomically. No inference runs inside a source transaction. */
export async function applyConfiguration(
  databaseUrl: string,
  value: unknown,
  probe = preflight,
): Promise<void> {
  const config = validateConfiguration(value);
  for (const provider of config.providers) await probe(provider);
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(78129412)`;
      const [version] = await tx`SHOW server_version_num`;
      if (Number(version.server_version_num) < 180000) {
        throw new Error('PostgreSQL 18 or later is required');
      }
      const extensions = await tx`SELECT 1 FROM pg_extension WHERE extname = 'vector'`;
      if (!extensions.length) {
        throw new Error('Install the vector extension before applying configuration');
      }
      // Lock sources before catalog validation so concurrent DDL cannot invalidate it.
      for (const entity of config.entities) {
        await tx.unsafe(`LOCK TABLE ${table(entity.source.table)} IN SHARE ROW EXCLUSIVE MODE`);
        const columns =
          await tx`SELECT a.attname, t.typname, a.attnotnull FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid WHERE a.attrelid = to_regclass(${entity.source.table}) AND a.attnum > 0 AND NOT a.attisdropped`;
        const id = columns.find((c) => c.attname === entity.source.id.column);
        const expected =
          { uuid: 'uuid', bigint: 'int8', text: 'text', ulid: 'text' }[entity.source.id.type];
        if (!id || id.typname !== expected || !id.attnotnull) {
          throw new Error(
            `${entity.name}: source ID must be a non-null ${entity.source.id.type} column`,
          );
        }
        const unique =
          await tx`SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0] WHERE i.indrelid = to_regclass(${entity.source.table}) AND i.indisunique AND i.indisvalid AND i.indnkeyatts = 1 AND i.indpred IS NULL AND i.indexprs IS NULL AND a.attname = ${entity.source.id.column}`;
        if (!unique.length) {
          throw new Error(`${entity.name}: source ID needs a single-column unique index`);
        }
        for (const field of entity.fields ?? []) {
          if (!columns.some((c) => c.attname === field)) {
            throw new Error(`${entity.name}: source field ${field} does not exist`);
          }
        }
        const existing = await tx`SELECT to_regclass(${entity.destination.table}) AS destination`;
        if (existing[0].destination) {
          throw new Error(
            `${entity.name}: destination already exists; configuration updates are not yet supported`,
          );
        }
      }
      await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS localembed;
        CREATE TABLE IF NOT EXISTS localembed.configurations (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, configuration jsonb NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS localembed.tasks (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, configuration_id bigint NOT NULL REFERENCES localembed.configurations(id), entity text NOT NULL, source_id text NOT NULL, operation text NOT NULL CHECK (operation IN ('upsert','delete')), status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now());`);
      const [revision] = await tx`INSERT INTO localembed.configurations (configuration) VALUES (${
        JSON.stringify(config)
      }::jsonb) RETURNING id`;
      for (const entity of config.entities) {
        const provider = config.providers.find((p) => p.name === entity.provider)!;
        const destination = table(entity.destination.table);
        const idType =
          { uuid: 'uuid', bigint: 'bigint', text: 'text', ulid: 'text' }[entity.source.id.type];
        await tx.unsafe(
          `CREATE TABLE ${destination} (source_id ${idType} PRIMARY KEY, embedding vector(${provider.dimensions}) NOT NULL, fingerprint text NOT NULL, configuration_id bigint NOT NULL REFERENCES localembed.configurations(id), updated_at timestamptz NOT NULL DEFAULT now())`,
        );
        const fn = table(`localembed.capture_${entity.name}`);
        // Entity names are schema-validated identifiers; literals are still parameterized via quote escaping.
        const literal = (s: string) => "'" + s.replaceAll("'", "''") + "'";
        await tx.unsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $capture$
          BEGIN
            IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.${
          quote(entity.source.id.column)
        } IS DISTINCT FROM NEW.${quote(entity.source.id.column)}) THEN
              INSERT INTO localembed.tasks(configuration_id, entity, source_id, operation) VALUES (${revision.id}, ${
          literal(entity.name)
        }, OLD.${quote(entity.source.id.column)}::text, 'delete');
            END IF;
            IF TG_OP <> 'DELETE' THEN
              INSERT INTO localembed.tasks(configuration_id, entity, source_id, operation) VALUES (${revision.id}, ${
          literal(entity.name)
        }, NEW.${quote(entity.source.id.column)}::text, 'upsert');
              RETURN NEW;
            END IF;
            RETURN OLD;
          END $capture$;
          CREATE TRIGGER ${
          quote(`localembed_${entity.name}`)
        } AFTER INSERT OR UPDATE OR DELETE ON ${
          table(entity.source.table)
        } FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
      }
    });
  } finally {
    await sql.end();
  }
}
