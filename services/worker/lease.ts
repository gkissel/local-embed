import type postgres from 'postgres';

/** One execution token; renewals never resurrect an expired reservation. */
export class Lease {
  readonly controller = new AbortController();
  private renewalTimer?: ReturnType<typeof setTimeout>;
  private deadlineTimer: ReturnType<typeof setTimeout>;
  private renewal?: Promise<void>;
  private stopped = false;

  constructor(
    private sql: postgres.Sql,
    private id: string,
    private token: string,
    private leaseSeconds: number,
    private renewEveryMs: number,
    maxExecutionMs: number,
  ) {
    this.deadlineTimer = setTimeout(
      () => this.controller.abort('execution_timeout'),
      maxExecutionMs,
    );
    this.schedule();
  }
  get signal(): AbortSignal {
    return this.controller.signal;
  }
  private schedule(): void {
    if (this.stopped || this.signal.aborted) return;
    this.renewalTimer = setTimeout(() => {
      this.renewal = this.renew().finally(() => this.schedule());
    }, this.renewEveryMs);
  }
  private async renew(): Promise<void> {
    try {
      const rows = await this.sql`UPDATE localembed.tasks
        SET lease_until = LEAST(clock_timestamp() + ${this.leaseSeconds} * interval '1 second', execution_deadline)
        WHERE id = ${this.id} AND lease_token = ${this.token}::uuid AND status = 'processing'
          AND lease_until > clock_timestamp() AND execution_deadline > clock_timestamp()
        RETURNING id`;
      if (!rows.length) this.controller.abort('ownership_lost');
    } catch {
      this.controller.abort('renewal_failed');
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.renewalTimer);
    clearTimeout(this.deadlineTimer);
    await this.renewal;
  }
}

/** Observe cancellation even when an injected provider ignores its AbortSignal. */
export async function cancellable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('Execution cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
