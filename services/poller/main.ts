import { Poller } from './poller.ts';
const url = Deno.env.get('DATABASE_URL');
if (!url) throw new Error('DATABASE_URL is required');
const interval = Number(Deno.env.get('LOCAL_EMBED_POLL_INTERVAL_MS') ?? 1000);
if (!Number.isFinite(interval) || interval <= 0) throw new Error('Invalid polling interval');
const poller = new Poller(url, Number(Deno.env.get('LOCAL_EMBED_POLL_BATCH_SIZE') ?? 100));
const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  Deno.addSignalListener(signal, () => shutdown.abort());
}
try {
  while (!shutdown.signal.aborted) {
    await poller.tick();
    if (shutdown.signal.aborted) break;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        shutdown.signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, interval);
      shutdown.signal.addEventListener('abort', finish, { once: true });
    });
  }
} finally {
  await poller.close();
}
