import { type Attributes, metrics, SpanStatusCode, trace } from '@opentelemetry/api';

const meter = metrics.getMeter('localembed', '0.1.0');
const tracer = trace.getTracer('localembed', '0.1.0');
const events = meter.createCounter('localembed_events', {
  description: 'Observed lifecycle events',
});
const duration = meter.createHistogram('localembed_duration', {
  unit: 's',
  advice: {
    explicitBucketBoundaries: [
      0.005,
      0.01,
      0.025,
      0.05,
      0.1,
      0.25,
      0.5,
      1,
      2.5,
      5,
      10,
      30,
      60,
      300,
    ],
  },
});

export type EventContext = {
  service: 'worker' | 'query-api' | 'poller' | 'telemetry' | 'admin';
  entity?: string;
  configuration_id?: string | number;
  task_id?: string | number;
  generation?: string | number;
  consumer?: string;
  error_code?: string;
  provider_status?: number;
  status?: number;
  reason?: string;
  phase?: string;
  count?: number;
};
// An explicit allowlist prevents callers from exporting content, vectors, identifiers or secrets.
export function safeContext(value: EventContext): Attributes {
  const result: Attributes = {};
  for (
    const key of [
      'service',
      'entity',
      'configuration_id',
      'task_id',
      'generation',
      'consumer',
      'error_code',
      'provider_status',
      'status',
      'reason',
      'phase',
      'count',
    ] as const
  ) {
    const item = value[key];
    if (typeof item === 'string' || typeof item === 'number') result[key] = item;
  }
  return result;
}
/** Task IDs belong in logs/traces only. Never create a metric series per source/query. */
export function event(name: string, value: EventContext): void {
  if (value.count === 0) return;
  const fields = safeContext(value);
  const labels = Object.fromEntries(
    Object.entries(fields).filter(([key]) =>
      ['service', 'entity', 'error_code', 'status', 'reason', 'phase'].includes(key)
    ),
  );
  events.add(value.count ?? 1, { ...labels, event: name });
  const span = trace.getActiveSpan();
  span?.addEvent(name, fields);
  if (value.error_code) span?.setStatus({ code: SpanStatusCode.ERROR });
  const context = span?.spanContext();
  console.log(
    JSON.stringify({
      event: name,
      ...fields,
      ...(context && trace.isSpanContextValid(context)
        ? { trace_id: context.traceId, span_id: context.spanId }
        : {}),
    }),
  );
}
export function span<T>(
  name: string,
  fields: EventContext,
  operation: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes: safeContext(fields) }, async (active) => {
    const start = performance.now();
    try {
      return await operation();
    } catch (cause) {
      // Exception objects/messages can contain provider bodies or connection strings.
      active.setStatus({ code: SpanStatusCode.ERROR });
      throw cause;
    } finally {
      duration.record((performance.now() - start) / 1000, {
        service: fields.service,
        operation: name,
      });
      active.end();
    }
  });
}
export function gauge(name: string, unit = '') {
  return meter.createObservableGauge(name, { unit });
}
export function observableCounter(name: string) {
  return meter.createObservableCounter(name);
}
