import { assertEquals, assertRejects } from '@std/assert';
import postgres from 'npm:postgres@3.4.7';
import { applyConfiguration } from '../services/admin/apply.ts';
import { backfill, buildIndexes, prepareWorker } from '../services/admin/synchronize.ts';
import { type Generate, generate, Worker } from '../services/worker/worker.ts';
import example from '../contracts/examples/localembed.v1.example.json' with { type: 'json' };

Deno.test({
  name: 'backfill, concurrent workers, fingerprint, stale inference, deletes, leases and HNSW',
  ignore: Deno.permissions.querySync({ name: 'env', variable: 'TEST_DATABASE_URL' }).state !==
      'granted' || !Deno.env.get('TEST_DATABASE_URL'),
  fn: async () => {
    const url = Deno.env.get('TEST_DATABASE_URL')!;
    const sql = postgres(url, { max: 1 });
    let calls = 0;
    let changeDuringInference = false;
    const realEndpoint = Deno.env.get('TEST_TEI_ENDPOINT');
    const config = structuredClone(example);
    if (realEndpoint) {
      config.providers[0].endpoint = realEndpoint;
      config.entities[0].template = 'passage: ' + config.entities[0].template;
    }
    const inference: Generate = async (provider, text) => {
      calls++;
      if (changeDuringInference) {
        changeDuringInference = false;
        await sql`UPDATE public.articles SET title = 'Changed during inference'`;
      }
      if (realEndpoint) return await generate(provider, text);
      return Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0);
    };
    const workers = [new Worker(url, inference), new Worker(url, inference)];
    const drain = async () => {
      while ((await Promise.all(workers.map((w) => w.tick()))).some(Boolean)) { /* drain */ }
    };
    try {
      await sql.unsafe(
        'CREATE EXTENSION IF NOT EXISTS vector; DROP SCHEMA IF EXISTS localembed CASCADE; DROP TABLE IF EXISTS public.articles; CREATE TABLE public.articles(id uuid PRIMARY KEY, title text, body text)',
      );
      await sql`INSERT INTO public.articles VALUES ('00000000-0000-0000-0000-000000000001', 'Initial', 'Body')`;
      await applyConfiguration(url, config, realEndpoint ? undefined : () => Promise.resolve());
      await sql`UPDATE localembed.configurations SET configuration = to_jsonb(configuration::text)`;
      await prepareWorker(url);
      const [upgraded] =
        await sql`SELECT jsonb_typeof(configuration) AS type FROM localembed.configurations`;
      assertEquals(upgraded.type, 'object');
      await backfill(url);
      await backfill(url);
      const [taskCount] = await sql`SELECT count(*)::int AS count FROM localembed.tasks`;
      assertEquals(taskCount.count, 1);
      await assertRejects(() => buildIndexes(url), Error, 'process all queued tasks');
      await drain();
      assertEquals(calls, 1);
      const [initial] =
        await sql`SELECT fingerprint, vector_dims(embedding) AS dimensions FROM localembed.article_embeddings`;
      assertEquals(initial.dimensions, 768);
      await sql`UPDATE public.articles SET title = title`;
      await drain();
      assertEquals(calls, 1);
      await sql`UPDATE public.articles SET title = 'Changed'`;
      changeDuringInference = true;
      await drain();
      const [updated] = await sql`SELECT fingerprint FROM localembed.article_embeddings`;
      assertEquals(updated.fingerprint === initial.fingerprint, false);
      await buildIndexes(url);
      await buildIndexes(url);
      const indexes =
        await sql`SELECT 1 FROM pg_indexes WHERE schemaname = 'localembed' AND indexdef LIKE '%USING hnsw%'`;
      assertEquals(indexes.length, 1);
      await sql`UPDATE localembed.tasks SET status = 'processing', lease_until = now() - interval '1 second' WHERE id = 1`;
      await drain();
      const [recovered] = await sql`SELECT status, attempts FROM localembed.tasks WHERE id = 1`;
      assertEquals(recovered.status, 'done');
      assertEquals(recovered.attempts, 2);
      await sql`DELETE FROM public.articles`;
      await drain();
      const rows = await sql`SELECT * FROM localembed.article_embeddings`;
      assertEquals(rows.length, 0);
      const failed = await sql`SELECT * FROM localembed.tasks WHERE status <> 'done'`;
      assertEquals(failed.length, 0);
    } finally {
      await Promise.all(workers.map((w) => w.close()));
      await sql.unsafe(
        'DROP SCHEMA IF EXISTS localembed CASCADE; DROP TABLE IF EXISTS public.articles',
      );
      await sql.end();
    }
  },
});

Deno.test({
  name: 'TEI inference uses the OpenAI-compatible SDK endpoint',
  ignore: Deno.permissions.querySync({ name: 'net' }).state !== 'granted' ||
    Deno.permissions.querySync({ name: 'env' }).state !== 'granted',
  fn: async () => {
    const { generate } = await import('../services/worker/worker.ts');
    const requests: {
      path: string;
      authorization: string | null;
      body: Record<string, unknown>;
    }[] = [];
    const server = Deno.serve(
      { hostname: '127.0.0.1', port: 0, onListen: () => {} },
      async (request) => {
        requests.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get('authorization'),
          body: await request.json(),
        });
        return Response.json({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: [1, 2, 3] }],
          model: 'test',
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      },
    );
    const previous = Deno.env.get('LOCAL_EMBED_TEST_KEY');
    Deno.env.set('LOCAL_EMBED_TEST_KEY', 'test-secret');
    try {
      const vector = await generate({
        ...example.providers[0],
        type: 'tei',
        metric: 'cosine',
        dimensions: 3,
        endpoint: `http://127.0.0.1:${server.addr.port}`,
        secret_env: 'LOCAL_EMBED_TEST_KEY',
      }, 'passage: Test');
      assertEquals(vector, [1, 2, 3]);
      assertEquals(requests[0].path, '/v1/embeddings');
      assertEquals(requests[0].authorization, 'Bearer test-secret');
      assertEquals(requests[0].body.model, 'intfloat/multilingual-e5-base');
      assertEquals(requests[0].body.input, ['passage: Test']);
    } finally {
      if (previous === undefined) Deno.env.delete('LOCAL_EMBED_TEST_KEY');
      else Deno.env.set('LOCAL_EMBED_TEST_KEY', previous);
      await server.shutdown();
    }
  },
});

Deno.test({
  name: 'backfill orders bigint keys numerically across durable batches',
  ignore: Deno.permissions.querySync({ name: 'env', variable: 'TEST_DATABASE_URL' }).state !==
      'granted' || !Deno.env.get('TEST_DATABASE_URL'),
  fn: async () => {
    const url = Deno.env.get('TEST_DATABASE_URL')!;
    const sql = postgres(url, { max: 1 });
    try {
      await sql.unsafe(
        "CREATE EXTENSION IF NOT EXISTS vector; DROP SCHEMA IF EXISTS localembed CASCADE; DROP TABLE IF EXISTS public.\"Articles\"; CREATE TABLE public.\"Articles\" (id bigint PRIMARY KEY, title text, body text); INSERT INTO public.\"Articles\" VALUES (1, 'One', ''), (2, 'Two', ''), (10, 'Ten', '')",
      );
      const config = structuredClone(example);
      const entity = {
        ...config.entities[0],
        source: {
          ...config.entities[0].source,
          table: 'public.Articles',
          id: { column: 'id', type: 'bigint' },
        },
      };
      const numeric = {
        ...config,
        entities: [entity],
        operations: { ...config.operations, backfill: { batch_size: 2 } },
      };
      await applyConfiguration(url, numeric, () => Promise.resolve());
      await backfill(url);
      await backfill(url);
      const tasks = await sql`SELECT source_id FROM localembed.tasks ORDER BY id`;
      assertEquals(tasks.map((t) => t.source_id), ['1', '2', '10']);
      const [state] = await sql`SELECT cursor, complete FROM localembed.backfills`;
      assertEquals(state.cursor, '10');
      assertEquals(state.complete, true);
    } finally {
      await sql.unsafe(
        'DROP SCHEMA IF EXISTS localembed CASCADE; DROP TABLE IF EXISTS public."Articles"',
      );
      await sql.end();
    }
  },
});
