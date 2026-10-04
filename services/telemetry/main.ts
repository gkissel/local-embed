import { SnapshotMetrics } from './metrics.ts';
import { event } from '../shared/telemetry.ts';
import { observeResources } from '../shared/resources.ts';
import { SnapshotStore } from './snapshot.ts';

const url = Deno.env.get('DATABASE_URL');
if (!url) throw new Error('DATABASE_URL is required');
const interval = Number(Deno.env.get('LOCAL_EMBED_SNAPSHOT_INTERVAL_MS') ?? 15000);
if (!Number.isInteger(interval) || interval < 1000) throw new Error('Invalid snapshot interval');
const store = new SnapshotStore(url);
const metrics = new SnapshotMetrics();
observeResources();
const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  Deno.addSignalListener(signal, () => shutdown.abort());
}
try {
  while (!shutdown.signal.aborted) {
    try {
      metrics.update(await store.load());
    } catch {
      event('snapshot_failed', { service: 'telemetry', error_code: 'snapshot_unavailable' });
    }
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        shutdown.signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, interval);
      shutdown.signal.addEventListener('abort', finish, { once: true });
      if (shutdown.signal.aborted) finish();
    });
  }
} finally {
  await store.close();
}
