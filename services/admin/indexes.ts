import postgres from 'postgres';
import type { Configuration } from './apply.ts';
import { quote, table } from '../worker/content.ts';

const ADMIN_LOCK = 78129412;
type Entity = Configuration['entities'][number];
type Provider = Configuration['providers'][number];
function definition(entity: Entity, provider: Provider) {
  return {
    op: { cosine: 'vector_cosine_ops', dot_product: 'vector_ip_ops', l2: 'vector_l2_ops' }[
      provider.metric
    ],
    m: entity.destination.hnsw?.m ?? 16,
    ef: entity.destination.hnsw?.ef_construction ?? 64,
  };
}
/** Inspect the named relation, not merely an index with a compatible access method. */
async function inspect(
  sql: postgres.Sql | postgres.TransactionSql,
  destination: string,
  name: string,
) {
  const [row] = await sql`SELECT c.relkind, i.indisvalid, i.indisready, i.indislive,
    i.indisunique, i.indnatts, i.indnkeyatts, i.indexprs IS NULL AS plain,
    i.indpred IS NULL AS unfiltered, i.indrelid = to_regclass(${table(destination)}) AS target,
    am.amname, op.opcname, a.attname, c.reloptions
    FROM pg_class c LEFT JOIN pg_index i ON i.indexrelid = c.oid
    LEFT JOIN pg_am am ON am.oid = c.relam
    LEFT JOIN pg_opclass op ON op.oid = i.indclass[0]
    LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
    WHERE c.oid = to_regclass(${table(destination.split('.')[0] + '.' + name)})`;
  return row;
}
function matches(
  row: Awaited<ReturnType<typeof inspect>>,
  expected: ReturnType<typeof definition>,
) {
  if (!row) return false;
  const options = new Map<string, string>(
    (row.reloptions ?? []).map((value: string) => value.split('=')),
  );
  return row.relkind === 'i' && row.target && row.amname === 'hnsw' &&
    row.opcname === expected.op && row.attname === 'embedding' &&
    row.indnatts === 1 && row.indnkeyatts === 1 && !row.indisunique &&
    row.plain && row.unfiltered &&
    Number(options.get('m') ?? 16) === expected.m &&
    Number(options.get('ef_construction') ?? 64) === expected.ef &&
    [...options.keys()].every((key) => ['m', 'ef_construction'].includes(key));
}
/** Shared activation validation, including parameters and absence of predicates/expressions. */
export async function validManagedIndex(
  sql: postgres.Sql | postgres.TransactionSql,
  entity: Entity,
  provider: Provider,
): Promise<boolean> {
  const [identifier] = await sql`SELECT ${
    entity.destination.table.split('.')[1] + '_hnsw'
  }::name AS name`;
  const row = await inspect(sql, entity.destination.table, identifier.name);
  return Boolean(
    matches(row, definition(entity, provider)) && row?.indisvalid && row.indisready &&
      row.indislive,
  );
}
/** Administrative only. A reserved session owns all autocommit DDL and its advisory lock. */
export async function buildIndexes(url: string, online = false): Promise<void> {
  let sessionLost = false;
  const assertSession = () => {
    if (sessionLost) throw new Error('Administrative session lost; rerun the command');
  };
  const pool = postgres(url, {
    max: 1,
    onclose: () => {
      sessionLost = true;
    },
    connection: { application_name: 'localembed-index-admin' },
  });
  const sql = await pool.reserve().catch(async (error) => {
    await pool.end();
    throw error;
  });
  let owned = false;
  try {
    const [lock] = await sql`SELECT pg_try_advisory_lock(${ADMIN_LOCK}) AS owned`;
    owned = lock.owned;
    if (!owned) throw new Error('Another administrator is active');
    const revisions = await sql`SELECT c.id, c.configuration, v.entity
      FROM localembed.configurations c JOIN localembed.entity_revisions v ON v.configuration_id = c.id
      WHERE v.state IN ('active','staging') ORDER BY c.id,v.entity`;
    for (const revision of revisions) {
      const config = revision.configuration as Configuration;
      const entity = config.entities.find((e) => e.name === revision.entity)!;
      const provider = config.providers.find((p) => p.name === entity.provider)!;
      const expected = definition(entity, provider);
      const [state] = await sql`SELECT complete FROM localembed.backfills
        WHERE configuration_id = ${revision.id} AND entity = ${entity.name}`;
      if (!state?.complete) {
        throw new Error(`${entity.name}: backfill must finish before HNSW creation`);
      }
      // PostgreSQL name truncation is explicit, so lookup and DDL refer to the same object.
      const [identifier] = await sql`SELECT ${
        entity.destination.table.split('.')[1] + '_hnsw'
      }::name AS name`;
      const name = identifier.name as string;
      let index = await inspect(sql, entity.destination.table, name);
      if (index && !matches(index, expected)) {
        throw new Error(
          `${entity.name}: managed index name has a conflicting definition; inspect it manually`,
        );
      }
      if (!(index?.indisvalid && index?.indisready && index?.indislive)) {
        await sql`UPDATE localembed.backfills SET indexed = false
          WHERE configuration_id = ${revision.id} AND entity = ${entity.name}`;
        if (!online) {
          const pending =
            await sql`SELECT 1 FROM localembed.tasks WHERE configuration_id = ${revision.id}
            AND entity = ${entity.name} AND status <> 'done' LIMIT 1`;
          if (pending.length) {
            throw new Error(`${entity.name}: process all queued tasks before HNSW creation`);
          }
        }
        await sql`INSERT INTO localembed.admin_actions(action,details) VALUES ('index_build_started', ${
          sql.json({
            revision: revision.id,
            entity: entity.name,
            online,
            recovered: Boolean(index),
          })
        })`;
        if (index) {
          assertSession();
          await sql.unsafe(
            `DROP INDEX ${online ? 'CONCURRENTLY ' : ''}${
              table(entity.destination.table.split('.')[0] + '.' + name)
            }`,
          );
        }
        assertSession();
        const started = performance.now();
        await sql.unsafe(
          `CREATE INDEX ${online ? 'CONCURRENTLY ' : ''}${quote(name)} ON ${
            table(entity.destination.table)
          } USING hnsw (embedding ${expected.op}) WITH (m = ${expected.m}, ef_construction = ${expected.ef})`,
        );
        index = await inspect(sql, entity.destination.table, name);
        if (
          !matches(index, expected) || !index?.indisvalid || !index.indisready || !index.indislive
        ) {
          throw new Error(
            `${entity.name}: index did not finish with the expected valid definition`,
          );
        }
        await sql`INSERT INTO localembed.admin_actions(action,details) VALUES ('index_build_finished', ${
          sql.json({
            revision: revision.id,
            entity: entity.name,
            online,
            duration_ms: performance.now() - started,
          })
        })`;
      }
      assertSession();
      // Repair metadata after a crash between committed CREATE INDEX and this update.
      await sql`UPDATE localembed.backfills SET indexed = true WHERE configuration_id = ${revision.id} AND entity = ${entity.name}`;
      console.log(JSON.stringify({ event: 'hnsw_ready', entity: entity.name, online }));
    }
  } finally {
    // Closing the physical session releases ownership even after a FATAL disconnect.
    // Do not enqueue an unlock query on a broken reserved connection.
    sql.release();
    await pool.end({ timeout: 1 });
  }
}
