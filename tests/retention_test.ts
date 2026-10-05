import { assertEquals, assertThrows } from '@std/assert';
import { defaultRetention, retentionPolicy } from '../services/admin/retention.ts';
Deno.test('retention validation rejects destructive opt-in without protection and unsafe limits', () => {
  assertEquals(retentionPolicy({}), defaultRetention);
  assertThrows(() => retentionPolicy({ batch_size: 0 }));
  assertThrows(() => retentionPolicy({ batch_size: 10001 }));
  assertThrows(() => retentionPolicy({ completed_seconds: Number.MAX_SAFE_INTEGER }));
  assertThrows(() => retentionPolicy({ audit_seconds: -1 }));
  assertThrows(() => retentionPolicy({ toString: true }));
  assertThrows(() => retentionPolicy({ drop_retired_destinations: true }));
  assertEquals(
    retentionPolicy({ drop_retired_destinations: true, readers_use_lock_protocol: true })
      .drop_retired_destinations,
    true,
  );
});
