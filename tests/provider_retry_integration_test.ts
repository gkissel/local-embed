import { assertEquals } from '@std/assert';
import { createHandler } from '../services/api/api.ts';
import type { Configuration } from '../services/admin/apply.ts';
import example from '../contracts/examples/localembed.v1.example.json' with { type: 'json' };

Deno.test({
  name:
    'query retry classification handles actual SDK 429 and 503 responses without nested retries',
  ignore: Deno.permissions.querySync({ name: 'net' }).state !== 'granted' ||
    Deno.permissions.querySync({ name: 'env' }).state !== 'granted',
  fn: async () => {
    let calls = 0;
    const server = Deno.serve(
      { hostname: '127.0.0.1', port: 0, onListen: () => {} },
      async (request) => {
        assertEquals(new URL(request.url).pathname, '/v1/embeddings');
        assertEquals(request.headers.get('authorization'), 'Bearer provider-test-secret');
        await request.json();
        calls++;
        if (calls <= 2) {
          return Response.json({ error: { message: 'not persisted', type: 'server_error' } }, {
            status: calls === 1 ? 429 : 503,
            headers: { 'retry-after': '0' },
          });
        }
        return Response.json({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: [1, 0, 0] }],
          model: 'test',
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      },
    );
    const previous = Deno.env.get('LOCAL_EMBED_PROVIDER_RETRY_TEST_KEY');
    Deno.env.set('LOCAL_EMBED_PROVIDER_RETRY_TEST_KEY', 'provider-test-secret');
    try {
      const config = structuredClone(example) as Configuration;
      config.providers[0].dimensions = 3;
      config.providers[0].endpoint = `http://127.0.0.1:${server.addr.port}`;
      config.providers[0].secret_env = 'LOCAL_EMBED_PROVIDER_RETRY_TEST_KEY';
      config.operations = { retries: { max_attempts: 3, base_delay_ms: 1, max_delay_ms: 1 } };
      const key = 'd'.repeat(64);
      const handler = createHandler(key, () => Promise.resolve(config));
      const response = await handler(
        new Request('http://localhost/v1/embeddings', {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ entity: 'article', input: 'query: test' }),
        }),
      );
      assertEquals(response.status, 200);
      assertEquals((await response.json()).embedding, [1, 0, 0]);
      assertEquals(calls, 3);
    } finally {
      await server.shutdown();
      if (previous === undefined) Deno.env.delete('LOCAL_EMBED_PROVIDER_RETRY_TEST_KEY');
      else Deno.env.set('LOCAL_EMBED_PROVIDER_RETRY_TEST_KEY', previous);
    }
  },
});
