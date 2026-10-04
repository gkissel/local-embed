import { gauge, observableCounter } from '../shared/telemetry.ts';
import type { SnapshotStore } from './snapshot.ts';

/** One snapshot collector per process; refresh failures preserve data with explicit freshness. */
export class SnapshotMetrics {
  private snapshot: Awaited<ReturnType<SnapshotStore['load']>> | undefined;
  private lastSuccess = 0;

  constructor() {
    gauge('localembed_snapshot_age', 's').addCallback((result) => {
      if (this.lastSuccess) result.observe((Date.now() - this.lastSuccess) / 1000);
    });
    gauge('localembed_queue_depth').addCallback((result) => {
      for (const row of this.snapshot?.queue ?? []) {
        result.observe(row.depth, { entity: row.entity, status: row.status });
      }
    });
    for (
      const [name, field] of [['localembed_queue_age', 'age'], [
        'localembed_execution_age',
        'execution_age',
      ]] as const
    ) {
      gauge(name, 's').addCallback((result) => {
        for (const row of this.snapshot?.queue ?? []) {
          if (row[field] != null && ['pending', 'processing'].includes(row.status)) {
            result.observe(row[field], { entity: row.entity, status: row.status });
          }
        }
      });
    }
    for (const field of ['enqueued', 'coalesced', 'captured'] as const) {
      observableCounter(`localembed_${field}`).addCallback((result) => {
        for (const row of this.snapshot?.capture ?? []) {
          result.observe(row[field] ?? 0, { entity: row.entity });
        }
      });
    }
    for (const field of ['cursor_lag', 'window_lag', 'reconcile_overdue'] as const) {
      gauge(`localembed_poll_${field}`, 's').addCallback((result) => {
        for (const row of this.snapshot?.polling ?? []) {
          if (row[field] != null) {
            result.observe(row[field], {
              entity: row.entity,
              configuration_id: row.configuration_id,
              phase: row.phase,
            });
          }
        }
      });
    }
    gauge('localembed_poll_phase').addCallback((result) => {
      for (const row of this.snapshot?.polling ?? []) {
        result.observe(row.phase === 'delete' ? 1 : 0, {
          entity: row.entity,
          configuration_id: row.configuration_id,
        });
      }
    });
    gauge('localembed_poll_progress').addCallback((result) => {
      for (const row of this.snapshot?.polling ?? []) {
        result.observe(row.source_started ? 1 : 0, {
          entity: row.entity,
          configuration_id: row.configuration_id,
          phase: 'source',
        });
        result.observe(row.delete_started ? 1 : 0, {
          entity: row.entity,
          configuration_id: row.configuration_id,
          phase: 'delete',
        });
      }
    });
  }
  update(snapshot: Awaited<ReturnType<SnapshotStore['load']>>): void {
    this.snapshot = snapshot;
    this.lastSuccess = Date.now();
  }
}
