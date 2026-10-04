export type RetryPolicy = { max_attempts?: number; base_delay_ms?: number; max_delay_ms?: number };
export type Failure = { code: string; retryable: boolean; status?: number; retryAfterMs?: number };
export class ProcessingError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
/** Preserve only known categories/statuses, never provider messages, payloads or URLs. */
export function classify(error: unknown, now = Date.now()): Failure {
  if (error instanceof ProcessingError) return { code: error.code, retryable: false };
  const item = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const status = typeof item.statusCode === 'number' && Number.isInteger(item.statusCode) &&
      item.statusCode >= 100 && item.statusCode <= 599
    ? item.statusCode
    : undefined;
  const headers = item.responseHeaders as Record<string, string> | undefined;
  const raw = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'retry-after')
    ?.[1];
  let retryAfterMs: number | undefined;
  if (typeof raw === 'string') {
    const parsed = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - now;
    if (Number.isFinite(parsed) && parsed >= 0) retryAfterMs = parsed;
  }
  if (retryAfterMs !== undefined && retryAfterMs > 604800000) {
    return { code: 'retry_after_exceeds_limit', retryable: false, status };
  }
  if (status !== undefined) {
    const retryable = [408, 425, 429, 500, 502, 503, 504].includes(status);
    return {
      code: status === 429
        ? 'rate_limited'
        : retryable
        ? 'provider_transient'
        : 'provider_terminal',
      retryable,
      status,
      retryAfterMs,
    };
  }
  if (['40001', '40P01', '55P03', '57014', '53300'].includes(String(item.code))) {
    return { code: 'database_transient', retryable: true };
  }
  if (item.name === 'TimeoutError' || item.name === 'AbortError') {
    return { code: 'provider_timeout', retryable: true };
  }
  if (item.isRetryable === true || error instanceof TypeError) {
    return { code: 'provider_transport', retryable: true };
  }
  return { code: 'processing_terminal', retryable: false };
}
export const attemptLimit = (policy: RetryPolicy = {}): number =>
  Math.max(1, policy.max_attempts ?? 5);
export function retryDelay(
  attempt: number,
  failure: Failure,
  policy: RetryPolicy = {},
  random = Math.random,
): number {
  const base = policy.base_delay_ms ?? 1000;
  const cap = policy.max_delay_ms ?? 60000;
  const exponential = Math.min(cap, base * 2 ** Math.min(attempt - 1, 30));
  const jitter = exponential * (0.5 + 0.5 * random());
  // Retry-After is a lower bound, not truncated to the local backoff cap.
  return Math.max(Math.ceil(jitter), Math.ceil(failure.retryAfterMs ?? 0));
}
export function waitRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new Error('cancelled'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
