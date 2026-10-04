import { assert, assertEquals } from '@std/assert';
import postgres from 'npm:postgres@3.4.7';
import { applyConfiguration, type Configuration } from '../services/admin/apply.ts';
import { prepareWorker } from '../services/admin/synchronize.ts';
import {
  fingerprint,
  type Generate,
  render,
  Worker,
  type WorkerOptions,
} from '../services/worker/worker.ts';
import example from '../contracts/examples/localembed.v1.example.json' with { type: 'json' };

const enabled =
  Deno.permissions.querySync({ name: 'env', variable: 'TEST_DATABASE_URL' }).state === 'granted' &&
  !!Deno.env.get('TEST_DATABASE_URL');
const vector = (value = 1) => Array.from({ length: 768 }, (_, i) => i === 0 ? value : 0);
async function until(check: () => boolean | Promise<boolean>, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for test condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
type Fixture = {
  sql: ReturnType<typeof postgres>;
  config: Configuration;
  worker: (inference: Generate, options?: WorkerOptions, url?: string) => Worker;
};
async function fixture(run: (context: Fixture) => Promise<void>): Promise<void> {
  const url = Deno.env.get('TEST_DATABASE_URL')!;
  const sql = postgres(url, { max: 3, onnotice: () => {} });
  const workers: Worker[] = [];
  try {
    await sql.unsafe(
      'CREATE EXTENSION IF NOT EXISTS vector; DROP SCHEMA IF EXISTS localembed CASCADE; DROP TABLE IF EXISTS public.articles; CREATE TABLE public.articles(id bigint PRIMARY KEY, title text, body text, views integer DEFAULT 0)',
    );
    const config = structuredClone(example) as Configuration;
    config.entities[0].source.id.type = 'bigint';
    await applyConfiguration(url, config, () => Promise.resolve());
    await run({
      sql,
      config,
      worker: (inference, options, workerUrl = url) => {
        const worker = new Worker(workerUrl, inference, options);
        workers.push(worker);
        return worker;
      },
    });
  } finally {
    await Promise.all(workers.map((worker) => worker.close()));
    await sql.unsafe(
      'DROP SCHEMA IF EXISTS localembed CASCADE; DROP TABLE IF EXISTS public.articles',
    );
    await sql.end();
  }
}

Deno.test({
  name: 'irrelevant updates are filtered, bursts coalesce and distinct identifiers remain parallel',
  ignore: !enabled,
  fn: () =>
    fixture(async ({ sql, worker }) => {
      await sql`INSERT INTO public.articles(id,title,body) VALUES (1, 'Initial', 'Body')`;
      await sql.begin(async (tx) => {
        for (let i = 0; i < 50; i++) await tx`UPDATE public.articles SET views = views + 1`;
        for (let i = 0; i < 50; i++) await tx`UPDATE public.articles SET title = title`;
      });
      const [unchanged] = await sql`SELECT generation FROM localembed.tasks`;
      assertEquals(Number(unchanged.generation), 1);
      await sql.begin(async (tx) => {
        for (let i = 0; i < 20; i++) await tx`UPDATE public.articles SET title = ${'Change ' + i}`;
      });
      const tasks = await sql`SELECT generation FROM localembed.tasks`;
      assertEquals(tasks.length, 1);
      assertEquals(Number(tasks[0].generation), 21);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let calls = 0;
      const inference: Generate = async (_, text) => {
        calls++;
        if (!text.includes('Second')) {
          entered.resolve();
          await release.promise;
        }
        return vector();
      };
      const first = worker(inference);
      const second = worker(inference);
      const third = worker(inference);
      const running = first.tick();
      await entered.promise;
      assertEquals(await Promise.all([second.tick(), third.tick()]), [false, false]);
      assertEquals(calls, 1);
      await sql`INSERT INTO public.articles(id,title,body) VALUES (2, 'Second', 'Body')`;
      assertEquals(await second.tick(), true);
      assertEquals(calls, 2);
      release.resolve();
      await running;
      assertEquals((await sql`SELECT * FROM localembed.article_embeddings`).length, 2);
      console.log(
        JSON.stringify({
          workload: '50 unrelated updates + 50 no-op updates + 20 content updates + initial insert',
          captured_changes: 21,
          queue_rows_for_first_identifier: 1,
          inference_calls_for_first_identifier: 1,
        }),
      );
    }),
});

Deno.test({
  name:
    'changes during failed inference remain pending and deletion/reinsertion and ID changes converge',
  ignore: !enabled,
  fn: () =>
    fixture(async ({ sql, config, worker }) => {
      await sql`INSERT INTO public.articles(id,title,body) VALUES (1, 'Before', 'Body')`;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const old = worker(async () => {
        entered.resolve();
        await release.promise;
        throw new Error('provider failure');
      });
      const running = old.tick();
      await entered.promise;
      await sql`UPDATE public.articles SET title = 'After'`;
      release.resolve();
      await running;
      const [pending] = await sql`SELECT status, generation FROM localembed.tasks`;
      assertEquals(pending.status, 'pending');
      assertEquals(Number(pending.generation), 2);
      const ready = worker(() => Promise.resolve(vector()));
      await ready.tick();
      const [row] = await sql`SELECT * FROM public.articles`;
      const [stored] = await sql`SELECT fingerprint FROM localembed.article_embeddings`;
      assertEquals(
        stored.fingerprint,
        await fingerprint(config.entities[0], config.providers[0], render(config.entities[0], row)),
      );

      await sql`UPDATE public.articles SET title = 'Before deletion'`;
      const deleting = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const duringDeletion = worker(async () => {
        deleting.resolve();
        await resume.promise;
        return vector(2);
      });
      const processing = duringDeletion.tick();
      await deleting.promise;
      await sql.begin(async (tx) => {
        await tx`DELETE FROM public.articles WHERE id = 1`;
        await tx`INSERT INTO public.articles(id,title,body) VALUES (1, 'Reinserted', 'Body')`;
      });
      resume.resolve();
      await processing;
      const [afterDeletion] = await sql`SELECT status FROM localembed.tasks`;
      assertEquals(afterDeletion.status, 'pending');
      await ready.tick();
      await sql`UPDATE public.articles SET id = 3`;
      while (await ready.tick()) { /* drain old-key deletion and new-key generation */ }
      const destinations =
        await sql`SELECT source_id::text AS source_id FROM localembed.article_embeddings`;
      assertEquals(destinations.map((r) => r.source_id), ['3']);
      const states =
        await sql`SELECT generation, processed_generation, status FROM localembed.tasks`;
      assert(states.every((t) => t.status === 'done' && t.generation === t.processed_generation));
    }),
});

Deno.test({
  name: 'renewal keeps a slow inference exclusively reserved beyond the initial lease',
  ignore: !enabled,
  fn: () =>
    fixture(async ({ sql, worker }) => {
      await sql`INSERT INTO public.articles(id,title,body) VALUES (1, 'Slow', 'Body')`;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let calls = 0;
      const slow = worker(async () => {
        calls++;
        entered.resolve();
        await release.promise;
        return vector();
      }, { leaseSeconds: 0.4, renewEveryMs: 70, maxExecutionMs: 5000 });
      const competitor = worker(() => {
        calls++;
        return Promise.resolve(vector(2));
      });
      const running = slow.tick();
      await entered.promise;
      const [initial] = await sql`SELECT lease_until, lease_token FROM localembed.tasks`;
      await until(() => Date.now() > initial.lease_until.getTime() + 50);
      const [renewed] = await sql`SELECT lease_until, lease_token FROM localembed.tasks`;
      assert(renewed.lease_until.getTime() > initial.lease_until.getTime());
      assertEquals(renewed.lease_token, initial.lease_token);
      assertEquals(await competitor.tick(), false);
      assertEquals(calls, 1);
      release.resolve();
      await running;
      assertEquals((await sql`SELECT status FROM localembed.tasks`)[0].status, 'done');
    }),
});

Deno.test({
  name:
    'expired ownership cancels old inference and its late response cannot overwrite a replacement',
  ignore: !enabled,
  fn: () =>
    fixture(async ({ sql, worker }) => {
      await sql`INSERT INTO public.articles(id,title,body) VALUES (1, 'Source', 'Body')`;
      const entered = Promise.withResolvers<void>();
      const lateResponse = Promise.withResolvers<number[]>();
      let oldSignal: AbortSignal | undefined;
      const old = worker((_, __, signal) => {
        oldSignal = signal;
        entered.resolve();
        return lateResponse.promise;
      }, { leaseSeconds: 1, renewEveryMs: 50, maxExecutionMs: 5000 });
      const running = old.tick();
      await entered.promise;
      const [original] = await sql`SELECT lease_token FROM localembed.tasks`;
      await sql`UPDATE localembed.tasks SET lease_until = clock_timestamp() - interval '1 second'`;
      const replacement = worker(() => Promise.resolve(vector(2)));
      await replacement.tick();
      await until(() => !!oldSignal?.aborted);
      await running;
      lateResponse.resolve(vector(1));
      const [stored] =
        await sql`SELECT embedding::text AS embedding FROM localembed.article_embeddings`;
      assertEquals(JSON.parse(stored.embedding)[0], 2);
      const [task] = await sql`SELECT status, lease_token FROM localembed.tasks`;
      assertEquals(task.status, 'done');
      assertEquals(task.lease_token, null);
      assert(original.lease_token);
    }),
});

Deno.test({
  name:
    'maximum execution duration and renewal failure release work without accepting stale vectors',
  ignore: !enabled,
  fn: () =>
    fixture(async ({ sql, worker }) => {
      await sql`INSERT INTO public.articles(id,title,body) VALUES (1, 'Never completes', 'Body')`;
      let signal: AbortSignal | undefined;
      const deadline = worker((_, __, currentSignal) => {
        signal = currentSignal;
        return new Promise(() => {});
      }, { leaseSeconds: 0.5, renewEveryMs: 50, maxExecutionMs: 200 });
      await deadline.tick();
      assert(signal?.aborted);
      assertEquals((await sql`SELECT status FROM localembed.tasks`)[0].status, 'pending');
      assertEquals((await sql`SELECT * FROM localembed.article_embeddings`).length, 0);

      await sql.unsafe(
        `CREATE FUNCTION localembed.reject_renewal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated renewal failure'; END $$;
    CREATE TRIGGER reject_renewal BEFORE UPDATE OF lease_until ON localembed.tasks
    FOR EACH ROW WHEN (OLD.lease_token = NEW.lease_token AND NEW.lease_until > OLD.lease_until)
    EXECUTE FUNCTION localembed.reject_renewal()`,
      );
      const failing = worker((_, __, currentSignal) => {
        signal = currentSignal;
        return new Promise(() => {});
      }, { leaseSeconds: 1, renewEveryMs: 50, maxExecutionMs: 5000 });
      await failing.tick();
      assertEquals(signal?.reason, 'renewal_failed');
      assertEquals((await sql`SELECT status FROM localembed.tasks`)[0].status, 'pending');
      await sql.unsafe('DROP TRIGGER reject_renewal ON localembed.tasks');
      const recovered = worker(() => Promise.resolve(vector()));
      await recovered.tick();
      assertEquals((await sql`SELECT status FROM localembed.tasks`)[0].status, 'done');
    }),
});

Deno.test({
  name: 'legacy queue migration folds duplicates, preserves failures and fences old attempts',
  ignore: !enabled,
  fn: () =>
    fixture(async ({ sql }) => {
      await sql.unsafe('DROP INDEX localembed.tasks_key');
      await sql`INSERT INTO localembed.tasks(configuration_id,entity,source_id,operation,status,attempts,last_error) VALUES
    (1,'article','1','upsert','pending',1,NULL),
    (1,'article','1','upsert','processing',2,NULL),
    (1,'article','2','upsert','failed',5,'processing failed'),
    (1,'article','3','upsert','done',1,NULL)`;
      await prepareWorker(Deno.env.get('TEST_DATABASE_URL')!);
      const folded =
        await sql`SELECT source_id, generation, processed_generation, status, attempts, last_error FROM localembed.tasks ORDER BY source_id`;
      assertEquals(folded.length, 3);
      assertEquals(folded[0].status, 'pending');
      assertEquals(Number(folded[0].generation), 2);
      assertEquals(folded[0].attempts, 3);
      assertEquals(folded[1].status, 'failed');
      assertEquals(folded[1].last_error, 'processing failed');
      assertEquals(folded[2].generation, folded[2].processed_generation);
      await prepareWorker(Deno.env.get('TEST_DATABASE_URL')!);
      assertEquals(
        await sql`SELECT source_id, generation, processed_generation, status, attempts, last_error FROM localembed.tasks ORDER BY source_id`,
        folded,
      );
      await sql`INSERT INTO public.articles(id,title,body) VALUES (1,'New after migration','Body')`;
      const [captured] = await sql`SELECT generation FROM localembed.tasks WHERE source_id = '1'`;
      assertEquals(Number(captured.generation), 3);
      await sql`INSERT INTO public.articles(id,title,body) VALUES (2,'Changed failed source','Body')`;
      const [stillFailed] =
        await sql`SELECT status, last_error, generation FROM localembed.tasks WHERE source_id = '2'`;
      assertEquals(stillFailed.status, 'failed');
      assertEquals(stillFailed.last_error, 'processing failed');
      assertEquals(Number(stillFailed.generation), 2);
    }),
});

Deno.test({
  name: 'a source writer and final worker write use compatible lock ordering',
  ignore: !enabled,
  fn: () =>
    fixture(async ({ sql, config, worker }) => {
      await sql`INSERT INTO public.articles(id,title,body) VALUES (1,'Before concurrent write','Body')`;
      const entered = Promise.withResolvers<void>();
      const releaseInference = Promise.withResolvers<void>();
      const sourceLocked = Promise.withResolvers<void>();
      const allowUpdate = Promise.withResolvers<void>();
      const first = worker(async () => {
        entered.resolve();
        await releaseInference.promise;
        return vector();
      });
      const processing = first.tick();
      await entered.promise;
      const writer = sql.begin(async (tx) => {
        await tx`SELECT id FROM public.articles WHERE id = 1 FOR UPDATE`;
        sourceLocked.resolve();
        await allowUpdate.promise;
        await tx`UPDATE public.articles SET title = 'After concurrent write' WHERE id = 1`;
      });
      try {
        await sourceLocked.promise;
        releaseInference.resolve();
        await until(async () => {
          const waiting =
            await sql`SELECT 1 FROM pg_stat_activity WHERE query LIKE '%lock_source_article%' AND wait_event_type = 'Lock'`;
          return waiting.length > 0;
        });
        allowUpdate.resolve();
        await writer;
        await processing;
        const [pending] = await sql`SELECT status FROM localembed.tasks`;
        assertEquals(pending.status, 'pending');
        const current = worker(() => Promise.resolve(vector()));
        await current.tick();
        const [row] = await sql`SELECT * FROM public.articles`;
        const [stored] = await sql`SELECT fingerprint FROM localembed.article_embeddings`;
        assertEquals(
          stored.fingerprint,
          await fingerprint(
            config.entities[0],
            config.providers[0],
            render(config.entities[0], row),
          ),
        );
      } finally {
        allowUpdate.resolve();
        releaseInference.resolve();
        await writer;
        await processing;
      }
    }),
});

Deno.test({
  name: 'a restricted worker writes embeddings with SELECT-only access to the source',
  ignore: !enabled,
  fn: () =>
    fixture(async ({ sql, worker }) => {
      await sql.unsafe(`CREATE ROLE localembed_test_worker LOGIN PASSWORD 'test-worker-only';
      GRANT USAGE ON SCHEMA public, localembed TO localembed_test_worker;
      GRANT SELECT ON public.articles, localembed.configurations, localembed.entity_revisions TO localembed_test_worker;
      GRANT EXECUTE ON FUNCTION localembed.revision_eligible(bigint, text) TO localembed_test_worker;
      GRANT SELECT, UPDATE ON localembed.tasks TO localembed_test_worker;
      GRANT SELECT, INSERT, UPDATE, DELETE ON localembed.article_embeddings TO localembed_test_worker;
      GRANT EXECUTE ON FUNCTION localembed.lock_source_article(text) TO localembed_test_worker`);
      const url = new URL(Deno.env.get('TEST_DATABASE_URL')!);
      url.username = 'localembed_test_worker';
      url.password = 'test-worker-only';
      const restricted = worker(() => Promise.resolve(vector()), undefined, url.href);
      try {
        const [privileges] =
          await sql`SELECT has_table_privilege('localembed_test_worker', 'public.articles', 'UPDATE') AS can_update`;
        assertEquals(privileges.can_update, false);
        await sql`INSERT INTO public.articles(id,title,body) VALUES (1,'Restricted worker','Body')`;
        await restricted.tick();
        assertEquals((await sql`SELECT status FROM localembed.tasks`)[0].status, 'done');
        assertEquals((await sql`SELECT * FROM localembed.article_embeddings`).length, 1);
        await sql`UPDATE public.articles SET title = 'Updated source'`;
        await restricted.tick();
        assertEquals((await sql`SELECT status FROM localembed.tasks`)[0].status, 'done');
        await sql`DELETE FROM public.articles`;
        await restricted.tick();
        assertEquals((await sql`SELECT * FROM localembed.article_embeddings`).length, 0);
      } finally {
        await restricted.close();
        await sql.unsafe('DROP OWNED BY localembed_test_worker; DROP ROLE localembed_test_worker');
      }
    }),
});

Deno.test({
  name:
    'concurrent source commits preserve generations and a hot identifier does not jump the queue',
  ignore: !enabled,
  fn: () =>
    fixture(async ({ sql, worker }) => {
      await sql`INSERT INTO public.articles(id,title,body) VALUES (1,'One','Body')`;
      await sql`INSERT INTO public.articles(id,title,body) VALUES (2,'Two','Body')`;
      await Promise.all(Array.from({ length: 20 }, () =>
        sql`UPDATE public.articles SET title = title || '.' WHERE id = 1`));
      const tasks =
        await sql`SELECT source_id, generation FROM localembed.tasks ORDER BY source_id`;
      assertEquals(tasks.length, 2);
      assertEquals(Number(tasks[0].generation), 21);
      assertEquals(Number(tasks[1].generation), 1);
      const [source] = await sql`SELECT title FROM public.articles WHERE id = 1`;
      assertEquals(source.title, 'One' + '.'.repeat(20));
      const requests: string[] = [];
      const consumer = worker((_, text) => {
        requests.push(text);
        return Promise.resolve(vector());
      });
      await consumer.tick();
      assert(requests[0].includes('Two'));
      const [first] =
        await sql`SELECT source_id::text AS source_id FROM localembed.article_embeddings`;
      assertEquals(first.source_id, '2');
      await consumer.tick();
      assertEquals(requests.length, 2);
      assertEquals((await sql`SELECT * FROM localembed.article_embeddings`).length, 2);
    }),
});

Deno.test({
  name:
    'locking reads select the requested text identifier even when the key column is named identifier',
  ignore: !enabled,
  fn: () =>
    fixture(async ({ sql, config }) => {
      await sql.unsafe(
        'CREATE TABLE public.custom_keys(identifier text PRIMARY KEY, title text, body text)',
      );
      try {
        const entity = {
          ...config.entities[0],
          name: 'custom',
          source: {
            ...config.entities[0].source,
            table: 'public.custom_keys',
            id: { column: 'identifier', type: 'text' },
          },
          destination: { table: 'localembed.custom_embeddings' },
        };
        await applyConfiguration(Deno.env.get('TEST_DATABASE_URL')!, {
          ...config,
          entities: [entity],
        }, () => Promise.resolve());
        await sql`INSERT INTO public.custom_keys VALUES ('one','First','Body'), ('two','Second','Body')`;
        const selected = await sql`SELECT identifier FROM localembed.lock_source_custom('two')`;
        assertEquals(selected.map((row) => row.identifier), ['two']);
      } finally {
        await sql.unsafe('DROP TABLE public.custom_keys CASCADE');
      }
    }),
});
