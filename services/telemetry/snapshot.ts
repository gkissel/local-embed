import postgres from 'postgres';

/** Read-only snapshots are gauges, never substitutes for accumulated lifecycle counters. */
export class SnapshotStore {
  private sql: ReturnType<typeof postgres>;
  constructor(url: string) {
    this.sql = postgres(url, { max: 1, connection: { statement_timeout: 5000 } });
  }
  close() {
    return this.sql.end();
  }
  async load() {
    return await this.sql.begin('read only', async (tx) => {
      const queue = await tx`WITH states AS (
          SELECT entity, status, count(*)::float8 AS depth,
            GREATEST(0, EXTRACT(epoch FROM clock_timestamp() - min(requested_at)))::float8 AS age,
            GREATEST(0, EXTRACT(epoch FROM clock_timestamp() - min(execution_started_at)))::float8 AS execution_age
          FROM localembed.tasks GROUP BY entity, status
        ) SELECT v.entity, s.status, COALESCE(q.depth, 0)::float8 AS depth,
          COALESCE(q.age, 0)::float8 AS age, COALESCE(q.execution_age, 0)::float8 AS execution_age
          FROM (SELECT DISTINCT entity FROM localembed.entity_revisions) v
          CROSS JOIN (VALUES ('pending'), ('processing'), ('failed'), ('done'), ('superseded')) s(status)
          LEFT JOIN states q ON q.entity = v.entity AND q.status = s.status`;
      const capture = await tx`SELECT entity, sum(enqueued)::float8 AS enqueued,
        sum(coalesced)::float8 AS coalesced,
        sum(enqueued) FILTER (WHERE origin = 'trigger')::float8 AS captured FROM localembed.enqueue_metrics GROUP BY entity`;
      const polling = await tx`SELECT p.entity, p.configuration_id::text, p.phase,
        CASE WHEN isfinite(cursor_time) THEN GREATEST(0, EXTRACT(epoch FROM clock_timestamp() - cursor_time))::float8 ELSE NULL END AS cursor_lag,
        CASE WHEN isfinite(window_end) THEN GREATEST(0, EXTRACT(epoch FROM clock_timestamp() - window_end))::float8 ELSE NULL END AS window_lag,
        CASE WHEN isfinite(next_reconcile) THEN GREATEST(0, EXTRACT(epoch FROM clock_timestamp() - next_reconcile))::float8 ELSE NULL END AS reconcile_overdue,
        p.sweep_cursor IS NOT NULL AS source_started, p.delete_cursor IS NOT NULL AS delete_started
        FROM localembed.polling_state p JOIN localembed.entity_revisions v USING(configuration_id, entity)
        WHERE v.state IN ('active', 'staging')`;
      return { queue, capture, polling };
    });
  }
}
