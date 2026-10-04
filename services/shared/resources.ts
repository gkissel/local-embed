import { cpuUsage } from 'node:process';
import { gauge } from './telemetry.ts';
/** Called once by each service entry point; callbacks do not open ports or timers. */
export function observeResources(): void {
  gauge('localembed_process_memory', 'By').addCallback((result) => {
    const memory = Deno.memoryUsage();
    result.observe(memory.rss, { kind: 'rss' });
    result.observe(memory.heapUsed, { kind: 'heap_used' });
  });
  gauge('localembed_process_cpu', 's').addCallback((result) => {
    const usage = cpuUsage();
    result.observe((usage.user + usage.system) / 1e6);
  });
}
