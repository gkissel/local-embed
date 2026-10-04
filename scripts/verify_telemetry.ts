import { Poller } from '../services/poller/poller.ts';
import { trace } from '@opentelemetry/api';
import postgres from 'npm:postgres@3.4.7';
import { applyConfiguration, type Configuration } from '../services/admin/apply.ts';
import { Worker } from '../services/worker/worker.ts';
import { SnapshotStore } from '../services/telemetry/snapshot.ts';
import { SnapshotMetrics } from '../services/telemetry/metrics.ts';
import { observeResources } from '../services/shared/resources.ts';
import { createHandler } from '../services/api/api.ts';
import example from '../contracts/examples/localembed.v1.example.json' with { type: 'json' };
import { assertEquals } from '@std/assert';

// Only an empty disposable test database is accepted; never overwrite an installation.
const url = Deno.env.get('TEST_DATABASE_URL');
if (!url) throw new Error('TEST_DATABASE_URL must identify an empty disposable database');
const sql = postgres(url, { max: 1, onnotice: () => {} });
const snapshot = new SnapshotStore(url);
const metrics = new SnapshotMetrics();
observeResources();
const config: Configuration = {
  version: 'localembed/v1',
  providers: [{ ...example.providers[0], type: 'tei', metric: 'cosine', dimensions: 3 }],
  entities: [{
    name: 'telemetry_smoke',
    source: {
      table: 'public.localembed_telemetry_smoke',
      id: { column: 'id', type: 'bigint' },
      detection: { mode: 'trigger' },
    },
    fields: ['title'],
    provider: example.providers[0].name,
    template: '{{title}}',
    destination: { table: 'localembed.telemetry_smoke_vectors' },
  }],
};
config.entities.push({
  ...config.entities[0],
  name: 'telemetry_poll_smoke',
  source: {
    ...config.entities[0].source,
    detection: { mode: 'polling', updated_at: 'updated_at' },
  },
  destination: { table: 'localembed.telemetry_poll_smoke_vectors' },
});
let provisioned = false;
try {
  const [existing] =
    await sql`SELECT to_regnamespace('localembed') AS installation, to_regclass('public.localembed_telemetry_smoke') AS source`;
  if (existing.installation || existing.source) {
    throw new Error('Smoke test requires an empty test database');
  }
  await sql`CREATE TABLE public.localembed_telemetry_smoke(id bigint PRIMARY KEY, title text, updated_at timestamptz NOT NULL DEFAULT clock_timestamp())`;
  provisioned = true;
  await applyConfiguration(url, config, () => Promise.resolve());
  await sql`INSERT INTO public.localembed_telemetry_smoke VALUES(1, 'PRIVATE_SMOKE_SOURCE', clock_timestamp())`;
  await sql`UPDATE public.localembed_telemetry_smoke SET title = 'PRIVATE_SMOKE_UPDATED' WHERE id = 1`;
  const poller = new Poller(url);
  try {
    await poller.tick();
  } finally {
    await poller.close();
  }
  metrics.update(await snapshot.load());
  // Keep the pending state visible for one export cycle.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const worker = new Worker(url, () => Promise.resolve([1, 2, 3]));
  try {
    assertEquals(await worker.tick(), true);
    assertEquals(await worker.tick(), true);
  } finally {
    await worker.close();
  }
  const key = 'a'.repeat(64);
  const handler = createHandler(
    key,
    () => Promise.resolve(config),
    () => Promise.resolve([1, 2, 3]),
  );
  const response = await handler(
    new Request('http://localhost/v1/embeddings?secret=PRIVATE_SMOKE_URL', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ entity: 'telemetry_smoke', input: 'PRIVATE_SMOKE_QUERY' }),
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(
    (await handler(new Request('http://localhost/v1/embeddings', { method: 'POST' }))).status,
    401,
  );
  metrics.update(await snapshot.load());
  // Prove the reference collector rejects unsanitized logs and other instrumentation scopes.
  console.log('PRIVATE_SMOKE_UNSTRUCTURED');
  const unsafe = trace.getTracer('unsafe-smoke').startSpan('PRIVATE_SMOKE_UNSAFE_SPAN', {
    attributes: { 'url.full': 'PRIVATE_SMOKE_UNSAFE_URL' },
  });
  console.log('PRIVATE_SMOKE_UNSAFE_TRACE:' + unsafe.spanContext().traceId);
  unsafe.end();
  await new Promise((resolve) => setTimeout(resolve, 3000));
} finally {
  await snapshot.close();
  if (provisioned) {
    await sql.unsafe(
      'DROP SCHEMA IF EXISTS localembed CASCADE; DROP TABLE public.localembed_telemetry_smoke',
    );
  }
  await sql.end();
}
