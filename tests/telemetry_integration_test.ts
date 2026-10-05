import { assertEquals, assertRejects } from '@std/assert';
import postgres from 'npm:postgres@3.4.7';
import { applyConfiguration, type Configuration } from '../services/admin/apply.ts';
import { prepareWorker } from '../services/admin/synchronize.ts';
import { Worker } from '../services/worker/worker.ts';
import { SnapshotStore } from '../services/telemetry/snapshot.ts';
import example from '../contracts/examples/localembed.v1.example.json' with { type: 'json' };
const ignored = () =>
  Deno.permissions.querySync({ name: 'env', variable: 'TEST_DATABASE_URL' }).state !== 'granted' ||
  !Deno.env.get('TEST_DATABASE_URL');

Deno.test({
  name:
    'durable capture counters survive reusable task retention, rollback and migration; snapshots are read only',
  ignore: ignored(),
  async fn() {
    const url = Deno.env.get('TEST_DATABASE_URL')!;
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    let store: SnapshotStore | undefined;
    const config: Configuration = {
      version: 'localembed/v1',
      providers: [{ ...example.providers[0], type: 'tei', metric: 'cosine', dimensions: 3 }],
      entities: [{
        name: 'article',
        source: {
          table: 'public.telemetry_articles',
          id: { column: 'id', type: 'bigint' },
          detection: { mode: 'trigger' },
        },
        fields: ['title'],
        provider: example.providers[0].name,
        template: '{{title}}',
        destination: { table: 'localembed.telemetry_vectors' },
      }],
    };
    try {
      await sql.unsafe(
        `CREATE EXTENSION IF NOT EXISTS vector; DROP SCHEMA IF EXISTS localembed CASCADE;
        DROP TABLE IF EXISTS public.telemetry_articles; CREATE TABLE public.telemetry_articles(id bigint PRIMARY KEY, title text)`,
      );
      await applyConfiguration(url, config, () => Promise.resolve());
      await sql`INSERT INTO public.telemetry_articles VALUES(1, 'private source')`;
      await sql`UPDATE public.telemetry_articles SET title = 'changed source' WHERE id = 1`;
      await sql`UPDATE public.telemetry_articles SET title = title WHERE id = 1`;
      await assertRejects(() =>
        sql.begin(async (tx) => {
          await tx`UPDATE public.telemetry_articles SET title = 'rolled back' WHERE id = 1`;
          throw new Error('rollback');
        })
      );
      await prepareWorker(url);
      const [counts] =
        await sql`SELECT sum(enqueued)::int AS enqueued, sum(coalesced)::int AS coalesced FROM localembed.enqueue_metrics`;
      assertEquals(counts, { enqueued: 2, coalesced: 1 });
      await sql.unsafe(`CREATE ROLE localembed_snapshot_test NOLOGIN;
        GRANT USAGE ON SCHEMA localembed TO localembed_snapshot_test;
        GRANT SELECT ON localembed.tasks, localembed.entity_revisions, localembed.enqueue_metrics, localembed.polling_state, localembed.cleanup_totals TO localembed_snapshot_test`);
      const address = new URL(url);
      address.searchParams.set('options', '-c role=localembed_snapshot_test');
      store = new SnapshotStore(address.toString());
      let snapshot = await store.load();
      assertEquals(snapshot.queue.find((row) => row.status === 'pending')?.depth, 1);
      assertEquals(snapshot.queue.find((row) => row.status === 'processing')?.depth, 0);
      assertEquals(snapshot.capture[0].captured, 2);
      const worker = new Worker(url, () => Promise.resolve([1, 2, 3]));
      try {
        await worker.tick();
        await sql`UPDATE public.telemetry_articles SET title = 'new completed generation' WHERE id = 1`;
        const [reused] =
          await sql`SELECT sum(enqueued)::int AS enqueued, sum(coalesced)::int AS coalesced FROM localembed.enqueue_metrics`;
        assertEquals(reused, { enqueued: 3, coalesced: 1 });
        await worker.tick();
      } finally {
        await worker.close();
      }
      await sql`DELETE FROM localembed.tasks WHERE status = 'done'`;
      snapshot = await store.load();
      assertEquals(snapshot.queue.every((row) => row.depth === 0), true);
      assertEquals(snapshot.capture[0].enqueued, 3);
      assertEquals(snapshot.capture[0].coalesced, 1);
    } finally {
      await store?.close();
      await sql.unsafe(
        'DROP SCHEMA IF EXISTS localembed CASCADE; DROP TABLE IF EXISTS public.telemetry_articles; DROP ROLE IF EXISTS localembed_snapshot_test',
      );
      await sql.end();
    }
  },
});
