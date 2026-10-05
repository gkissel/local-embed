import { assertEquals, assertRejects } from '@std/assert';
import postgres from 'npm:postgres@3.4.7';
import { applyConfiguration, type Configuration } from '../services/admin/apply.ts';
import { backfill, buildIndexes, prepareWorker } from '../services/admin/synchronize.ts';
import { activate } from '../services/admin/revisions.ts';
import { cleanup, configureRetention } from '../services/admin/retention.ts';
import { Worker } from '../services/worker/worker.ts';
import reference from '../deployments/localembed.reference.json' with { type: 'json' };

const url =
  Deno.permissions.querySync({ name: 'env', variable: 'TEST_DATABASE_URL' }).state === 'granted'
    ? Deno.env.get('TEST_DATABASE_URL')
    : undefined;
const id = (n: number) => '00000000-0000-0000-0000-' + String(n).padStart(12, '0');
async function fixture(count: number) {
  const sql = postgres(url!, { max: 1, onnotice: () => {} });
  await sql.unsafe(
    'CREATE EXTENSION IF NOT EXISTS vector; DROP SCHEMA IF EXISTS localembed CASCADE; DROP TABLE IF EXISTS public.articles CASCADE; CREATE TABLE public.articles(id uuid PRIMARY KEY, title text, body text)',
  );
  for (let n = 1; n <= count; n++) {
    await sql`INSERT INTO public.articles VALUES (${id(n)}, 'title', 'body')`;
  }
  const config = structuredClone(reference) as Configuration;
  config.providers[0].dimensions = 3;
  await applyConfiguration(url!, config, () => Promise.resolve());
  const worker = new Worker(url!, () => Promise.resolve([1, 0, 0]));
  await backfill(url!);
  while (await worker.tick()) { /* initial load */ }
  return {
    sql,
    config,
    worker,
    async close() {
      await worker.close();
      await sql.unsafe('DROP SCHEMA localembed CASCADE; DROP TABLE public.articles CASCADE');
      await sql.end();
    },
  };
}
Deno.test({
  name: 'retention cutoff, bounded batches and durable aggregate preservation',
  ignore: !url,
  fn: async () => {
    const f = await fixture(8);
    try {
      await configureRetention(url!, { completed_seconds: 60, batch_size: 2 });
      await f
        .sql`UPDATE localembed.tasks SET completed_at = clock_timestamp() - interval '120 seconds'`;
      await f.sql`UPDATE localembed.tasks SET completed_at = clock_timestamp() WHERE source_id = ${
        id(3)
      }`;
      await f
        .sql`UPDATE localembed.tasks SET status = 'failed', error_code = 'provider_terminal' WHERE source_id = ${
        id(4)
      }`;
      await f.sql`UPDATE localembed.tasks SET status = 'pending' WHERE source_id = ${id(5)}`;
      await f
        .sql`UPDATE localembed.tasks SET status = 'processing', lease_token = ${crypto.randomUUID()}::uuid, lease_until = clock_timestamp() + interval '1 hour' WHERE source_id = ${
        id(6)
      }`;
      await f.sql`UPDATE localembed.tasks SET generation = generation + 1 WHERE source_id = ${
        id(7)
      }`;
      await f.sql`UPDATE localembed.tasks SET completed_at = NULL WHERE source_id = ${id(8)}`;
      const backfillBefore = await f
        .sql`SELECT * FROM localembed.backfills ORDER BY configuration_id,entity`;
      const before = await f
        .sql`SELECT sum(enqueued)::int AS enqueued FROM localembed.enqueue_metrics`;
      const preview = await cleanup(url!);
      assertEquals(preview.eligible_completed, 2);
      assertEquals(preview.deleted_completed, 0);
      assertEquals((await f.sql`SELECT count(*)::int AS count FROM localembed.tasks`)[0].count, 8);
      assertEquals((await cleanup(url!, false)).deleted_completed, 2);
      assertEquals((await cleanup(url!, false)).deleted_completed, 0);
      assertEquals((await f.sql`SELECT count(*)::int AS count FROM localembed.tasks`)[0].count, 6);
      assertEquals(
        await f.sql`SELECT sum(enqueued)::int AS enqueued FROM localembed.enqueue_metrics`,
        before,
      );
      assertEquals(
        await f.sql`SELECT * FROM localembed.backfills ORDER BY configuration_id,entity`,
        backfillBefore,
      );
      // Re-enqueue after deletion is fresh actionable state, not a lost update.
      await f.sql`UPDATE public.articles SET title = 'changed' WHERE id = ${id(1)}::uuid`;
      const [fresh] = await f
        .sql`SELECT status, completed_at FROM localembed.tasks WHERE source_id = ${id(1)}`;
      assertEquals(fresh.status, 'pending');
      assertEquals(fresh.completed_at, null);
      await prepareWorker(url!);
      const [migrated] = await f.sql`SELECT completed_at FROM localembed.tasks WHERE source_id = ${
        id(8)
      }`;
      assertEquals(migrated.completed_at !== null, true);
    } finally {
      await f.close();
    }
  },
});
Deno.test({
  name: 'cleanup skips locked reservations and serializes administrator ownership',
  ignore: !url,
  fn: async () => {
    const f = await fixture(1);
    const blocker = postgres(url!, { max: 1 });
    try {
      await configureRetention(url!, { completed_seconds: 0 });
      await blocker.begin(async (tx) => {
        await tx`SELECT id FROM localembed.tasks FOR UPDATE`;
        assertEquals((await cleanup(url!, false)).deleted_completed, 0);
      });
      await blocker.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(78129412)`;
        await assertRejects(() => cleanup(url!, false), Error, 'Another administrator');
      });
      assertEquals((await cleanup(url!, false)).deleted_completed, 1);
    } finally {
      await blocker.end();
      await f.close();
    }
  },
});
Deno.test({
  name:
    'retired destination cleanup protects snapshots, deadlines, diagnostics and active generations',
  ignore: !url,
  fn: async () => {
    const f = await fixture(3);
    const reader = postgres(url!, { max: 1 });
    try {
      await buildIndexes(url!);
      const candidate = structuredClone(f.config);
      candidate.entities[0].destination.table = 'localembed.article_embeddings_new';
      const revision = await applyConfiguration(url!, candidate, () => Promise.resolve(), true);
      await backfill(url!);
      while (await f.worker.tick()) { /* staged load */ }
      await buildIndexes(url!);
      await f
        .sql`UPDATE localembed.tasks SET status = 'failed', last_error = NULL, error_code = NULL WHERE configuration_id = 1 AND source_id = ${
        id(1)
      }`;
      await f
        .sql`UPDATE localembed.tasks SET status = 'processing', execution_deadline = clock_timestamp() + interval '1 hour' WHERE configuration_id = 1 AND source_id = ${
        id(2)
      }`;
      await f
        .sql`UPDATE localembed.tasks SET status = 'pending' WHERE configuration_id = 1 AND source_id = ${
        id(3)
      }`;
      await reader`SELECT pg_advisory_lock_shared(78129413)`;
      try {
        await reader.begin('isolation level repeatable read read only', async (tx) => {
          assertEquals(
            (await tx`SELECT configuration_id FROM localembed.entity_revisions WHERE state = 'active'`)[
              0
            ].configuration_id,
            '1',
          );
          await activate(url!, revision);
          await assertRejects(
            () => configureRetention(url!, { drop_retired_destinations: true }),
            Error,
            'every consumer',
          );
          await configureRetention(url!, {
            completed_seconds: 86400,
            batch_size: 1,
            retired_seconds: 0,
            keep_retired: 0,
            reader_grace_seconds: 0,
            drop_retired_destinations: true,
            readers_use_lock_protocol: true,
          });
          assertEquals((await cleanup(url!, false)).destinations.length, 0); // old execution deadline not expired
          await f
            .sql`UPDATE localembed.entity_revisions SET retired_execution_until = clock_timestamp() - interval '1 second' WHERE state = 'retired'`;
          const report = await cleanup(url!, false);
          assertEquals(report.destinations[0].action, 'reader_active');
          // Pointer was resolved before activation; old snapshot can still reach its table.
          assertEquals(
            (await tx`SELECT count(*)::int AS count FROM localembed.article_embeddings`)[0].count,
            3,
          );
        });
      } finally {
        await reader`SELECT pg_advisory_unlock_shared(78129413)`;
      }
      const preview = await cleanup(url!);
      assertEquals(preview.destinations[0].action, 'eligible');
      assertEquals(Number(preview.destinations[0].bytes) > 0, true);
      // Non-cooperating readers already holding the relation lock also block DROP.
      await reader.begin(async (tx) => {
        await tx`SELECT count(*) FROM localembed.article_embeddings`;
        assertEquals((await cleanup(url!, false)).destinations[0].action, 'locked_or_dependent');
      });
      const removed = await cleanup(url!, false);
      assertEquals(removed.destinations[0].action, 'dropped');
      assertEquals(removed.deleted_superseded, 1);
      assertEquals(
        (await f.sql`SELECT to_regclass('localembed.article_embeddings') AS relation`)[0].relation,
        null,
      );
      assertEquals(
        (await f.sql`SELECT count(*)::int AS count FROM localembed.article_embeddings_new`)[0]
          .count,
        3,
      );
      const [failure] = await f
        .sql`SELECT status, superseded_from_status FROM localembed.tasks WHERE configuration_id = 1 AND source_id = ${
        id(1)
      }`;
      assertEquals(failure.status, 'superseded');
      assertEquals(failure.superseded_from_status, 'failed');
      const resumed = await cleanup(url!, false);
      assertEquals(resumed.destinations.length, 0);
      assertEquals(resumed.deleted_superseded, 1);
      assertEquals(
        (await f.sql`SELECT superseded FROM localembed.cleanup_totals`)[0].superseded,
        '2',
      );
    } finally {
      await reader.end();
      await f.close();
    }
  },
});
Deno.test({
  name: 'concurrent enqueue survives deletion and cleanup aggregates survive audit retention',
  ignore: !url,
  fn: async () => {
    const f = await fixture(1);
    const blocker = postgres(url!, { max: 1 });
    const writer = postgres(url!, {
      max: 1,
      connection: { application_name: 'retention_race_writer' },
    });
    let cleaning: ReturnType<typeof cleanup> | undefined;
    let writing: Promise<unknown> | undefined;
    try {
      await configureRetention(url!, { completed_seconds: 0, audit_seconds: 0, batch_size: 1 });
      await blocker.begin(async (tx) => {
        await tx.unsafe('LOCK TABLE localembed.admin_actions IN SHARE MODE');
        cleaning = cleanup(url!, false);
        const deadline = performance.now() + 800;
        while (true) {
          const [row] = await f
            .sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%localembed.admin_actions%') AS waiting`;
          if (row.waiting) break;
          if (performance.now() > deadline) {
            throw new Error('Cleanup did not reach audit lock barrier');
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        writing =
          writer`UPDATE public.articles SET title = 'concurrent latest content' WHERE id = ${
            id(1)
          }::uuid`.execute();
        // The source transaction's enqueue waits on deletion of the reusable task.
        while (true) {
          const [row] = await f
            .sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name = 'retention_race_writer' AND wait_event_type = 'Lock') AS waiting`;
          if (row.waiting) break;
          if (performance.now() > deadline) {
            throw new Error('Concurrent enqueue did not wait on cleanup');
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      });
      assertEquals((await cleaning!).deleted_completed, 1);
      await writing;
      const [task] = await f.sql`SELECT status, completed_at FROM localembed.tasks`;
      assertEquals(task.status, 'pending');
      assertEquals(task.completed_at, null);
      assertEquals(await f.worker.tick(), true);
      const [final] = await f.sql`SELECT status, completed_at FROM localembed.tasks`;
      assertEquals(final.status, 'done');
      assertEquals(final.completed_at !== null, true);
      await cleanup(url!, false);
      const [totals] = await f.sql`SELECT completed FROM localembed.cleanup_totals`;
      assertEquals(totals.completed, '2');
      const [captures] = await f
        .sql`SELECT sum(enqueued)::int AS count FROM localembed.enqueue_metrics`;
      assertEquals(captures.count, 2);
    } finally {
      await Promise.allSettled([cleaning, writing]);
      await writer.end();
      await blocker.end();
      await f.close();
    }
  },
});
