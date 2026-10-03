import { assertEquals, assertThrows } from '@std/assert';
import { createHandler } from '../services/api/api.ts';
import example from '../contracts/examples/localembed.v1.example.json' with { type: 'json' };
import type { Configuration } from '../services/admin/apply.ts';

const key = 'a'.repeat(64);
const config = example as Configuration;
const request = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://localhost/v1/embeddings', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

Deno.test('query API authenticates and rejects invalid requests before configuration or inference', async () => {
  let loads = 0;
  const handler = createHandler(key, () => {
    loads++;
    return Promise.resolve(config);
  }, () => Promise.reject(new Error('must not infer')));
  assertEquals(
    (await handler(request({ entity: 'article', input: 'test' }, {
      authorization: 'Bearer wrong',
    }))).status,
    401,
  );
  for (
    const body of [
      null,
      [],
      {},
      { entity: 'bad-name', input: 'x' },
      { entity: 'article', input: '' },
      { entity: 'article', input: 'x'.repeat(32769) },
      { entity: 'article', input: 'x', provider: 'external' },
      { entity: 'article', input: 123 },
    ]
  ) assertEquals((await handler(request(body))).status, 400);
  assertEquals(
    (await handler(request({ entity: 'article', input: 'x' }, {
      'content-type': 'text/plain',
    }))).status,
    400,
  );
  assertEquals(
    (await handler(
      new Request('http://localhost/v1/embeddings', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: '{broken',
      }),
    )).status,
    400,
  );
  const huge = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(262145));
      controller.close();
    },
  });
  assertEquals(
    (await handler(
      new Request('http://localhost/v1/embeddings', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: huge,
      }),
    )).status,
    400,
  );
  assertEquals(loads, 0);
  assertEquals((await handler(new Request('http://localhost/nope'))).status, 404);
  assertEquals((await handler(new Request('http://localhost/v1/embeddings'))).status, 405);
});

Deno.test('query API uses applied entity profile and returns deterministic generation metadata', async () => {
  const vector = Array(768).fill(0);
  vector[0] = 1;
  let calls = 0;
  const handler = createHandler(
    key,
    (entity) => Promise.resolve(entity === 'article' ? config : undefined),
    (provider, text) => {
      assertEquals(provider, config.providers[0]);
      assertEquals(text, 'query: test');
      calls++;
      return Promise.resolve(vector);
    },
  );
  const response = await handler(request({ entity: 'article', input: 'query: test' }));
  assertEquals(response.status, 200);
  const result = await response.json();
  assertEquals(Object.keys(result).sort(), [
    'dimensions',
    'embedding',
    'generation',
    'model',
    'provider',
  ]);
  assertEquals(result.embedding, vector);
  assertEquals(result.dimensions, 768);
  assertEquals(result.provider, config.providers[0].name);
  assertEquals(result.model, config.providers[0].model);
  assertEquals(result.generation.config_version, config.version);
  assertEquals(/^[a-f0-9]{64}$/.test(result.generation.fingerprint), true);
  const repeated = await (await handler(request({ entity: 'article', input: 'query: test' })))
    .json();
  assertEquals(result.generation, repeated.generation);
  assertEquals((await handler(request({ entity: 'unknown', input: 'test' }))).status, 404);
  assertEquals(calls, 2);
});

Deno.test('query API sanitizes failures, validates provider output and bounds ignored cancellation', async () => {
  for (const vector of [[1], Array(768).fill(NaN), Array(768).fill('1')]) {
    const handler = createHandler(
      key,
      () => Promise.resolve(config),
      () => Promise.resolve(vector as number[]),
    );
    assertEquals((await handler(request({ entity: 'article', input: 'test' }))).status, 503);
  }
  const failed = createHandler(key, () => Promise.reject(new Error('database secret')));
  const response = await failed(request({ entity: 'article', input: 'test' }));
  assertEquals(response.status, 503);
  assertEquals((await response.text()).includes('secret'), false);
  let signal: AbortSignal | undefined;
  const blocked = createHandler(key, () => Promise.resolve(config), (_provider, _text, current) => {
    signal = current;
    return new Promise(() => {});
  }, 5);
  assertEquals((await blocked(request({ entity: 'article', input: 'test' }))).status, 503);
  assertEquals(signal?.aborted, true);
  assertThrows(
    () => {
      createHandler('short', () => Promise.resolve(config));
    },
    Error,
    '32 bytes',
  );
});
