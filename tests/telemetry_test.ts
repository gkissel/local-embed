import { assertEquals, assertFalse } from '@std/assert';
import { event, type EventContext, safeContext } from '../services/shared/telemetry.ts';
import { createHandler } from '../services/api/api.ts';

Deno.test('telemetry rejects extra sensitive fields and authentication logs omit credentials', async () => {
  const malicious = {
    service: 'worker',
    task_id: '42',
    entity: 'article',
    input: 'private text',
    embedding: [1, 2, 3],
    secret: 'secret',
    source_id: 'private identifier',
  } as EventContext;
  assertEquals(safeContext(malicious), { service: 'worker', task_id: '42', entity: 'article' });
  const records: string[] = [];
  const original = console.log;
  console.log = (value) => records.push(String(value));
  try {
    event('task_failed', malicious);
    const handler = createHandler('a'.repeat(64), () => Promise.reject(new Error('must not load')));
    const response = await handler(
      new Request('http://localhost/v1/embeddings?secret=private-url', {
        method: 'POST',
        headers: { authorization: 'Bearer secret-credential' },
        body: 'private body',
      }),
    );
    assertEquals(response.status, 401);
    assertEquals(JSON.parse(records[1]).event, 'authorization_rejected');
    for (const sensitive of ['private', 'secret', 'embedding', 'source_id']) {
      assertFalse(records.join('\n').includes(sensitive));
    }
  } finally {
    console.log = original;
  }
});
