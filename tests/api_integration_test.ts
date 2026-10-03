import { assertEquals } from '@std/assert';
import postgres from 'npm:postgres@3.4.7';
import { ConfigurationStore, createHandler } from '../services/api/api.ts';
import example from '../contracts/examples/localembed.v1.example.json' with { type: 'json' };
import type { Configuration } from '../services/admin/apply.ts';

Deno.test({
  name: 'query API loads applied profiles with read-only role and calls compatible provider',
  ignore: Deno.permissions.querySync({ name: 'env', variable: 'TEST_DATABASE_URL' }).state !==
      'granted' || !Deno.env.get('TEST_DATABASE_URL'),
  fn: async () => {
    const url = Deno.env.get('TEST_DATABASE_URL')!;
    const sql = postgres(url, { max: 1 });
    const key = 'b'.repeat(64);
    const previous = Deno.env.get('LOCAL_EMBED_TEST_QUERY_KEY');
    Deno.env.set('LOCAL_EMBED_TEST_QUERY_KEY', 'provider-secret');
    let calls = 0;
    let fail = false;
    const mock = Deno.serve(
      { hostname: '127.0.0.1', port: 0, onListen: () => {} },
      async (request) => {
        assertEquals(new URL(request.url).pathname, '/v1/embeddings');
        assertEquals(request.headers.get('authorization'), 'Bearer provider-secret');
        const body = await request.json();
        assertEquals(body.model, example.providers[0].model);
        assertEquals(body.input, ['query: test']);
        calls++;
        if (fail) return new Response('provider-secret internal failure', { status: 500 });
        return Response.json({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: Array(768).fill(0.5) }],
          model: body.model,
          usage: { prompt_tokens: 2, total_tokens: 2 },
        });
      },
    );
    let store: ConfigurationStore | undefined;
    const send = (handler: (r: Request) => Promise<Response>, entity = 'article') =>
      handler(
        new Request('http://localhost/v1/embeddings', {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ entity, input: 'query: test' }),
        }),
      );
    try {
      await sql.unsafe(
        'DROP SCHEMA IF EXISTS localembed CASCADE; CREATE SCHEMA localembed; CREATE TABLE localembed.configurations(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, configuration jsonb NOT NULL); CREATE ROLE localembed_query_test NOLOGIN; GRANT USAGE ON SCHEMA localembed TO localembed_query_test; GRANT SELECT ON localembed.configurations TO localembed_query_test',
      );
      const config = structuredClone(example) as Configuration;
      config.providers[0].endpoint = `http://127.0.0.1:${mock.addr.port}`;
      config.providers[0].secret_env = 'LOCAL_EMBED_TEST_QUERY_KEY';
      await sql`INSERT INTO localembed.configurations(configuration) VALUES (${
        sql.json(config as unknown as postgres.JSONValue)
      })`;
      const other = structuredClone(config);
      other.entities[0].name = 'other';
      await sql`INSERT INTO localembed.configurations(configuration) VALUES (${
        sql.json(other as unknown as postgres.JSONValue)
      })`;
      const restricted = new URL(url);
      restricted.searchParams.set('options', '-c role=localembed_query_test');
      store = new ConfigurationStore(restricted.toString());
      const handler = createHandler(key, (entity) => store!.load(entity));
      const response = await send(handler);
      assertEquals(response.status, 200);
      const result = await response.json();
      assertEquals(result.dimensions, 768);
      assertEquals(result.embedding.length, 768);
      assertEquals(result.provider, config.providers[0].name);
      assertEquals((await send(handler, 'not_applied')).status, 404);
      assertEquals(calls, 1);
      const newer = structuredClone(config);
      newer.providers[0].name = 'newer_provider';
      newer.entities[0].provider = 'newer_provider';
      await sql`INSERT INTO localembed.configurations(configuration) VALUES (${
        sql.json(newer as unknown as postgres.JSONValue)
      })`;
      const latest = await send(handler);
      assertEquals(latest.status, 200);
      assertEquals((await latest.json()).provider, 'newer_provider');

      fail = true;
      const failed = await send(handler);
      assertEquals(failed.status, 503);
      assertEquals((await failed.text()).includes('provider-secret'), false);
      assertEquals(calls, 3);
      const endpoint = Deno.env.get('TEST_TEI_ENDPOINT');
      if (endpoint) {
        config.providers[0].endpoint = endpoint;
        config.providers[0].secret_env = 'LOCAL_EMBED_TEI_API_KEY';
        await sql`INSERT INTO localembed.configurations(configuration) VALUES (${
          sql.json(config as unknown as postgres.JSONValue)
        })`;
        const real = await send(handler);
        assertEquals(real.status, 200);
        const embedding = (await real.json()).embedding;
        assertEquals(embedding.length, 768);
        assertEquals(embedding.every((n: number) => Number.isFinite(n)), true);
      }
    } finally {
      await store?.close();
      await mock.shutdown();
      if (previous === undefined) Deno.env.delete('LOCAL_EMBED_TEST_QUERY_KEY');
      else Deno.env.set('LOCAL_EMBED_TEST_QUERY_KEY', previous);
      await sql.unsafe(
        'DROP SCHEMA IF EXISTS localembed CASCADE; DROP ROLE IF EXISTS localembed_query_test',
      );
      await sql.end();
    }
  },
});
