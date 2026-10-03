import { Worker } from './worker.ts';
const url = Deno.env.get('DATABASE_URL');
if (!url) throw new Error('DATABASE_URL is required');
const worker = new Worker(url);
const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  Deno.addSignalListener(signal, () => shutdown.abort());
}
try {
  while (!shutdown.signal.aborted) {
    if (!await worker.tick()) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
} finally {
  await worker.close();
}
