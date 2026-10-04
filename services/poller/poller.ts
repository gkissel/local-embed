import { event, span } from '../shared/telemetry.ts';
import postgres from 'postgres';
import type { Configuration } from '../admin/apply.ts';
import { idType, quote, readContent, table } from '../worker/content.ts';
import { fingerprint, render } from '../worker/worker.ts';

type Entity = Configuration['entities'][number];
/** Timestamp polling accelerates discovery; complete, resumable sweeps guarantee eventual convergence. */
export class Poller {
  private sql: ReturnType<typeof postgres>;
  constructor(url: string, private batchSize = 100) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10000) {
      throw new Error('Polling batch size must be an integer between 1 and 10000');
    }
    this.sql = postgres(url, {
      max: 1,
      connection: { statement_timeout: 30000, lock_timeout: 5000 },
    });
  }
  close(): Promise<void> {
    return this.sql.end();
  }
  /** One bounded incremental batch and one reconciliation batch per polling entity. */
  tick(): Promise<void> {
    return span('poller.tick', { service: 'poller' }, () => this.scan());
  }
  private async scan(): Promise<void> {
    const revisions = await this
      .sql`SELECT id, configuration FROM localembed.configurations ORDER BY id`;
    for (const revision of revisions) {
      const config = revision.configuration as Configuration & {
        operations?: { reconciliation?: { interval_seconds?: number } };
      };
      for (const entity of config.entities) {
        if (entity.source.detection.mode !== 'polling') continue;
        await this.sql.begin(async (tx) => {
          const eligible =
            await tx`SELECT localembed.revision_eligible(${revision.id}, ${entity.name}) AS eligible`;
          if (!eligible[0]?.eligible) return;
          await tx`INSERT INTO localembed.polling_state(configuration_id, entity) VALUES (${revision.id}, ${entity.name}) ON CONFLICT DO NOTHING`;
          const [state] =
            await tx`SELECT *, cursor_time::text AS time_text, window_end::text AS end_text,
            next_reconcile <= clock_timestamp() AS due
            FROM localembed.polling_state WHERE configuration_id = ${revision.id} AND entity = ${entity.name} FOR UPDATE`;
          const key = quote(entity.source.id.column);
          const type = idType(entity.source.id.type);
          const stamp = quote(entity.source.detection.updated_at!);
          const rows = await tx.unsafe(
            `SELECT root.${key}::text AS identifier, root.${stamp}::text AS time
              FROM ${table(entity.source.table)} root
              WHERE root.${stamp} <= $3::text::timestamptz AND
                (root.${stamp} > $1::text::timestamptz OR (root.${stamp} = $1::text::timestamptz AND ($2::${type} IS NULL OR root.${key} > $2::${type})))
              ORDER BY root.${stamp}, root.${key} LIMIT $4`,
            [state.time_text, state.cursor_id, state.end_text, this.batchSize],
          );
          event('poll_scanned', {
            service: 'poller',
            entity: entity.name,
            configuration_id: revision.id,
            phase: 'incremental',
            count: rows.length,
          });
          for (const row of rows) {
            await this.enqueueChanged(tx, config, entity, revision.id, row.identifier);
          }
          if (rows.length === this.batchSize) {
            const last = rows.at(-1)!;
            await tx`UPDATE localembed.polling_state SET cursor_time = ${last.time}::text::timestamptz, cursor_id = ${last.identifier}
              WHERE configuration_id = ${revision.id} AND entity = ${entity.name}`;
          } else {
            await tx`UPDATE localembed.polling_state SET
              cursor_time = window_end - ${
              entity.source.detection.overlap_seconds ?? 60
            } * interval '1 second',
              cursor_id = NULL, window_end = clock_timestamp()
              WHERE configuration_id = ${revision.id} AND entity = ${entity.name}`;
          }
          if (state.due) {
            await this.reconcileBatch(
              tx,
              config,
              entity,
              revision.id,
              state,
              config.operations?.reconciliation?.interval_seconds ?? 3600,
            );
          }
        });
      }
    }
  }
  private async enqueueChanged(
    tx: postgres.TransactionSql,
    config: Configuration,
    entity: Entity,
    revision: string,
    identifier: string,
  ): Promise<void> {
    const row = await readContent(tx, entity, identifier);
    if (!row) return;
    const provider = config.providers.find((item) => item.name === entity.provider)!;
    const hash = await fingerprint(entity, provider, render(entity, row));
    const [stored] = await tx.unsafe(
      `SELECT fingerprint FROM ${table(entity.destination.table)} WHERE source_id = $1::${
        idType(entity.source.id.type)
      }`,
      [identifier],
    );
    if (stored?.fingerprint === hash) return;
    const changed = await this.enqueueRecoverable(tx, revision, entity.name, identifier, 'upsert');
    if (changed) {
      event('poll_changed', { service: 'poller', entity: entity.name, configuration_id: revision });
    }
  }
  private async enqueueRecoverable(
    tx: postgres.TransactionSql,
    revision: string,
    entity: string,
    identifier: string,
    operation: string,
  ): Promise<boolean> {
    // Active workers recheck content; failed diagnostics require explicit reprocessing (#6).
    // Serialize with enqueue/worker transitions using the same task row.
    const [task] = await tx`SELECT status FROM localembed.tasks
      WHERE configuration_id = ${revision} AND entity = ${entity} AND source_id = ${identifier} FOR UPDATE`;
    if (task && task.status !== 'done') return false;
    await tx`SELECT localembed.enqueue_task(${revision}, ${entity}, ${identifier}, ${operation}, 'polling')`;
    return true;
  }
  private async reconcileBatch(
    tx: postgres.TransactionSql,
    config: Configuration,
    entity: Entity,
    revision: string,
    state: Record<string, unknown>,
    interval: number,
  ): Promise<void> {
    const key = quote(entity.source.id.column);
    const type = idType(entity.source.id.type);
    if (state.phase === 'source') {
      if (state.sweep_upper == null) {
        const [upper] = await tx.unsafe(
          `SELECT ${key}::text AS identifier FROM ${
            table(entity.source.table)
          } ORDER BY ${key} DESC LIMIT 1`,
        );
        state.sweep_upper = upper?.identifier ?? null;
        await tx`UPDATE localembed.polling_state SET sweep_upper = ${
          upper?.identifier ?? null
        } WHERE configuration_id = ${revision} AND entity = ${entity.name}`;
      }

      const rows = await tx.unsafe(
        `SELECT ${key}::text AS identifier FROM ${
          table(entity.source.table)
        } WHERE ($1::${type} IS NULL OR ${key} > $1::${type}) AND ${key} <= $3::${type} ORDER BY ${key} LIMIT $2`,
        [state.sweep_cursor as string | null, this.batchSize, state.sweep_upper as string | null],
      );
      event('poll_scanned', {
        service: 'poller',
        entity: entity.name,
        configuration_id: revision,
        phase: 'source',
        count: rows.length,
      });
      for (const row of rows) {
        await this.enqueueChanged(tx, config, entity, revision, row.identifier);
      }
      await tx`UPDATE localembed.polling_state SET sweep_cursor = ${
        rows.length ? rows.at(-1)!.identifier : state.sweep_cursor as string | null
      },
        phase = ${rows.length < this.batchSize ? 'delete' : 'source'}
        WHERE configuration_id = ${revision} AND entity = ${entity.name}`;
    } else {
      if (state.delete_upper == null) {
        const [upper] = await tx.unsafe(
          `SELECT source_id::text AS identifier FROM ${
            table(entity.destination.table)
          } ORDER BY source_id DESC LIMIT 1`,
        );
        state.delete_upper = upper?.identifier ?? null;
        await tx`UPDATE localembed.polling_state SET delete_upper = ${
          upper?.identifier ?? null
        } WHERE configuration_id = ${revision} AND entity = ${entity.name}`;
      }
      const rows = await tx.unsafe(
        `SELECT dest.source_id::text AS identifier FROM ${table(entity.destination.table)} dest
          WHERE ($1::${type} IS NULL OR dest.source_id > $1::${type})
          AND dest.source_id <= $3::${type}
          AND NOT EXISTS (SELECT 1 FROM ${
          table(entity.source.table)
        } root WHERE root.${key} = dest.source_id)
          ORDER BY dest.source_id LIMIT $2`,
        [state.delete_cursor as string | null, this.batchSize, state.delete_upper as string | null],
      );
      event('poll_orphans', {
        service: 'poller',
        entity: entity.name,
        configuration_id: revision,
        phase: 'delete',
        count: rows.length,
      });
      for (const row of rows) {
        await this.enqueueRecoverable(tx, revision, entity.name, row.identifier, 'delete');
      }
      if (rows.length < this.batchSize) {
        event('reconciliation_completed', {
          service: 'poller',
          entity: entity.name,
          configuration_id: revision,
        });
        await tx`UPDATE localembed.polling_state SET sweep_cursor = NULL, sweep_upper = NULL, delete_cursor = NULL, delete_upper = NULL, phase = 'source',
          next_reconcile = clock_timestamp() + ${interval} * interval '1 second'
          WHERE configuration_id = ${revision} AND entity = ${entity.name}`;
      } else {
        await tx`UPDATE localembed.polling_state SET delete_cursor = ${rows.at(-1)!.identifier}
          WHERE configuration_id = ${revision} AND entity = ${entity.name}`;
      }
    }
  }
}
