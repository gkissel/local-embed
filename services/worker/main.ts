import { Worker } from './worker.ts';
const url = Deno.env.get('DATABASE_URL');
if (!url) throw new Error('DATABASE_URL is required');
const worker = new Worker(url, undefined, {
  leaseSeconds: Number(Deno.env.get('LOCAL_EMBED_LEASE_SECONDS') ?? 60),
  renewEveryMs: Deno.env.has('LOCAL_EMBED_RENEW_EVERY_MS')
    ? Number(Deno.env.get('LOCAL_EMBED_RENEW_EVERY_MS'))
    : undefined,
  maxExecutionMs: Number(Deno.env.get('LOCAL_EMBED_MAX_EXECUTION_MS') ?? 300000),
});
const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  Deno.addSignalListener(signal, () => {
    shutdown.abort();
    worker.abort();
  });
}
try {
  while (!shutdown.signal.aborted) {
    if (!await worker.tick()) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
} finally {
  await worker.close();
}
