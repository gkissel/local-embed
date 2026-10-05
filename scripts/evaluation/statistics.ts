/** Nearest-rank percentiles. Empty samples explicitly return null. */
export function summarize(values: number[]) {
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Samples must be finite and nonnegative');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null;
  return {
    count: sorted.length,
    min: sorted.at(0) ?? null,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1) ?? null,
    mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
  };
}
