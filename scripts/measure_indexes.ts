import postgres from 'npm:postgres@3.4.7';
import { applyConfiguration, type Configuration } from '../services/admin/apply.ts';
import { backfill, buildIndexes } from '../services/admin/synchronize.ts';
import reference from '../deployments/localembed.reference.json' with { type: 'json' };

const url = Deno.env.get('TEST_DATABASE_URL');
if (!url) throw new Error('TEST_DATABASE_URL must point at an empty isolated database');
const sql = postgres(url, { max: 1, onnotice: () => {} });
const writer = postgres(url, {
  max: 1,
  connection: { statement_timeout: 1000 },
  onnotice: () => {},
});
try {
  const [existing] =
    await sql`SELECT to_regnamespace('localembed') AS managed, to_regclass('public.articles') AS source`;
  if (existing.managed || existing.source) {
    throw new Error('Refusing an existing installation/fixture');
  }
  await sql.unsafe(
    'CREATE EXTENSION IF NOT EXISTS vector; CREATE TABLE public.articles(id uuid PRIMARY KEY,title text,body text)',
  );
  const config = structuredClone(reference) as Configuration;
  config.providers[0].dimensions = 64;
  await applyConfiguration(url, config, () => Promise.resolve());
  await backfill(url);
  await sql.unsafe(
    `INSERT INTO localembed.article_embeddings(source_id,embedding,fingerprint,configuration_id)
    SELECT md5(n::text)::uuid, ARRAY(SELECT sin(n*i::float8) FROM generate_series(1,64) i)::vector, 'synthetic',1 FROM generate_series(1,10000) n`,
  );
  const versions =
    await sql`SELECT version() AS postgres, extname,extversion FROM pg_extension WHERE extname IN ('vector','pg_search')`;
  const runs = [];
  for (const online of [false, true]) {
    await sql.unsafe('DROP INDEX IF EXISTS localembed.article_embeddings_hnsw');
    const started = performance.now();
    let done = false;
    const building = buildIndexes(url, online).then(() => {
      done = true;
    }, (error) => {
      done = true;
      throw error;
    });
    // Wait until the backend reports actual CREATE INDEX activity.
    let seen = false;
    while (!done && !seen) {
      seen =
        (await sql`SELECT 1 FROM pg_stat_progress_create_index WHERE relid='localembed.article_embeddings'::regclass`)
          .length > 0;
      if (!seen) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const writeStarted = performance.now();
    let write = 'not observed', completedDuringBuild = false;
    if (seen) {
      try {
        await writer`INSERT INTO localembed.article_embeddings(source_id,embedding,fingerprint,configuration_id)
          VALUES (${crypto.randomUUID()}, ${
          JSON.stringify(Array.from({ length: 64 }, (_, i) => i === 0 ? 1 : 0))
        }::vector,'write-probe',1)`;
        write = 'committed';
        completedDuringBuild =
          (await sql`SELECT 1 FROM pg_stat_progress_create_index WHERE relid='localembed.article_embeddings'::regclass`)
            .length > 0;
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === '57014')) {
          throw error;
        }
        write = 'statement_timeout';
      }
    }
    const writeDuration = performance.now() - writeStarted;
    await building;
    const [size] =
      await sql`SELECT pg_relation_size('localembed.article_embeddings_hnsw')::text AS bytes`;
    runs.push({
      online,
      observed_create: seen,
      duration_ms: performance.now() - started,
      write,
      write_duration_ms: writeDuration,
      write_completed_during_build: completedDuringBuild,
      index_bytes: size.bytes,
    });
  }
  const report = {
    workload: {
      rows: 10000,
      dimensions: 64,
      m: 16,
      ef_construction: 64,
      provider: 'not called; synthetic vectors',
      samples_per_mode: 1,
      write_timeout_ms: 1000,
      cpu_memory_io_measured: false,
    },
    versions,
    runs,
    limitations:
      'Sequential warm-host runs, synthetic vectors, one sample each; not throughput, TEI or production sizing. Write timeout probes relation lock behavior.',
  };
  const output = Deno.args[0] ?? 'docs/evaluation/indexes.json';
  await Deno.writeTextFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await writer.end();
  await sql.end();
}
