import { cpuUsage } from 'node:process';
import postgres from 'npm:postgres@3.4.7';
import {
  applyConfiguration,
  type Configuration,
  validateConfiguration,
} from '../../services/admin/apply.ts';
import { backfill, buildIndexes } from '../../services/admin/synchronize.ts';
import { reprocess } from '../../services/admin/revisions.ts';
import { cleanup, configureRetention } from '../../services/admin/retention.ts';
import {
  fingerprint,
  type Generate,
  generate,
  render,
  Worker,
} from '../../services/worker/worker.ts';
import { readContent, table } from '../../services/worker/content.ts';
import { ProcessingError } from '../../services/shared/retry.ts';
import { Poller } from '../../services/poller/poller.ts';
import { ConfigurationStore, createHandler } from '../../services/api/api.ts';
import { SnapshotStore } from '../../services/telemetry/snapshot.ts';
import reference from '../../deployments/localembed.reference.json' with { type: 'json' };
import publicData from '../../docs/evaluation/data/usgs-2020-01.json' with { type: 'json' };
import { summarize } from './statistics.ts';

const url = Deno.env.get('TEST_DATABASE_URL');
const endpoint = Deno.env.get('TEST_TEI_ENDPOINT');
if (!url || !endpoint) {
  throw new Error('An empty isolated TEST_DATABASE_URL and real TEST_TEI_ENDPOINT are required');
}
const count = Number(Deno.env.get('EVALUATION_SYNTHETIC_ROWS') ?? 16);
if (!Number.isInteger(count) || count < 4 || count > 10000) {
  throw new Error('Invalid synthetic row count');
}
const reportPath = Deno.args[0] ?? 'docs/evaluation/artifact.json';
const sql = postgres(url, { max: 1, onnotice: () => {} });
const workers: Worker[] = [];
const poller = new Poller(url, 8);
const store = new ConfigurationStore(url);
const snapshots = new SnapshotStore(url);
let phase = 'warmup';
let peakRss = 0;
const samples = setInterval(() => {
  peakRss = Math.max(peakRss, Deno.memoryUsage().rss);
}, 100);
const started = performance.now();
const startedAt = new Date().toISOString();
const cpuStart = cpuUsage();
const calls: { phase: string; id: string | null; ms: number; outcome: string }[] = [];
let injectedTransient = false, injectedTerminal = false;
let leaseObserved = false;
const inference: Generate = async (provider, text, signal) => {
  const call = { phase, id: /eval-id:(\d+)/.exec(text)?.[1] ?? null, ms: 0, outcome: 'ok' };
  const begin = performance.now();
  calls.push(call);
  try {
    if (phase === 'transient_retry' && !injectedTransient) {
      injectedTransient = true;
      call.outcome = 'injected_transient';
      throw Object.assign(new Error('synthetic fault'), { statusCode: 503 });
    }
    if (phase === 'terminal_failure' && !injectedTerminal) {
      injectedTerminal = true;
      call.outcome = 'injected_terminal';
      throw new ProcessingError('provider_configuration');
    }
    if (phase === 'lease_renewal') {
      await new Promise((r) => setTimeout(r, 400));
      const [lease] =
        await sql`SELECT lease_until>execution_started_at+interval '1.1 seconds' AS renewed FROM localembed.tasks WHERE status='processing' LIMIT 1`;
      leaseObserved ||= Boolean(lease?.renewed);
    }
    return await generate(provider, text, signal);
  } catch (error) {
    if (call.outcome === 'ok') call.outcome = 'provider_error';
    throw error;
  } finally {
    call.ms = performance.now() - begin;
  }
};
const scenarios: Record<string, unknown>[] = [];
async function drain(allowFailed = false) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await Promise.all(workers.map((worker) => worker.tick()));
    const [state] =
      await sql`SELECT count(*) FILTER(WHERE status IN ('pending','processing'))::int AS outstanding,
      count(*) FILTER(WHERE status='failed')::int AS failed FROM localembed.tasks`;
    if (!state.outstanding) {
      if (state.failed && !allowFailed) throw new Error('Unresolved failure during evaluation');
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Synchronization did not converge within the scenario deadline');
}
async function measure(name: string, operation: () => Promise<void>, allowFailed = false) {
  phase = name;
  const [boundary] = await sql`SELECT clock_timestamp() AS time`;
  const before = calls.length;
  const [walBefore] =
    await sql`SELECT wal_bytes::text,wal_records::text,stats_reset FROM pg_stat_wal`;
  const begin = performance.now();
  await operation();
  const mutationMs = performance.now() - begin;
  const queued =
    await sql`SELECT entity,status,count(*)::int AS count FROM localembed.tasks GROUP BY entity,status ORDER BY entity,status`;
  await drain(allowFailed);
  const elapsed = performance.now() - begin;
  const [walAfter] =
    await sql`SELECT wal_bytes::text,wal_records::text,stats_reset FROM pg_stat_wal`;
  const latency =
    await sql`SELECT entity,source_id,status, EXTRACT(epoch FROM (completed_at-requested_at))*1000 AS latency_ms
    FROM localembed.tasks WHERE status='done' AND requested_at >= ${boundary.time} ORDER BY entity,source_id`;
  const current = calls.slice(before);
  const completed = latency.map((row) => Number(row.latency_ms));
  scenarios.push({
    name,
    mutation_ms: mutationMs,
    elapsed_ms: elapsed,
    observed_cluster_wal_bytes_delta:
      walBefore.stats_reset?.getTime() === walAfter.stats_reset?.getTime()
        ? (BigInt(walAfter.wal_bytes) - BigInt(walBefore.wal_bytes)).toString()
        : null,
    wal_note:
      'Cumulative asynchronous PostgreSQL cluster statistics; includes background work and may flush across phase boundaries. Not exact per-statement WAL attribution.',
    attempts: current.length,
    provider_latency_ms: summarize(current.filter((c) => c.outcome === 'ok').map((c) => c.ms)),
    queue_after_mutation: queued,
    note:
      'Latency samples are latest completed generations requested within this phase; coalesced intermediate source versions have no completion sample.',
    retained_completion_latency_ms: summarize(completed),
    completed_task_rows: completed.length,
    completed_rows_per_second: elapsed ? completed.length / (elapsed / 1000) : null,
    attempts_per_second: elapsed ? current.length / (elapsed / 1000) : null,
  });
}
try {
  const [existing] =
    await sql`SELECT to_regnamespace('localembed') AS managed,to_regclass('public.evaluation_articles') AS source`;
  if (existing.managed || existing.source) {
    throw new Error('Refusing an existing installation or fixture');
  }
  const [occupied] = await sql`SELECT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_'
      AND c.relkind IN ('r','p','v','m','f') AND NOT EXISTS (
        SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
  ) AS occupied`;
  if (occupied.occupied) throw new Error('Refusing a nonempty database');
  const config = structuredClone(reference) as Configuration;
  config.providers[0].endpoint = endpoint;
  config.entities[0] = {
    ...config.entities[0],
    source: {
      table: 'public.evaluation_articles',
      id: { column: 'id', type: 'bigint' },
      detection: { mode: 'trigger' },
    },
    fields: ['title', 'body', 'id'],
    dependencies: [{
      name: 'category',
      relation: 'one',
      fields: ['name'],
      source_column: 'category_id',
      target: { table: 'public.evaluation_categories', id: { column: 'id', type: 'bigint' } },
    }],
    template: 'passage: {{title}}\n{{body}}\n{{category.name}}\neval-id:{{id}}',
    destination: {
      table: 'localembed.evaluation_embeddings',
      hnsw: { m: 16, ef_construction: 64 },
    },
  };
  config.entities.push({
    ...structuredClone(config.entities[0]),
    name: 'polled_article',
    source: {
      table: 'public.evaluation_polled',
      id: { column: 'id', type: 'bigint' },
      detection: { mode: 'polling', updated_at: 'updated_at', overlap_seconds: 0 },
    },
    destination: { table: 'localembed.evaluation_polled_embeddings' },
  });
  config.operations = {
    backfill: { batch_size: 8 },
    reconciliation: { interval_seconds: 60 },
    retries: { max_attempts: 3, base_delay_ms: 10, max_delay_ms: 50 },
  };
  validateConfiguration(config);
  const warmStarted = performance.now();
  const warmVector = await generate(config.providers[0], 'passage: evaluation warmup');
  if (warmVector.length !== 768 || !warmVector.every(Number.isFinite)) {
    throw new Error('Unexpected real model dimensions');
  }
  const warmupMs = performance.now() - warmStarted;
  await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE public.evaluation_categories(id bigint PRIMARY KEY,name text);
    INSERT INTO public.evaluation_categories VALUES(1,'general');
    CREATE TABLE public.evaluation_articles(id bigint PRIMARY KEY,title text,body text,views int DEFAULT 0,category_id bigint DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
    CREATE TABLE public.evaluation_polled(LIKE public.evaluation_articles INCLUDING ALL)`);
  for (let i = 1; i <= count; i++) {
    await sql`INSERT INTO public.evaluation_articles(id,title,body) VALUES(${i},${
      'Synthetic record ' + i
    },${
      'Deterministic workload record ' + i + ' about local embeddings and database maintenance.'
    })`;
  }
  for (const [i, row] of publicData.rows.entries()) {
    await sql`INSERT INTO public.evaluation_articles(id,title,body) VALUES(${
      count + i + 1
    },${row.title},${row.body})`;
  }
  await sql`INSERT INTO public.evaluation_polled(id,title,body) SELECT id,title,body FROM public.evaluation_articles WHERE id<=4`;
  const preflight = performance.now();
  await applyConfiguration(url, config);
  const preflightMs = performance.now() - preflight;
  for (let i = 0; i < 2; i++) {
    workers.push(
      new Worker(url, inference, { leaseSeconds: 1, renewEveryMs: 100, maxExecutionMs: 30000 }),
    );
  }
  await measure('initial_backfill', () => backfill(url));
  const [captureBefore] =
    await sql`SELECT sum(enqueued)::int AS enqueued FROM localembed.enqueue_metrics`;
  await measure('unrelated_unchanged', async () => {
    for (let i = 0; i < 10; i++) {
      await sql`UPDATE public.evaluation_articles SET views=views+1 WHERE id=1`;
      await sql`UPDATE public.evaluation_articles SET title=title WHERE id=1`;
    }
  });
  const [captureAfter] =
    await sql`SELECT sum(enqueued)::int AS enqueued FROM localembed.enqueue_metrics`;
  if (captureBefore.enqueued !== captureAfter.enqueued) {
    throw new Error('Unrelated/unchanged updates unexpectedly enqueued work');
  }
  await measure('burst_coalescing', async () => {
    for (let i = 0; i < 20; i++) {
      await sql`UPDATE public.evaluation_articles SET title=${'Burst revision ' + i} WHERE id=1`;
    }
  });
  await measure('dependency_fanout', async () => {
    await sql`UPDATE public.evaluation_categories SET name='changed category' WHERE id=1`;
  });
  await measure('transient_retry', async () => {
    await sql`UPDATE public.evaluation_articles SET body='transient retry fixture' WHERE id=2`;
  });
  await measure('terminal_failure', async () => {
    await sql`UPDATE public.evaluation_articles SET body='terminal failure fixture' WHERE id=3`;
  }, true);
  const [failure] =
    await sql`SELECT count(*)::int AS failed FROM localembed.tasks WHERE status='failed'`;
  if (failure.failed !== 1) throw new Error('Expected one retained injected failure');
  await measure('explicit_reprocess', async () => {
    await reprocess(url, '1', 'article', '3');
  });
  await measure('lease_renewal', async () => {
    await sql`UPDATE public.evaluation_articles SET body='lease renewal fixture' WHERE id=4`;
  });
  if (!leaseObserved) throw new Error('Lease renewal was not observed');
  await measure('polling_reconciliation', async () => {
    await sql`UPDATE public.evaluation_polled SET title='polled change',updated_at=clock_timestamp() WHERE id=1`;
    await sql`DELETE FROM public.evaluation_polled WHERE id=2`;
    // Force the due operational sweep, while retaining the actual resumable poller implementation.
    await sql`UPDATE localembed.polling_state SET next_reconcile=clock_timestamp()`;
    for (let i = 0; i < 4; i++) await poller.tick();
  });
  if ((await sql`SELECT 1 FROM localembed.evaluation_polled_embeddings WHERE source_id=2`).length) {
    throw new Error('Polling deletion did not reconcile');
  }
  let verifiedFresh = 0;
  for (const entity of config.entities) {
    const rows = await sql.unsafe(
      `SELECT id::text AS id FROM ${table(entity.source.table)} ORDER BY id`,
    );
    for (const source of rows) {
      const content = await readContent(sql, entity, source.id);
      if (!content) throw new Error('Source disappeared during isolated validation');
      const expected = await fingerprint(entity, config.providers[0], render(entity, content));
      const [destination] = await sql.unsafe(
        `SELECT fingerprint,vector_dims(embedding) AS dimensions FROM ${
          table(entity.destination.table)
        } WHERE source_id=$1::bigint`,
        [source.id],
      );
      if (destination?.fingerprint !== expected || destination.dimensions !== 768) {
        throw new Error('Embedding freshness/dimension validation failed');
      }
      verifiedFresh++;
    }
  }
  phase = 'online_indexes';
  const indexStarted = performance.now();
  await buildIndexes(url, true);
  const indexMs = performance.now() - indexStarted;
  const key = 'a'.repeat(64);
  const handler = createHandler(key, (entity) => store.load(entity), inference);
  const querySamples = [];
  phase = 'query_repeated';
  for (let i = 0; i < 6; i++) {
    const begin = performance.now();
    const response = await handler(
      new Request('http://evaluation.local/v1/embeddings', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
        body: JSON.stringify({ entity: 'article', input: 'query: earthquake catalog' }),
      }),
    );
    const payload = await response.json();
    if (response.status !== 200 || payload.embedding?.length !== 768) {
      throw new Error('Real query evaluation failed');
    }
    querySamples.push(performance.now() - begin);
  }
  phase = 'snapshot';
  const snapshotSamples = [];
  for (let i = 0; i < 10; i++) {
    const begin = performance.now();
    await snapshots.load();
    snapshotSamples.push(performance.now() - begin);
  }
  const snapshot = await snapshots.load();
  const catalog =
    await sql`SELECT version() AS postgres,extname,extversion FROM pg_extension WHERE extname IN ('pg_search','vector')`;
  const settings =
    await sql`SELECT name,setting,unit FROM pg_settings WHERE name IN ('maintenance_work_mem','max_parallel_maintenance_workers','max_parallel_workers','shared_buffers') ORDER BY name`;
  const tables =
    await sql`SELECT relname,n_live_tup,n_dead_tup,last_autovacuum FROM pg_stat_user_tables WHERE schemaname='localembed' ORDER BY relname`;
  const sizes =
    await sql`SELECT relname,pg_total_relation_size(oid)::text AS bytes FROM pg_class WHERE relnamespace='localembed'::regnamespace AND relkind='r' ORDER BY relname`;
  const plans = await sql.unsafe(
    "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM localembed.tasks WHERE status='done' AND processed_generation=generation AND completed_at<=$1 ORDER BY completed_at,id LIMIT 100 FOR UPDATE SKIP LOCKED",
    [new Date()],
  );
  const enqueueBefore =
    await sql`SELECT entity,origin,sum(enqueued)::text AS enqueued,sum(coalesced)::text AS coalesced FROM localembed.enqueue_metrics GROUP BY entity,origin ORDER BY entity,origin`;
  await configureRetention(url, { completed_seconds: 0, batch_size: 8 });
  const retainedBefore = Number(
    (await sql`SELECT count(*)::int AS count FROM localembed.tasks`)[0].count,
  );
  let deleted = 0, passes = 0;
  while (true) {
    const result = await cleanup(url, false);
    deleted += result.deleted_completed;
    passes++;
    if (!result.deleted_completed) break;
    if (passes > 10000) throw new Error('Cleanup did not converge');
  }
  const enqueueAfter =
    await sql`SELECT entity,origin,sum(enqueued)::text AS enqueued,sum(coalesced)::text AS coalesced FROM localembed.enqueue_metrics GROUP BY entity,origin ORDER BY entity,origin`;
  if (JSON.stringify(enqueueBefore) !== JSON.stringify(enqueueAfter)) {
    throw new Error('Cleanup changed capture history');
  }
  const cleanupAfter = await snapshots.load();
  const completed =
    await sql`SELECT count(*)::int AS count FROM localembed.tasks WHERE status='done'`;
  if (completed[0].count !== 0) throw new Error('Completion retention did not drain');
  if (scenarios.length !== 9 || calls.some((call) => call.outcome === 'provider_error')) {
    throw new Error('Incomplete baseline or unexpected provider failure');
  }
  const cpu = cpuUsage(cpuStart);
  const fixtureBytes = await Deno.readFile('docs/evaluation/data/usgs-2020-01.json');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', fixtureBytes))).map((
    n,
  ) => n.toString(16).padStart(2, '0')).join('');
  const runnerHash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', await Deno.readFile('scripts/evaluation/run.ts')),
    ),
  ).map((n) => n.toString(16).padStart(2, '0')).join('');
  const harnessHashes: Record<string, string> = {};
  for (
    const path of [
      'scripts/evaluation/run.ts',
      'scripts/evaluation/statistics.ts',
      'scripts/evaluation/run.sh',
      'scripts/evaluation/observe.py',
      'scripts/evaluation/finish_report.py',
    ]
  ) {
    harnessHashes[path] = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', await Deno.readFile(path))),
    ).map((n) => n.toString(16).padStart(2, '0')).join('');
  }
  const result = {
    issue: 10,
    harness_sha256: harnessHashes,
    runner_sha256: runnerHash,
    git_worktree_dirty: Deno.env.get('EVALUATION_GIT_DIRTY') === 'true',
    started_at: startedAt,
    recorded_at: new Date().toISOString(),
    git_revision: Deno.env.get('EVALUATION_GIT_REVISION') ?? 'not supplied',
    workload: {
      synthetic_rows: count,
      public_rows: publicData.rows.length,
      polled_rows: 4,
      workers: 2,
      backfill_batch: 8,
      poller_batch: 8,
      lease_seconds: 1,
      renew_every_ms: 100,
      max_execution_ms: 30000,
      unrelated_updates: 10,
      unchanged_updates: 10,
      burst_updates: 20,
      query_samples: 6,
    },
    public_dataset: {
      source: publicData.source,
      fixture: 'docs/evaluation/data/usgs-2020-01.json',
      sha256: hash,
      source_response_sha256: publicData.source_response_sha256,
    },
    inference: {
      mode: 'real pinned TEI except explicitly injected faults',
      model: config.providers[0].model,
      revision: '129286372ebbc09af0394786dd03e16427ade171',
      dimensions: 768,
      warmup_request_ms: warmupMs,
      preflight_ms: preflightMs,
      model_download_and_startup_excluded: true,
    },
    environment: {
      deno: Deno.version,
      catalog,
      settings,
      configuration: config,
      telemetry: 'ordinary structured events; no OTLP exporter/LGTM enabled for this run',
    },
    scenarios,
    provider_calls: calls,
    rates: {
      total_attempts: calls.length,
      injected_transient: calls.filter((c) => c.outcome === 'injected_transient').length,
      injected_terminal: calls.filter((c) => c.outcome === 'injected_terminal').length,
      natural_provider_failures: calls.filter((c) => c.outcome === 'provider_error').length,
      injection_failure_fraction: calls.filter((c) => c.outcome.startsWith('injected')).length /
        calls.length,
    },
    assertions: {
      verified_fresh_embeddings: verifiedFresh,
      unrelated_unchanged_captures: 0,
      lease_renewed: leaseObserved,
      retained_terminal_failure_before_reprocess: failure.failed,
      polling_delete_reconciled: true,
      capture_history_preserved: true,
    },
    query: {
      cache_implemented: false,
      latency_ms: summarize(querySamples),
      first_ms: querySamples[0],
      subsequent_ms: summarize(querySamples.slice(1)),
      full_samples_ms: querySamples,
    },
    snapshot: {
      latency_ms: summarize(snapshotSamples),
      before_cleanup: snapshot,
      after_cleanup: cleanupAfter,
    },
    maintenance: {
      online_index_ms: indexMs,
      retention: { retained_before: retainedBefore, deleted, passes },
      catalog_sizes: sizes,
      table_statistics: tables,
      retention_plan: plans,
    },
    resources: {
      shared_deno_process: {
        peak_rss_bytes: peakRss,
        cpu_user_us: cpu.user,
        cpu_system_us: cpu.system,
        elapsed_ms: performance.now() - started,
      },
      note:
        'Admin/workers/poller/API/snapshot share this process; role RSS cannot be attributed separately. Docker resource samples are produced by the shell driver.',
    },
    related_probes: [
      'docs/evaluation/indexes.json',
      'docs/evaluation/retention.json',
      'docs/evaluation/hybrid-storage.json',
      'docs/evaluation/deployment.json',
    ],
    limitations: [
      'Small functional/operational baseline, not production sizing or retrieval-quality evaluation.',
      'Nearest-rank percentiles have small sample counts; source requested-to-completed includes queue and injected delay, not commit-to-observation latency.',
      'Public titles use real data; synthetic mutations deliberately replace some content.',
      'Future cache/quota/token/dependency/CDC/counter toggles are not implemented and cannot receive before/after measurements yet.',
      'No standalone runtime-by-role resource measurement, cold model download benchmark or real second-model dimension rollout in this run.',
    ],
  };
  await Deno.writeTextFile(reportPath, JSON.stringify(result, null, 2) + '\n');
  console.log(
    JSON.stringify({
      report: reportPath,
      attempts: calls.length,
      scenarios: scenarios.length,
      retention_deleted: deleted,
    }),
  );
} finally {
  clearInterval(samples);
  await Promise.all(workers.map((worker) => worker.close()));
  await Promise.all([poller.close(), store.close(), snapshots.close(), sql.end()]);
}
