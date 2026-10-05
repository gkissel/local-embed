import postgres from 'npm:postgres@3.4.7';
import { applyConfiguration, type Configuration } from '../services/admin/apply.ts';
import { cleanup, configureRetention } from '../services/admin/retention.ts';
import reference from '../deployments/localembed.reference.json' with { type: 'json' };

const url = Deno.env.get('TEST_DATABASE_URL');
if (!url) throw new Error('TEST_DATABASE_URL is required (empty evaluation database only)');
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const [exists] =
    await sql`SELECT to_regnamespace('localembed') AS schema, to_regclass('public.retention_probe') AS source`;
  if (exists.schema || exists.source) {
    throw new Error('Refusing to overwrite existing evaluation objects');
  }
  await sql.unsafe(
    'CREATE TABLE public.retention_probe(id uuid PRIMARY KEY, title text, body text)',
  );
  const config = structuredClone(reference) as Configuration;
  config.entities[0].source.table = 'public.retention_probe';
  config.providers[0].dimensions = 3;
  await applyConfiguration(url, config, () => Promise.resolve());
  await sql.unsafe(`INSERT INTO localembed.tasks(configuration_id, entity, source_id, operation,
    status, processed_generation, completed_at)
    SELECT 1, 'article', n::text, 'upsert', 'done', 1,
      clock_timestamp() - CASE WHEN n <= 200 THEN interval '2 hours' ELSE interval '1 second' END
    FROM generate_series(1, 10000) n; ANALYZE localembed.tasks`);
  const cutoff = new Date(Date.now() - 3600000);
  const query = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM localembed.tasks
    WHERE status = 'done' AND processed_generation = generation
      AND completed_at < $1::timestamptz
      AND lease_token IS NULL AND lease_until IS NULL AND execution_deadline IS NULL
    ORDER BY completed_at,id LIMIT 100 FOR UPDATE SKIP LOCKED`;
  const indexed = (await sql.unsafe(query, [cutoff]))[0]['QUERY PLAN'];
  await sql.unsafe('DROP INDEX localembed.tasks_retention');
  const unindexed = (await sql.unsafe(query, [cutoff]))[0]['QUERY PLAN'];
  await sql.unsafe(
    "CREATE INDEX tasks_retention ON localembed.tasks(completed_at,id) WHERE status='done' AND processed_generation=generation",
  );
  await configureRetention(url, { completed_seconds: 3600, batch_size: 100 });
  const preview = await cleanup(url);
  const applied = await cleanup(url, false);
  const [totals] = await sql`SELECT * FROM localembed.cleanup_totals`;
  const versions =
    await sql`SELECT current_setting('server_version') AS postgres, extname, extversion FROM pg_extension WHERE extname IN ('vector','pg_search')`;
  const report = JSON.stringify(
    {
      workload: {
        rows: 10000,
        eligible: 200,
        batch: 100,
        provider: 'not called; SQL task-state fixtures',
        sampled_plans: 1,
        throughput_benchmark: false,
      },
      versions,
      indexed,
      unindexed,
      preview,
      applied,
      totals,
    },
    null,
    2,
  );
  const output = Deno.args[0] ?? 'docs/evaluation/retention.json';
  await Deno.writeTextFile(output, report + '\n');
  console.log(JSON.stringify({ event: 'retention_measurement_written', output }));
} finally {
  // Data remains for inspection; use a dedicated disposable database.
  await sql.end();
}
