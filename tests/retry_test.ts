import { assertEquals, assertRejects } from '@std/assert';
import {
  attemptLimit,
  classify,
  ProcessingError,
  retryDelay,
  waitRetry,
} from '../services/shared/retry.ts';
import { createHandler } from '../services/api/api.ts';
import type { Configuration } from '../services/admin/apply.ts';
import example from '../contracts/examples/localembed.v1.example.json' with { type: 'json' };

Deno.test('retry classification preserves only safe categories and honors Retry-After forms', () => {
  assertEquals(classify({ statusCode: 401, message: 'secret', responseBody: 'query' }), {
    code: 'provider_terminal',
    retryable: false,
    status: 401,
    retryAfterMs: undefined,
  });
  assertEquals(
    classify({ statusCode: 429, responseHeaders: { 'retry-after': '2' } }).retryAfterMs,
    2000,
  );
  assertEquals(
    classify({
      statusCode: 503,
      responseHeaders: { 'retry-after': 'Thu, 01 Jan 1970 00:00:03 GMT' },
    }, 1000).retryAfterMs,
    2000,
  );
  assertEquals(
    classify({ statusCode: 503, responseHeaders: { 'retry-after': 'bad' } }).retryAfterMs,
    undefined,
  );
  assertEquals(classify({ statusCode: 503 }).retryable, true);
  assertEquals(
    classify({ statusCode: 429, responseHeaders: { 'Retry-After': '2' } }).retryAfterMs,
    2000,
  );
  assertEquals(classify({ statusCode: 501 }).retryable, false);
  assertEquals(classify(new ProcessingError('invalid_embedding')).retryable, false);
  assertEquals(classify({ name: 'TimeoutError' }).retryable, true);
  assertEquals(classify({ isRetryable: true }).retryable, true);
  assertEquals(classify({ code: '40P01' }).code, 'database_transient');
  assertEquals(
    classify({ statusCode: 429, responseHeaders: { 'retry-after': '999999999' } }).retryable,
    false,
  );
  assertEquals(attemptLimit({ max_attempts: 0 }), 1);
  assertEquals(retryDelay(1, { code: 'x', retryable: true }, {}, () => 0), 500);
  assertEquals(retryDelay(100, { code: 'x', retryable: true }, {}, () => 1), 60000);
  assertEquals(
    retryDelay(1, { code: 'x', retryable: true, retryAfterMs: 90000 }, {}, () => 1),
    90000,
  );
});

Deno.test('query retries are bounded by attempts, Retry-After and the shared request deadline', async () => {
  const config = structuredClone(example) as Configuration;
  config.providers[0].dimensions = 3;
  config.operations = { retries: { max_attempts: 3, base_delay_ms: 1, max_delay_ms: 1 } };
  const key = 'c'.repeat(64);
  const request = () =>
    new Request('http://localhost/v1/embeddings', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ entity: 'article', input: 'test' }),
    });
  let calls = 0;
  const handler = createHandler(key, () => Promise.resolve(config), () => {
    if (++calls < 3) return Promise.reject({ statusCode: 503, message: 'secret query' });
    return Promise.resolve([1, 0, 0]);
  }, 1000);
  assertEquals((await handler(request())).status, 200);
  assertEquals(calls, 3);
  calls = 0;
  const exhausted = createHandler(key, () => Promise.resolve(config), () => {
    calls++;
    return Promise.reject({ statusCode: 429, responseHeaders: { 'retry-after': '60' } });
  }, 20);
  assertEquals((await exhausted(request())).status, 503);
  assertEquals(calls, 1);
  calls = 0;
  const limited = createHandler(key, () => Promise.resolve(config), () => {
    calls++;
    return Promise.reject({ statusCode: 503, message: 'secret' });
  }, 1000);
  const failure = await limited(request());
  assertEquals(failure.status, 503);
  assertEquals((await failure.text()).includes('secret'), false);
  assertEquals(calls, 3);
  calls = 0;
  const terminal = createHandler(key, () => Promise.resolve(config), () => {
    calls++;
    return Promise.reject({ statusCode: 403 });
  });
  assertEquals((await terminal(request())).status, 503);
  assertEquals(calls, 1);
  const controller = new AbortController();
  const waiting = waitRetry(60000, controller.signal);
  controller.abort();
  await assertRejects(() => waiting);
});
