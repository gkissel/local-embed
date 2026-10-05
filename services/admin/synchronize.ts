import { installRetention } from './retention.ts';
import { installCapture, installTaskQueue } from './task_queue.ts';
import postgres from 'postgres';
import { installPollingState } from './polling_state.ts';
import { installRevisions } from './revisions.ts';
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
      await installRevisions(tx);
      const revisions =
        await tx`SELECT id, configuration FROM localembed.configurations c WHERE EXISTS (SELECT 1 FROM localembed.entity_revisions v WHERE v.configuration_id = c.id AND v.state IN ('active','staging')) ORDER BY id`;
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
      await installRetention(tx);
      await installPollingState(tx);
      for (const revision of revisions) {
        for (const entity of (revision.configuration as Configuration).entities) {
          const [state] =
            await tx`SELECT state, capture_namespace FROM localembed.entity_revisions WHERE configuration_id = ${revision.id} AND entity = ${entity.name}`;
          if (state?.state !== 'retired') {
            await installCapture(
              tx,
              entity,
              revision.id,
              state?.capture_namespace,
              (revision.configuration as Configuration).entities.indexOf(entity),
            );
          }
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
      await sql`SELECT id, configuration FROM localembed.configurations c WHERE EXISTS (SELECT 1 FROM localembed.entity_revisions v WHERE v.configuration_id = c.id AND v.state IN ('active','staging')) ORDER BY id`;
    for (const revision of revisions) {
      const config = revision.configuration as Configuration & {
        operations?: { backfill?: { batch_size?: number } };
      };
      for (const entity of config.entities) {
        const eligible =
          await sql`SELECT 1 FROM localembed.entity_revisions WHERE configuration_id = ${revision.id} AND entity = ${entity.name} AND state IN ('active','staging')`;
        if (!eligible.length) continue;
        await sql`INSERT INTO localembed.backfills (configuration_id, entity) VALUES (${revision.id}, ${entity.name}) ON CONFLICT DO NOTHING`;
        let finished = false;
        while (!finished) {
          await sql.begin(async (tx) => {
            const eligible =
              await tx`SELECT 1 FROM localembed.entity_revisions WHERE configuration_id = ${revision.id} AND entity = ${entity.name} AND state IN ('active','staging') FOR SHARE`;
            if (!eligible.length) {
              finished = true;
              return;
            }
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
              await tx`SELECT localembed.enqueue_task(${revision.id}, ${entity.name}, ${row.id}, 'upsert', 'backfill')`;
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
export { buildIndexes } from './indexes.ts';
