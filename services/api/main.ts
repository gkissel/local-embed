import { event } from '../shared/telemetry.ts';
import { observeResources } from '../shared/resources.ts';
import { ConfigurationStore, createHandler } from './api.ts';
observeResources();
const url = Deno.env.get('DATABASE_URL');
const key = Deno.env.get('LOCAL_EMBED_SERVICE_KEY');
if (!url || !key) throw new Error('DATABASE_URL and LOCAL_EMBED_SERVICE_KEY are required');
const port = Number(Deno.env.get('LOCAL_EMBED_API_PORT') ?? 8090);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid API port');
const store = new ConfigurationStore(url);
try {
  const handler = createHandler(key, (entity) => store.load(entity));
  const server = Deno.serve({
    hostname: Deno.env.get('LOCAL_EMBED_API_HOST') ?? '127.0.0.1',
    port,
    onError: () => {
      event('request_failed', { service: 'query-api', error_code: 'request_unavailable' });
      return new Response(null, { status: 503 });
    },
  }, handler);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    Deno.addSignalListener(signal, () => {
      server.shutdown().catch(() => {});
    });
  }
  await server.finished;
} catch {
  event('service_failed', { service: 'query-api', error_code: 'service_unavailable' });
  Deno.exitCode = 1;
} finally {
  await store.close();
}
