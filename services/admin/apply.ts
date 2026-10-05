import { installRetention } from './retention.ts';
import { installCapture, installTaskQueue } from './task_queue.ts';
import { installRevisions } from './revisions.ts';
import { installPollingState } from './polling_state.ts';
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
export type Dependency = {
  name: string;
  relation: 'one' | 'many';
  fields: string[];
  source_column: string;
  target: { table: string; id: { column: string; type: string } };
};
type Entity = {
  name: string;
  source: {
    table: string;
    id: { column: string; type: string };
    detection: { mode: string; updated_at?: string; overlap_seconds?: number };
  };
  provider: string;
  fields?: string[];
  dependencies?: Dependency[];
  template: string;
  destination: { table: string; hnsw?: { m?: number; ef_construction?: number } };
};
export type Configuration = {
  version: string;
  providers: Provider[];
  entities: Entity[];
  applied_revision?: string;
  operations?: {
    retries?: import('../shared/retry.ts').RetryPolicy;
    backfill?: { batch_size?: number };
    reconciliation?: { interval_seconds?: number };
  };
};
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
    if (
      [
        'localembed.tasks',
        'localembed.configurations',
        'localembed.backfills',
        'localembed.tasks_available',
        'localembed.tasks_key',
        'localembed.tasks_ready',
        'localembed.polling_state',
        'localembed.entity_revisions',
        'localembed.entity_active',
        'localembed.entity_staging',
        'localembed.admin_actions',
        'localembed.enqueue_metrics',
      ].includes(entity.destination.table)
    ) {
      throw new Error(`${entity.name}: reserved destination`);
    }
    if (destinations.has(entity.destination.table)) {
      throw new Error(`Duplicate destination: ${entity.destination.table}`);
    }
    destinations.add(entity.destination.table);
    if (entity.source.table.startsWith('localembed.')) {
      throw new Error(`${entity.name}: source must be outside localembed`);
    }
    const dependencies = new Set<string>();
    for (const dep of entity.dependencies ?? []) {
      if (dep.relation !== 'one') {
        throw new Error(`${entity.name}: only many-to-one dependencies are supported`);
      }
      if (dependencies.has(dep.name)) {
        throw new Error(`${entity.name}: duplicate dependency ${dep.name}`);
      }
      dependencies.add(dep.name);
      if (dep.target.table.startsWith('localembed.') || dep.target.table === entity.source.table) {
        throw new Error(`${entity.name}: dependency must be a distinct consumer table`);
      }
    }
    for (const match of entity.template.matchAll(/\{\{([^}]+)\}\}/g)) {
      const [name, field] = match[1].split('.');
      const declared = field
        ? entity.dependencies?.find((dep) => dep.name === name)?.fields.includes(field)
        : entity.fields?.includes(name);
      if (!declared) throw new Error(`${entity.name}: template field ${match[1]} is not declared`);
    }
    if ((entity.destination.hnsw?.ef_construction ?? 64) < 2 * (entity.destination.hnsw?.m ?? 16)) {
      throw new Error(`${entity.name}: HNSW ef_construction must be at least twice m`);
    }
    for (
      const identifier of [
        entity.name,
        ...entity.source.table.split('.'),
        entity.source.id.column,
        ...(entity.fields ?? []),
        ...(entity.source.detection.updated_at ? [entity.source.detection.updated_at] : []),
        ...(entity.dependencies ?? []).flatMap((
          dep,
        ) => [
          dep.name,
          dep.source_column,
          ...dep.target.table.split('.'),
          dep.target.id.column,
          ...dep.fields,
        ]),
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
  staging = false,
): Promise<string> {
  const config = validateConfiguration(value);
  for (const provider of config.providers) await probe(provider);
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    return await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(78129412)`;
      const [version] = await tx`SHOW server_version_num`;
      if (Number(version.server_version_num) < 180000) {
        throw new Error('PostgreSQL 18 or later is required');
      }
      const extensions = await tx`SELECT 1 FROM pg_extension WHERE extname = 'vector'`;
      if (!extensions.length) {
        throw new Error('Install the vector extension before applying configuration');
      }
      // Lock every consumer relation in a stable order before catalog validation.
      const relations = new Set(
        config.entities.flatMap((
          entity,
        ) => [entity.source.table, ...(entity.dependencies ?? []).map((dep) => dep.target.table)]),
      );
      for (const relation of [...relations].sort()) {
        await tx.unsafe(`LOCK TABLE ${table(relation)} IN SHARE ROW EXCLUSIVE MODE`);
      }
      for (const entity of config.entities) {
        const columns =
          await tx`SELECT a.attname, t.typname, a.attnotnull FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid WHERE a.attrelid = to_regclass(${
            table(entity.source.table)
          }) AND a.attnum > 0 AND NOT a.attisdropped`;
        const id = columns.find((c) => c.attname === entity.source.id.column);
        const expected =
          { uuid: 'uuid', bigint: 'int8', text: 'text', ulid: 'text' }[entity.source.id.type];
        if (!id || id.typname !== expected || !id.attnotnull) {
          throw new Error(
            `${entity.name}: source ID must be a non-null ${entity.source.id.type} column`,
          );
        }
        const unique =
          await tx`SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0] WHERE i.indrelid = to_regclass(${
            table(entity.source.table)
          }) AND i.indisunique AND i.indisvalid AND i.indnkeyatts = 1 AND i.indpred IS NULL AND i.indexprs IS NULL AND a.attname = ${entity.source.id.column}`;
        if (!unique.length) {
          throw new Error(`${entity.name}: source ID needs a single-column unique index`);
        }
        for (const field of entity.fields ?? []) {
          if (!columns.some((c) => c.attname === field)) {
            throw new Error(`${entity.name}: source field ${field} does not exist`);
          }
        }
        if (entity.source.detection.mode === 'polling') {
          const updated = columns.find((column) =>
            column.attname === entity.source.detection.updated_at
          );
          if (!updated || updated.typname !== 'timestamptz' || !updated.attnotnull) {
            throw new Error(`${entity.name}: polling updated_at must be non-null timestamptz`);
          }
        }
        for (const dep of entity.dependencies ?? []) {
          const foreign = columns.find((column) => column.attname === dep.source_column);
          const expected =
            { uuid: 'uuid', bigint: 'int8', text: 'text', ulid: 'text' }[dep.target.id.type];
          const targetColumns =
            await tx`SELECT a.attname, t.typname, a.attnotnull FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid WHERE a.attrelid = to_regclass(${
              table(dep.target.table)
            }) AND a.attnum > 0 AND NOT a.attisdropped`;
          const key = targetColumns.find((column) => column.attname === dep.target.id.column);
          const unique =
            await tx`SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0] WHERE i.indrelid = to_regclass(${
              table(dep.target.table)
            }) AND i.indisunique AND i.indisvalid AND i.indnkeyatts = 1 AND i.indpred IS NULL AND i.indexprs IS NULL AND a.attname = ${dep.target.id.column}`;
          if (
            !foreign || foreign.typname !== expected || !key || key.typname !== expected ||
            !key.attnotnull || !unique.length
          ) {
            throw new Error(
              `${entity.name}: dependency ${dep.name} requires a compatible source column and non-null unique target key`,
            );
          }
          for (const field of dep.fields) {
            if (!targetColumns.some((column) => column.attname === field)) {
              throw new Error(
                `${entity.name}: dependency field ${dep.name}.${field} does not exist`,
              );
            }
          }
        }
        const existing = await tx`SELECT to_regclass(${
          table(entity.destination.table)
        }) AS destination`;
        if (existing[0].destination) {
          throw new Error(
            `${entity.name}: destination already exists; stage a revision with a new destination`,
          );
        }
      }
      await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS localembed;
        CREATE TABLE IF NOT EXISTS localembed.configurations (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, configuration jsonb NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS localembed.backfills (configuration_id bigint NOT NULL REFERENCES localembed.configurations(id), entity text NOT NULL, cursor text, complete boolean NOT NULL DEFAULT false, indexed boolean NOT NULL DEFAULT false, PRIMARY KEY(configuration_id, entity));`);
      await installRevisions(tx);
      for (const entity of config.entities) {
        const [current] =
          await tx`SELECT c.configuration FROM localembed.entity_revisions v JOIN localembed.configurations c ON c.id = v.configuration_id WHERE v.entity = ${entity.name} AND v.state = 'active'`;
        if (current && !staging) {
          throw new Error(`${entity.name}: use stage for an existing entity`);
        }
        if (current) {
          const previous = (current.configuration as Configuration).entities.find((item) =>
            item.name === entity.name
          )!;
          const shape = (item: Entity) =>
            JSON.stringify([
              item.source.table,
              item.source.id.column,
              item.source.id.type,
              (item.dependencies ?? []).map((
                dep,
              ) => [
                dep.name,
                dep.source_column,
                dep.target.table,
                dep.target.id.column,
                dep.target.id.type,
              ]),
            ]);
          if (shape(previous) !== shape(entity)) {
            throw new Error(
              `${entity.name}: changing source/relation identity is not supported; declare a new entity`,
            );
          }
        }
      }
      await installTaskQueue(tx);
      await installRetention(tx);
      await installPollingState(tx);
      const [revision] = await tx`INSERT INTO localembed.configurations (configuration) VALUES (${
        tx.json(config as unknown as postgres.JSONValue)
      }) RETURNING id`;
      for (const entity of config.entities) {
        const provider = config.providers.find((p) => p.name === entity.provider)!;
        const destination = table(entity.destination.table);
        const idType =
          { uuid: 'uuid', bigint: 'bigint', text: 'text', ulid: 'text' }[entity.source.id.type];
        await tx.unsafe(
          `CREATE TABLE ${destination} (source_id ${idType} PRIMARY KEY, embedding vector(${provider.dimensions}) NOT NULL, fingerprint text NOT NULL, configuration_id bigint NOT NULL REFERENCES localembed.configurations(id), updated_at timestamptz NOT NULL DEFAULT now())`,
        );
        await tx`INSERT INTO localembed.entity_revisions(configuration_id, entity, state, capture_namespace) VALUES (${revision.id}, ${entity.name}, ${
          staging ? 'staging' : 'active'
        }, ${staging})`;
        await installCapture(tx, entity, revision.id, staging, config.entities.indexOf(entity));
      }
      await tx`INSERT INTO localembed.admin_actions(action, details) VALUES (${
        staging ? 'stage' : 'apply'
      }, ${tx.json({ revision: revision.id })})`;
      return String(revision.id);
    });
  } finally {
    await sql.end();
  }
}
