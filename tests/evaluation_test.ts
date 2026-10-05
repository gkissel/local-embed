import { assertEquals, assertThrows } from '@std/assert';
import { summarize } from '../scripts/evaluation/statistics.ts';
Deno.test('evaluation percentiles preserve outliers, sample count and empty semantics', () => {
  const values = [100, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  assertEquals(summarize(values), {
    count: 10,
    min: 1,
    p50: 5,
    p95: 100,
    p99: 100,
    max: 100,
    mean: 14.5,
  });
  assertEquals(values[0], 100);
  assertEquals(summarize([]), {
    count: 0,
    min: null,
    p50: null,
    p95: null,
    p99: null,
    max: null,
    mean: null,
  });
  assertThrows(() => summarize([NaN]));
  assertThrows(() => summarize([-1]));
});
