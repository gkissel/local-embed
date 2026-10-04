import postgres from 'npm:postgres@3.4.7';
import { assertEquals } from '@std/assert';
import { demoConfiguration, setup } from '../examples/hybrid-search/setup.ts';
import {
  active,
  type Generation,
  lexicalSQL,
  parameters,
  rank,
  vectorSQL,
} from '../examples/hybrid-search/search.ts';
import { createComparison, VARIANT } from '../examples/hybrid-search/comparison.ts';
import { backfill, buildIndexes } from '../services/admin/synchronize.ts';
import { readContent, table } from '../services/worker/content.ts';
import { type Generate, Worker } from '../services/worker/worker.ts';

const url = Deno.env.get('TEST_DATABASE_URL');
if (!url) throw new Error('TEST_DATABASE_URL must be an empty disposable ParadeDB database');
const count = Number(Deno.env.get('DEMO_COMPARISON_ROWS') ?? 512);
if (!Number.isInteger(count) || count < 8 || count > 10000) {
  throw new Error('Rows must be 8..10000');
}
const reportPath = Deno.args[0];
if (!reportPath) throw new Error('Pass a JSON report output path');
const sql = postgres(url, { max: 1, onnotice: () => {} });
const options = parameters();
// Deliberately synthetic, deterministic dense three-dimensional vectors; no quality claims.
function fixtureVector(text: string): number[] {
  let hash = 2166136261;
  for (const character of text) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  const values = [0, 1, 2].map(() => {
    hash = (Math.imul(hash, 1664525) + 1013904223) >>> 0;
    return (hash / 4294967296) * 2 - 1;
  });
  const norm = Math.hypot(...values);
  return values.map((value) => value / norm);
}
const inference: Generate = (_provider, text) => Promise.resolve(fixtureVector(text));
const vector = fixtureVector('query: keyboard');
const summarize = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50_ms: sorted[Math.floor(sorted.length * 0.5)],
    p95_ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
  };
};
async function explain(
  tx: postgres.TransactionSql,
  query: string,
  values: postgres.ParameterOrJSON<never>[],
) {
  const [row] = await tx.unsafe('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + query, values);
  return row['QUERY PLAN'][0];
}
async function contention(
  generation: Generation,
  kind: 'managed-storage-only' | 'managed-worker-lock' | 'same-table',
) {
  const holder = postgres(url!, { max: 1, onnotice: () => {} });
  const writer = postgres(url!, { max: 1, onnotice: () => {} });
  let release!: () => void;
  let ready!: () => void;
  const releasePromise = new Promise<void>((resolve) => release = resolve);
  const readyPromise = new Promise<void>((resolve) => ready = resolve);
  let hold: Promise<unknown> | undefined;
  let write: Promise<unknown> | undefined;
  let writerFinished = false;
  const rollback = new Error('rollback comparison write');
  try {
    const [holderPid] = await holder`SELECT pg_backend_pid() AS pid`;
    const [writerPid] = await writer`SELECT pg_backend_pid() AS pid`;
    const same = kind === 'same-table';
    hold = holder.begin(async (tx) => {
      if (kind === 'managed-worker-lock') await readContent(tx, generation.entity, '1', true);
      await tx.unsafe(
        `UPDATE ${
          table(same ? VARIANT : generation.entity.destination.table)
        } SET embedding = '[0.7,0.2,0.1]'::vector WHERE ${same ? 'id' : 'source_id'} = 1`,
      );
      ready();
      await releasePromise;
      throw rollback;
    }).catch((error) => {
      if (error !== rollback) throw error;
    });
    await Promise.race([readyPromise, hold]);
    const started = performance.now();
    write = writer.begin(async (tx) => {
      await tx.unsafe(
        `UPDATE ${
          table(same ? VARIANT : 'hybrid_demo.articles')
        } SET title = title || ' comparison probe' WHERE id = 1`,
      );
      throw rollback;
    }).catch((error) => {
      if (error !== rollback) throw error;
    }).finally(() => {
      writerFinished = true;
    });
    let blocked = false;
    const limit = Date.now() + 2000;
    while (!writerFinished && Date.now() < limit) {
      const [state] =
        await sql`SELECT ${holderPid.pid} = ANY(pg_blocking_pids(${writerPid.pid})) AS blocked`;
      if (state.blocked) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!blocked && !writerFinished) throw new Error('Contention probe timed out');
    const observedAfterMs = performance.now() - started;
    release();
    await Promise.all([hold, write]);
    assertEquals(blocked, kind !== 'managed-storage-only');
    return {
      protocol: kind,
      source_writer_blocked: blocked,
      observed_after_ms: observedAfterMs,
      note:
        'Single structural lock probe, rolled back. Observation time is not a workload latency benchmark.',
    };
  } finally {
    release?.();
    await Promise.allSettled([hold, write].filter(Boolean));
    await holder.end();
    await writer.end();
  }
}
let created = false;
try {
  const [existing] = await sql`SELECT to_regnamespace('localembed') AS installation,
    to_regnamespace('hybrid_demo') AS source, to_regnamespace('hybrid_compare') AS comparison`;
  if (existing.installation || existing.source || existing.comparison) {
    throw new Error('Comparison requires an empty disposable database');
  }
  const config = demoConfiguration(3);
  config.providers[0].model = 'deterministic-fixture-v1';
  // setup rejects/refrains from overwriting consumer data.
  await setup(url, config, true);
  created = true;
  await sql`INSERT INTO hybrid_demo.articles(id, tenant_id, published, title, body)
    SELECT i, CASE WHEN i % 5 = 0 THEN 'beta' ELSE 'alpha' END, i % 11 <> 0,
      CASE WHEN i % 4 = 0 THEN 'Keyboard synthetic ' ELSE 'Device synthetic ' END || i,
      'Reproducible fixture article ' || i || ' about input devices and search'
    FROM generate_series(9, ${count}) i`;
  await backfill(url);
  const worker = new Worker(url, inference);
  try {
    while (await worker.tick()) { /* drain bounded fixture */ }
  } finally {
    await worker.close();
  }
  await buildIndexes(url);
  // Equalize BM25 build history: build both source indexes over the complete loaded corpus.
  await sql.unsafe(`DROP INDEX hybrid_demo.articles_bm25;
    CREATE INDEX articles_bm25 ON hybrid_demo.articles USING bm25(id, tenant_id, published, title, body) WITH (key_field='id')`);
  const generation = await sql.begin(async (tx) => {
    const current = await active(tx);
    await createComparison(tx, current);
    return current;
  });
  await sql.unsafe(
    `ANALYZE hybrid_demo.articles; ANALYZE ${table(generation.entity.destination.table)}`,
  );
  const plans = await sql.begin(async (tx) => ({
    lexical_separate: await explain(tx, lexicalSQL(), [
      'alpha',
      'keyboard',
      options.candidateLimit,
    ]),
    lexical_same: await explain(tx, lexicalSQL(VARIANT), [
      'alpha',
      'keyboard',
      options.candidateLimit,
    ]),
    vector_exact_separate: await explain(tx, vectorSQL(generation, 'exact'), [
      JSON.stringify(vector),
      'alpha',
      generation.revision,
      options.candidateLimit * 4,
    ]),
    vector_exact_same: await explain(tx, vectorSQL(generation, 'exact', VARIANT), [
      JSON.stringify(vector),
      'alpha',
      generation.revision,
      options.candidateLimit * 4,
    ]),
  }));
  const exact: Record<string, number[]> = { separate: [], same: [] };
  let sampleResults: unknown;
  for (let i = 0; i < 35; i++) {
    const observed: unknown[] = [];
    // Alternate layout order to reduce systematic cache/order bias.
    for (const layout of i % 2 ? ['same', 'separate'] : ['separate', 'same']) {
      const start = performance.now();
      const result = await sql.begin(
        'isolation level repeatable read read only',
        (tx) =>
          rank(
            tx,
            generation,
            vector,
            'keyboard',
            'alpha',
            options,
            layout === 'same' ? VARIANT : undefined,
          ),
      );
      if (i >= 5) exact[layout].push(performance.now() - start);
      observed.push(result);
      sampleResults = result;
    }
    assertEquals(observed[0], observed[1]);
  }
  const ann = await sql.begin(async (tx) => {
    await tx`SET LOCAL enable_seqscan = off`;
    await tx`SET LOCAL hnsw.iterative_scan = 'strict_order'`;
    await tx`SET LOCAL hnsw.ef_search = 100`;
    return {
      diagnostic_only:
        'Index eligibility plans with enable_seqscan=off; not production tuning or latency proof.',
      separate: await explain(tx, vectorSQL(generation, 'hnsw'), [
        JSON.stringify(vector),
        'alpha',
        generation.revision,
        options.candidateLimit * 4,
      ]),
      same: await explain(tx, vectorSQL(generation, 'hnsw', VARIANT), [
        JSON.stringify(vector),
        'alpha',
        generation.revision,
        options.candidateLimit * 4,
      ]),
    };
  });
  const lockProbes = [];
  for (const kind of ['managed-storage-only', 'managed-worker-lock', 'same-table'] as const) {
    lockProbes.push(await contention(generation, kind));
  }
  const rollback = new Error('rollback experiment');
  let triggerGuard: unknown;
  await sql.begin(async (tx) => {
    await tx.unsafe(`CREATE TABLE hybrid_compare.capture_probe(count integer NOT NULL);
      INSERT INTO hybrid_compare.capture_probe VALUES(0);
      CREATE FUNCTION hybrid_compare.capture_probe() RETURNS trigger LANGUAGE plpgsql AS $probe$
      BEGIN
        IF OLD.title IS NOT DISTINCT FROM NEW.title AND OLD.body IS NOT DISTINCT FROM NEW.body THEN RETURN NEW; END IF;
        UPDATE hybrid_compare.capture_probe SET count = count + 1;
        RETURN NEW;
      END $probe$;
      CREATE TRIGGER content_capture AFTER UPDATE ON hybrid_compare.articles FOR EACH ROW EXECUTE FUNCTION hybrid_compare.capture_probe();
      UPDATE hybrid_compare.articles SET embedding = '[0.7,0.2,0.1]'::vector WHERE id=1`);
    const [vectorUpdate] = await tx`SELECT count FROM hybrid_compare.capture_probe`;
    await tx`UPDATE hybrid_compare.articles SET title = title || ' guard probe' WHERE id=1`;
    const [contentUpdate] = await tx`SELECT count FROM hybrid_compare.capture_probe`;
    assertEquals(vectorUpdate.count, 0);
    assertEquals(contentUpdate.count, 1);
    triggerGuard = {
      vector_update_invalidations: vectorUpdate.count,
      content_update_invalidations: contentUpdate.count,
      note:
        'Guarded comparison-only trigger; unconditional capture could loop on worker vector writes. Not a same-table synchronization implementation.',
    };
    throw rollback;
  }).catch((error) => {
    if (error !== rollback) throw error;
  });
  const migrations: unknown[] = [];
  for (const layout of ['separate', 'same']) {
    await sql.begin(async (tx) => {
      const start = performance.now();
      if (layout === 'same') {
        await tx.unsafe(
          `ALTER TABLE hybrid_compare.articles ALTER COLUMN embedding TYPE vector(4) USING NULL::vector(4)`,
        );
      } else {
        await tx.unsafe(
          `CREATE TABLE hybrid_compare.replacement(source_id bigint PRIMARY KEY, embedding vector(4));
          CREATE INDEX replacement_hnsw ON hybrid_compare.replacement USING hnsw(embedding vector_cosine_ops) WITH (m=16, ef_construction=64)`,
        );
      }
      const elapsed = performance.now() - start;
      const [locks] = await tx`SELECT count(*)::int AS source_access_exclusive FROM pg_locks
        WHERE pid=pg_backend_pid() AND relation='hybrid_compare.articles'::regclass AND mode='AccessExclusiveLock'`;
      migrations.push({
        layout,
        ddl_ms: elapsed,
        source_access_exclusive: locks.source_access_exclusive > 0,
        note:
          'DDL-only rolled-back dimensional migration; new destination starts empty, same-table discards experimental vectors and rebuilds indexes. Backfill/inference/activation excluded.',
      });
      throw rollback;
    }).catch((error) => {
      if (error !== rollback) throw error;
    });
  }
  const [environment] =
    await sql`SELECT version() AS postgres, current_setting('server_version') AS server_version,
    (SELECT extversion FROM pg_extension WHERE extname='vector') AS vector,
    (SELECT extversion FROM pg_extension WHERE extname='pg_search') AS pg_search`;
  const host: Record<string, string | number> = {
    arch: Deno.build.arch,
    database_limits: Deno.env.get('DEMO_DATABASE_LIMITS') ??
      'not supplied; record launcher CPU/memory limits separately',
  };
  try {
    const [cpu, memory] = await Promise.all([
      Deno.readTextFile('/proc/cpuinfo'),
      Deno.readTextFile('/proc/meminfo'),
    ]);
    host.cpu_model = cpu.match(/^model name\s*:\s*(.+)$/m)?.[1] ?? 'unknown';
    host.logical_cpus = [...cpu.matchAll(/^processor\s*:/gm)].length;
    host.memory_total_kib = Number(memory.match(/^MemTotal:\s*(\d+)/m)?.[1]);
  } catch {
    host.note = 'Linux CPU/memory context unavailable';
  }
  const report = {
    captured_at: new Date().toISOString(),
    environment: {
      ...environment,
      deno: Deno.version.deno,
      host,
      database_image:
        'paradedb/paradedb:0.22.6-pg18@sha256:2359a3628682f2dfc4ee65ed59f6a993d7851ed3d820b0c030c397ff7168b620',
    },
    dataset: {
      rows: count,
      dimensions: 3,
      inference: 'deterministic-fixture-v1; simulated, not E5/TEI',
      seed: 2166136261,
      query: 'keyboard',
      tenant: 'alpha',
      filters: 'tenant_id + published=true',
    },
    parameters: options,
    methodology:
      'Both BM25 indexes built over the fully populated corpus. 5 warmups, 30 paired samples, alternating order; API/inference excluded. Read-only repeatable-read transactions include candidate retrieval, bounded fingerprint validation and RRF. No concurrent workload in query timing.',
    latency: { separate: summarize(exact.separate), same: summarize(exact.same) },
    plans,
    ann,
    trigger_guard: triggerGuard,
    dimensional_migration: migrations,
    source_write_contention: lockProbes,
    exact_results_equal: true,
    sample: sampleResults,
    limitations: [
      'Small synthetic 3D fixture, warmed local caches, no semantic-quality/real-model inference benchmark.',
      'Source eligibility EXISTS may become a semi-join before top-k; plans are recorded, rather than promising join-free retrieval.',
      'ANN diagnostic plans are separate from exact latency/parity; approximate candidate membership can differ.',
      'Both actual worker-style final source locking and same-table vector updates can block source writers.',
      'Same-table variant is a throwaway copied snapshot without production synchronization or migration support; ADR-0007 remains unchanged.',
    ],
  };
  await Deno.writeTextFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({ report: reportPath, latency: report.latency, exact_results_equal: true }),
  );
} finally {
  if (created) {
    await sql.unsafe(
      'DROP SCHEMA hybrid_compare CASCADE; DROP SCHEMA localembed CASCADE; DROP SCHEMA hybrid_demo CASCADE',
    );
  }
  await sql.end();
}
