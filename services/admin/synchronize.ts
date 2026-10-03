import { installCapture, installTaskQueue } from './task_queue.ts';
import postgres from 'postgres';
import { installPollingState } from './polling_state.ts';
import type { Configuration } from './apply.ts';

const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
const table = (s: string) => s.split('.').map(quote).join('.');
/** Administrative migration for databases created before worker support. */
export async function prepareWorker(url: string): Promise<void> {
  const sql = postgres(url, { max: 1 });
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(78129412)`;
      await tx.unsafe(
        `UPDATE localembed.configurations SET configuration = (configuration #>> '{}')::jsonb WHERE jsonb_typeof(configuration) = 'string';
        CREATE TABLE IF NOT EXISTS localembed.backfills (configuration_id bigint NOT NULL REFERENCES localembed.configurations(id), entity text NOT NULL, cursor text, complete boolean NOT NULL DEFAULT false, indexed boolean NOT NULL DEFAULT false, PRIMARY KEY(configuration_id, entity));`,
      );
      const revisions =
        await tx`SELECT id, configuration FROM localembed.configurations ORDER BY id`;
      const sources = new Set<string>();
      for (const revision of revisions) {
        for (const entity of (revision.configuration as Configuration).entities) {
          sources.add(entity.source.table);
          for (const dep of entity.dependencies ?? []) sources.add(dep.target.table);
        }
      }
      for (const source of [...sources].sort()) {
        await tx.unsafe(`LOCK TABLE ${table(source)} IN SHARE ROW EXCLUSIVE MODE`);
      }
      await installTaskQueue(tx);
      await installPollingState(tx);
      for (const revision of revisions) {
        for (const entity of (revision.configuration as Configuration).entities) {
          await installCapture(tx, entity, revision.id);
        }
      }
    });
  } finally {
    await sql.end();
  }
}
/** Durable keyset batches share the incremental queue. Safe to resume after interruption. */
export async function backfill(url: string): Promise<void> {
  const sql = postgres(url, { max: 1 });
  try {
    const revisions =
      await sql`SELECT id, configuration FROM localembed.configurations ORDER BY id`;
    for (const revision of revisions) {
      const config = revision.configuration as Configuration & {
        operations?: { backfill?: { batch_size?: number } };
      };
      for (const entity of config.entities) {
        await sql`INSERT INTO localembed.backfills (configuration_id, entity) VALUES (${revision.id}, ${entity.name}) ON CONFLICT DO NOTHING`;
        let finished = false;
        while (!finished) {
          await sql.begin(async (tx) => {
            const [state] =
              await tx`SELECT * FROM localembed.backfills WHERE configuration_id = ${revision.id} AND entity = ${entity.name} FOR UPDATE`;
            if (state.complete) {
              finished = true;
              return;
            }
            const type =
              { uuid: 'uuid', bigint: 'bigint', text: 'text', ulid: 'text' }[entity.source.id.type];
            const key = quote(entity.source.id.column);
            const size = config.operations?.backfill?.batch_size ?? 100;
            const rows = await tx.unsafe(
              `SELECT source.${key}::text AS id FROM ${
                table(entity.source.table)
              } AS source WHERE ($1::${type} IS NULL OR source.${key} > $1::${type}) ORDER BY source.${key} LIMIT $2`,
              [state.cursor, size],
            );
            for (const row of rows) {
              await tx`SELECT localembed.enqueue_task(${revision.id}, ${entity.name}, ${row.id}, 'upsert')`;
            }
            finished = rows.length < size;
            await tx`UPDATE localembed.backfills SET cursor = ${
              rows.at(-1)?.id ?? state.cursor
            }, complete = ${finished} WHERE configuration_id = ${revision.id} AND entity = ${entity.name}`;
            console.log(
              JSON.stringify({
                event: 'backfill_batch',
                entity: entity.name,
                enqueued: rows.length,
                complete: finished,
              }),
            );
          });
        }
      }
    }
  } finally {
    await sql.end();
  }
}
/** Build HNSW after the initial queue drains; DDL is kept out of worker startup. */
export async function buildIndexes(url: string): Promise<void> {
  const sql = postgres(url, { max: 1 });
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(78129412)`;
      const revisions =
        await tx`SELECT id, configuration FROM localembed.configurations ORDER BY id`;
      for (const revision of revisions) {
        const config = revision.configuration as Configuration;
        for (const entity of config.entities) {
          const [state] =
            await tx`SELECT * FROM localembed.backfills WHERE configuration_id = ${revision.id} AND entity = ${entity.name} FOR UPDATE`;
          if (!state?.complete) {
            throw new Error(`${entity.name}: backfill must finish before HNSW creation`);
          }
          if (state.indexed) continue;
          const pending =
            await tx`SELECT 1 FROM localembed.tasks WHERE configuration_id = ${revision.id} AND entity = ${entity.name} AND status <> 'done' LIMIT 1`;
          if (pending.length) {
            throw new Error(`${entity.name}: process all queued tasks before HNSW creation`);
          }
          const provider = config.providers.find((p) => p.name === entity.provider)!;
          const op = {
            cosine: 'vector_cosine_ops',
            dot_product: 'vector_ip_ops',
            l2: 'vector_l2_ops',
          }[provider.metric];
          const m = entity.destination.hnsw?.m ?? 16;
          const ef = entity.destination.hnsw?.ef_construction ?? 64;
          await tx.unsafe(
            `CREATE INDEX ${quote(entity.name + '_embedding_hnsw')} ON ${
              table(entity.destination.table)
            } USING hnsw (embedding ${op}) WITH (m = ${m}, ef_construction = ${ef})`,
          );
          await tx`UPDATE localembed.backfills SET indexed = true WHERE configuration_id = ${revision.id} AND entity = ${entity.name}`;
          console.log(JSON.stringify({ event: 'hnsw_created', entity: entity.name }));
        }
      }
    });
  } finally {
    await sql.end();
  }
}
