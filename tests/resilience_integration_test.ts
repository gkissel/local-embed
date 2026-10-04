import { assertEquals, assertRejects } from '@std/assert';
import postgres from 'npm:postgres@3.4.7';
import { applyConfiguration, type Configuration } from '../services/admin/apply.ts';
import { activate, cancelRevision, reprocess } from '../services/admin/revisions.ts';
import { backfill, buildIndexes, prepareWorker } from '../services/admin/synchronize.ts';
import { Poller } from '../services/poller/poller.ts';
import { ConfigurationStore } from '../services/api/api.ts';
import { type Generate, Worker } from '../services/worker/worker.ts';
import example from '../contracts/examples/localembed.v1.example.json' with { type: 'json' };

const enabled =
  Deno.permissions.querySync({ name: 'env', variable: 'TEST_DATABASE_URL' }).state === 'granted' &&
  !!Deno.env.get('TEST_DATABASE_URL');
const configuration = (): Configuration => {
  const config = structuredClone(example) as Configuration;
  config.entities[0].source.id.type = 'bigint';
  config.providers[0].dimensions = 3;
  config.operations = { retries: { max_attempts: 3, base_delay_ms: 1, max_delay_ms: 2 } };
  return config;
};
async function fixture(
  run: (sql: ReturnType<typeof postgres>, url: string, config: Configuration) => Promise<void>,
) {
  const url = Deno.env.get('TEST_DATABASE_URL')!;
  const sql = postgres(url, { max: 1 });
  try {
    await sql.unsafe(
      'CREATE EXTENSION IF NOT EXISTS vector; DROP SCHEMA IF EXISTS localembed CASCADE; DROP TABLE IF EXISTS public.articles; CREATE TABLE public.articles(id bigint PRIMARY KEY, title text, body text, updated_at timestamptz NOT NULL DEFAULT clock_timestamp())',
    );
    const config = configuration();
    await applyConfiguration(url, config, () => Promise.resolve());
    await run(sql, url, config);
  } finally {
    await sql.unsafe(
      'DROP SCHEMA IF EXISTS localembed CASCADE; DROP TABLE IF EXISTS public.articles',
    );
    await sql.end();
  }
}
const drain = async (worker: Worker) => {
  let left = 30;
  while (await worker.tick()) if (!--left) throw new Error('Queue did not converge');
};

Deno.test({
  name:
    'worker persists retry schedules across restart and terminal failures retain diagnostics until explicit reprocess',
  ignore: !enabled,
  fn: () =>
    fixture(async (sql, url) => {
      let calls = 0;
      const failing: Generate = () => {
        calls++;
        return Promise.reject({
          statusCode: 429,
          responseHeaders: { 'retry-after': '60' },
          message: 'secret',
          responseBody: 'source content',
        });
      };
      const first = new Worker(url, failing);
      const restarted = new Worker(url, failing);
      const healthy = new Worker(url, () => Promise.resolve([1, 0, 0]));
      try {
        await sql`INSERT INTO public.articles(id,title,body) VALUES(1,'Initial','Body')`;
        await first.tick();
        const [scheduled] =
          await sql`SELECT status, attempts, error_code, provider_status, next_attempt_at > clock_timestamp() + interval '59 seconds' AS respects_delay, last_error FROM localembed.tasks`;
        assertEquals(scheduled.status, 'pending');
        assertEquals(scheduled.attempts, 1);
        assertEquals(scheduled.error_code, 'rate_limited');
        assertEquals(scheduled.provider_status, 429);
        assertEquals(scheduled.respects_delay, true);
        assertEquals(scheduled.last_error.includes('secret'), false);
        await first.close();
        assertEquals(await restarted.tick(), false);
        for (let i = 0; i < 2; i++) {
          await sql`UPDATE localembed.tasks SET next_attempt_at = clock_timestamp()`;
          await restarted.tick();
        }
        assertEquals(calls, 3);
        assertEquals((await sql`SELECT status FROM localembed.tasks`)[0].status, 'failed');
        await sql`UPDATE public.articles SET title = 'Latest after failure'`;
        assertEquals((await sql`SELECT status FROM localembed.tasks`)[0].status, 'failed');
        assertEquals(await reprocess(url, '1', 'article', '1'), 1);
        assertEquals(await reprocess(url, '1', 'article', '1'), 0);
        await healthy.tick();
        const [done] =
          await sql`SELECT status, attempts, generation, processed_generation FROM localembed.tasks`;
        assertEquals(done.status, 'done');
        assertEquals(done.attempts, 1);
        assertEquals(done.generation, done.processed_generation);
        const actions =
          await sql`SELECT details, actor FROM localembed.admin_actions WHERE action = 'reprocess'`;
        assertEquals(actions.length, 1);
        assertEquals(actions[0].details.error_code, 'rate_limited');
        assertEquals(actions[0].actor, 'postgres');
      } finally {
        await Promise.all([first.close(), restarted.close(), healthy.close()]);
      }
    }),
});

Deno.test({
  name:
    'terminal authentication and dimensions do not retry, while new generations reset pending retry budgets',
  ignore: !enabled,
  fn: () =>
    fixture(async (sql, url) => {
      let fail: unknown = { statusCode: 401, message: 'credential secret' };
      const worker = new Worker(url, () => Promise.reject(fail));
      const invalid = new Worker(url, () => Promise.resolve([1]));
      try {
        await sql`INSERT INTO public.articles(id,title,body) VALUES(1,'Initial','Body')`;
        await worker.tick();
        assertEquals((await sql`SELECT status, attempts FROM localembed.tasks`)[0], {
          status: 'failed',
          attempts: 1,
        });
        await reprocess(url, '1', 'article');
        await invalid.tick();
        assertEquals(
          (await sql`SELECT error_code FROM localembed.tasks`)[0].error_code,
          'invalid_embedding',
        );
        await reprocess(url, '1', 'article');
        fail = { statusCode: 503 };
        await worker.tick();
        await sql`UPDATE public.articles SET title = 'New generation'`;
        const [fresh] =
          await sql`SELECT attempts, retry_generation, generation, next_attempt_at <= clock_timestamp() AS ready FROM localembed.tasks`;
        assertEquals(fresh.attempts, 0);
        assertEquals(fresh.retry_generation, fresh.generation);
        assertEquals(fresh.ready, true);
      } finally {
        await worker.close();
        await invalid.close();
      }
    }),
});

Deno.test({
  name:
    'staged dimension replacement is immutable, indexed and explicitly activated without late old-worker writes',
  ignore: !enabled,
  fn: () =>
    fixture(async (sql, url, config) => {
      const store = new ConfigurationStore(url);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let blocked = false;
      const worker = new Worker(url, async (provider) => {
        if (blocked && provider.dimensions === 3) {
          entered.resolve();
          await release.promise;
        }
        return Array(provider.dimensions).fill(0.5);
      });
      let processing: Promise<boolean> | undefined;
      try {
        await sql`INSERT INTO public.articles(id,title,body) VALUES(1,'Initial','Body')`;
        await backfill(url);
        await drain(worker);
        await buildIndexes(url);
        await assertRejects(
          () =>
            sql`UPDATE localembed.configurations SET configuration = configuration || '{"version":"changed"}'::jsonb`,
          Error,
          'immutable',
        );
        const candidate = structuredClone(config);
        candidate.providers[0].dimensions = 4;
        candidate.providers[0].model = 'replacement-model';
        candidate.entities[0].destination.table = 'localembed.article_embeddings_v2';
        const revision = await applyConfiguration(url, candidate, () => Promise.resolve(), true);
        assertEquals((await store.load('article'))!.applied_revision, '1');
        await assertRejects(() => activate(url, revision), Error, 'Finish backfill');
        await backfill(url);
        await drain(worker);
        await buildIndexes(url);
        await prepareWorker(url);
        await sql`UPDATE public.articles SET title = 'Changed before activation'`;
        const tasks =
          await sql`SELECT configuration_id, generation FROM localembed.tasks ORDER BY configuration_id`;
        assertEquals(tasks.map((task) => task.generation), ['3', '2']);
        blocked = true;
        processing = worker.tick();
        await entered.promise;
        // Another worker finishes the staged revision while the old provider response is held.
        const replacement = new Worker(url, (provider) =>
          Promise.resolve(Array(provider.dimensions).fill(0.8)));
        try {
          await drain(replacement);
        } finally {
          await replacement.close();
        }
        const old =
          (await sql`SELECT fingerprint FROM localembed.article_embeddings`)[0].fingerprint;
        await activate(url, revision);
        await activate(url, revision);
        release.resolve();
        await processing;
        assertEquals(
          (await sql`SELECT fingerprint FROM localembed.article_embeddings`)[0].fingerprint,
          old,
        );
        assertEquals(
          (await sql`SELECT vector_dims(embedding) AS dims FROM localembed.article_embeddings_v2`)[
            0
          ].dims,
          4,
        );
        assertEquals((await store.load('article'))!.providers[0].model, 'replacement-model');
        assertEquals(
          (await sql`SELECT status FROM localembed.tasks WHERE configuration_id = 1`)[0].status,
          'superseded',
        );
        await assertRejects(() => reprocess(url, '1', 'article'), Error, 'eligible');
        await sql`SELECT localembed.enqueue_task(1, 'article', '1', 'upsert')`;
        assertEquals(
          (await sql`SELECT status FROM localembed.tasks WHERE configuration_id = 1`)[0].status,
          'superseded',
        );
        await sql`UPDATE public.articles SET title = 'After activation'`;
        await drain(worker);
        assertEquals(
          (await sql`SELECT generation FROM localembed.tasks WHERE configuration_id = ${revision}`)[
            0
          ].generation,
          '3',
        );
      } finally {
        release.resolve();
        await processing;
        await worker.close();
        await store.close();
      }
    }),
});

Deno.test({
  name:
    'staged polling is fenced on cancellation and activation rejects outdated destinations until reconciliation',
  ignore: !enabled,
  fn: () =>
    fixture(async (sql, url, config) => {
      const worker = new Worker(url, (provider) =>
        Promise.resolve(Array(provider.dimensions).fill(0.5)));
      const poller = new Poller(url, 10);
      try {
        await sql`INSERT INTO public.articles(id,title,body) VALUES(1,'Initial','Body')`;
        await backfill(url);
        await drain(worker);
        await buildIndexes(url);
        const candidate = structuredClone(config);
        candidate.entities[0].source.detection = {
          mode: 'polling',
          updated_at: 'updated_at',
          overlap_seconds: 0,
        };
        candidate.entities[0].destination.table = 'localembed.article_polling_v2';
        const revision = await applyConfiguration(url, candidate, () =>
          Promise.resolve(), true);
        await backfill(url);
        await drain(worker);
        await buildIndexes(url);
        await sql`UPDATE public.articles SET title = 'Unpolled change'`;
        await drain(worker); // Only the old active trigger revision captured this change.
        await assertRejects(() => activate(url, revision), Error, 'outdated');
        await poller.tick();
        await drain(worker);
        await activate(url, revision);
        const before = await sql`SELECT * FROM localembed.tasks WHERE configuration_id = 1`;
        await sql`UPDATE public.articles SET title = 'Polling active', updated_at = clock_timestamp()`;
        await poller.tick();
        await poller.tick();
        await drain(worker);
        assertEquals(await sql`SELECT * FROM localembed.tasks WHERE configuration_id = 1`, before);
        const next = structuredClone(candidate);
        next.entities[0].destination.table = 'localembed.article_polling_v3';
        const cancelled = await applyConfiguration(url, next, () => Promise.resolve(), true);
        await poller.tick();
        const cursor =
          await sql`SELECT * FROM localembed.polling_state WHERE configuration_id = ${cancelled}`;
        await cancelRevision(url, cancelled);
        await poller.tick();
        assertEquals(
          await sql`SELECT * FROM localembed.polling_state WHERE configuration_id = ${cancelled}`,
          cursor,
        );
        const [active] =
          await sql`SELECT configuration_id FROM localembed.entity_revisions WHERE entity = 'article' AND state = 'active'`;
        assertEquals(active.configuration_id, revision);
      } finally {
        await worker.close();
        await poller.close();
      }
    }),
});
