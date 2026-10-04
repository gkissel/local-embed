import postgres from 'postgres';
import {
  attemptLimit,
  classify,
  ProcessingError,
  retryDelay,
  type RetryPolicy,
} from '../shared/retry.ts';
import { cancellable, Lease } from './lease.ts';
import type { Configuration } from '../admin/apply.ts';

import { readContent, table } from './content.ts';
export { quote, table } from './content.ts';
type Entity = Configuration['entities'][number];
type Provider = Configuration['providers'][number];
export type Generate = (
  provider: Provider,
  text: string,
  signal?: AbortSignal,
) => Promise<number[]>;
export function render(entity: Entity, row: Record<string, unknown>): string {
  return entity.template.replace(
    /\{\{([^}]+)\}\}/g,
    (_, field) => row[field] == null ? '' : String(row[field]),
  );
}
export async function fingerprint(
  entity: Entity,
  provider: Provider,
  text: string,
): Promise<string> {
  const value = JSON.stringify([
    text,
    entity.template,
    provider.name,
    provider.type,
    provider.endpoint,
    provider.model,
    provider.dimensions,
    provider.metric,
  ]);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, '0')).join('');
}
export const generate: Generate = async (provider, text, signal) => {
  const [{ embed }, { createOpenAI }] = await Promise.all([import('ai'), import('@ai-sdk/openai')]);
  const key = Deno.env.get(provider.secret_env);
  if (!key) throw new ProcessingError('provider_configuration');
  const baseURL = provider.endpoint.replace(/\/$/, '') + (provider.type === 'tei' ? '/v1' : '');
  const client = createOpenAI({ baseURL, apiKey: key });
  const { embedding } = await embed({
    model: client.embedding(provider.model),
    value: text,
    maxRetries: 0,
    abortSignal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000),
  });
  return embedding;
};

export type WorkerOptions = {
  leaseSeconds?: number;
  renewEveryMs?: number;
  maxExecutionMs?: number;
};

export class Worker {
  private sql: ReturnType<typeof postgres>;
  private options: Required<WorkerOptions>;
  private executions = new Set<Lease>();
  private active = new Set<Promise<boolean>>();
  private stopped = false;
  private closing?: Promise<void>;
  constructor(url: string, private inference: Generate = generate, options: WorkerOptions = {}) {
    const leaseSeconds = options.leaseSeconds ?? 60;
    this.options = {
      leaseSeconds,
      renewEveryMs: options.renewEveryMs ?? leaseSeconds * 1000 / 3,
      maxExecutionMs: options.maxExecutionMs ?? 300000,
    };
    for (const [name, value] of Object.entries(this.options)) {
      if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
    }
    if (this.options.renewEveryMs >= leaseSeconds * 1000) {
      throw new Error('renewEveryMs must be shorter than the lease');
    }
    this.sql = postgres(url, {
      max: 2,
      connection: { statement_timeout: 30000, lock_timeout: 5000 },
    });
  }
  abort(): void {
    this.stopped = true;
    for (const execution of this.executions) execution.controller.abort('shutdown');
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.abort();
      this.closing = (async () => {
        await Promise.allSettled([...this.active]);
        await this.sql.end();
      })();
    }
    return this.closing;
  }
  tick(): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    const operation = this.processOne();
    this.active.add(operation);
    return operation.finally(() => this.active.delete(operation));
  }
  /** A unique queue key means only one valid reservation exists for each identifier. */
  private async processOne(): Promise<boolean> {
    const sql = this.sql;
    const token = crypto.randomUUID();
    const { leaseSeconds, renewEveryMs, maxExecutionMs } = this.options;
    const [task] = await sql`WITH candidate AS (
      SELECT id FROM localembed.tasks
      WHERE ((status = 'pending' AND next_attempt_at <= clock_timestamp()) OR (status = 'processing' AND lease_until < clock_timestamp()))
        AND EXISTS (SELECT 1 FROM localembed.entity_revisions v WHERE v.configuration_id = tasks.configuration_id AND v.entity = tasks.entity AND v.state IN ('active','staging'))
      ORDER BY requested_at, id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE localembed.tasks t SET status = 'processing', attempts = CASE WHEN retry_generation <> generation THEN 1 ELSE attempts + 1 END, retry_generation = generation,
      lease_token = ${token}::uuid,
      execution_deadline = clock_timestamp() + ${maxExecutionMs} * interval '1 millisecond',
      lease_until = clock_timestamp() + ${
      Math.min(leaseSeconds * 1000, maxExecutionMs)
    } * interval '1 millisecond'
      FROM candidate c WHERE t.id = c.id RETURNING t.*`;
    if (!task) return false;
    const lease = new Lease(sql, task.id, token, leaseSeconds, renewEveryMs, maxExecutionMs);
    this.executions.add(lease);
    if (this.stopped) lease.controller.abort('shutdown');
    let outcome = 'task_discarded';
    let policy: RetryPolicy = {};
    let errorCode: string | undefined;
    let providerStatus: number | undefined;
    try {
      const [revision] =
        await sql`SELECT configuration FROM localembed.configurations WHERE id = ${task.configuration_id}`;
      const config = revision.configuration as Configuration;
      policy = config.operations?.retries ?? {};
      if (task.attempts > attemptLimit(policy)) throw new ProcessingError('retry_exhausted');
      const entity = config.entities.find((e) => e.name === task.entity)!;
      const provider = config.providers.find((p) => p.name === entity.provider)!;
      const idType =
        { uuid: 'uuid', bigint: 'bigint', text: 'text', ulid: 'text' }[entity.source.id.type];
      const row = await readContent(sql, entity, task.source_id);
      const text = row ? render(entity, row) : '';
      const hash = row ? await fingerprint(entity, provider, text) : null;
      const [stored] = await sql.unsafe(
        `SELECT fingerprint FROM ${
          table(entity.destination.table)
        } WHERE source_id = $1::${idType}`,
        [task.source_id],
      );
      lease.signal.throwIfAborted();
      const vector = row && stored?.fingerprint !== hash
        ? await cancellable(this.inference(provider, text, lease.signal), lease.signal)
        : null;
      if (
        vector &&
        (vector.length !== provider.dimensions ||
          !vector.every((n) => typeof n === 'number' && Number.isFinite(n)))
      ) throw new ProcessingError('invalid_embedding');
      lease.signal.throwIfAborted();
      await sql.begin(async (tx) => {
        const eligible =
          await tx`SELECT localembed.revision_eligible(${task.configuration_id}, ${task.entity}) AS eligible`;
        if (!eligible[0]?.eligible) return;
        // Source writers lock the source before enqueueing. Follow the same order
        // so an update cannot deadlock with the worker's final transaction.
        const current = await readContent(tx, entity, task.source_id, true);
        const currentHash = current
          ? await fingerprint(entity, provider, render(entity, current))
          : null;
        const [owned] = await tx`SELECT generation FROM localembed.tasks
          WHERE id = ${task.id} AND lease_token = ${token}::uuid AND status = 'processing'
            AND lease_until > clock_timestamp() AND execution_deadline > clock_timestamp() FOR UPDATE`;
        if (!owned || lease.signal.aborted) return;
        if (owned.generation !== task.generation || currentHash !== hash) {
          await tx`UPDATE localembed.tasks SET status = 'pending', attempts = 0, retry_generation = generation, next_attempt_at = clock_timestamp(), requested_at = clock_timestamp(), lease_until = NULL, lease_token = NULL, execution_deadline = NULL WHERE id = ${task.id}`;
          outcome = 'task_requeued';
          return;
        }
        if (!current) {
          await tx.unsafe(
            `DELETE FROM ${table(entity.destination.table)} WHERE source_id = $1::${idType}`,
            [task.source_id],
          );
        } else if (vector) {
          await tx.unsafe(
            `INSERT INTO ${
              table(entity.destination.table)
            } (source_id, embedding, fingerprint, configuration_id) VALUES ($1::${idType}, $2::vector, $3, $4) ON CONFLICT(source_id) DO UPDATE SET embedding = EXCLUDED.embedding, fingerprint = EXCLUDED.fingerprint, configuration_id = EXCLUDED.configuration_id, updated_at = now()`,
            [task.source_id, JSON.stringify(vector), hash!, task.configuration_id],
          );
        } else {
          const [present] = await tx.unsafe(
            `SELECT fingerprint FROM ${
              table(entity.destination.table)
            } WHERE source_id = $1::${idType}`,
            [task.source_id],
          );
          if (present?.fingerprint !== hash) {
            await tx`UPDATE localembed.tasks SET status = 'pending', attempts = 0, retry_generation = generation, next_attempt_at = clock_timestamp(), requested_at = clock_timestamp(), lease_until = NULL, lease_token = NULL, execution_deadline = NULL WHERE id = ${task.id}`;
            outcome = 'task_requeued';
            return;
          }
        }
        const completed =
          await tx`UPDATE localembed.tasks SET status = 'done', processed_generation = generation,
          lease_until = NULL, lease_token = NULL, execution_deadline = NULL, last_error = NULL, error_code = NULL, provider_status = NULL
          WHERE id = ${task.id} AND lease_token = ${token}::uuid
            AND lease_until > clock_timestamp() AND execution_deadline > clock_timestamp() RETURNING id`;
        if (!completed.length || lease.signal.aborted) {
          throw new Error('Execution expired before completion');
        }
        outcome = 'task_processed';
      });
    } catch (cause) {
      const failure = classify(cause);
      errorCode = lease.signal.aborted ? 'execution_interrupted' : failure.code;
      providerStatus = failure.status;
      const retry = failure.retryable && task.attempts < attemptLimit(policy);
      const delay = retryDelay(task.attempts, failure, policy);
      const rows = await sql`UPDATE localembed.tasks SET
        status = CASE WHEN generation <> ${task.generation} OR ${lease.signal.aborted} OR ${retry} THEN 'pending' ELSE 'failed' END,
        attempts = CASE WHEN generation <> ${task.generation} THEN 0 ELSE attempts END,
        retry_generation = generation,
        next_attempt_at = CASE WHEN generation <> ${task.generation} OR ${lease.signal.aborted} THEN clock_timestamp()
          ELSE clock_timestamp() + ${delay} * interval '1 millisecond' END,
        requested_at = clock_timestamp(), last_error = ${errorCode}, error_code = ${errorCode}, provider_status = ${
        providerStatus ?? null
      },
        lease_until = NULL, lease_token = NULL, execution_deadline = NULL
        WHERE id = ${task.id} AND lease_token = ${token}::uuid AND status = 'processing' RETURNING status`;
      outcome = rows[0]?.status === 'failed'
        ? 'task_failed'
        : retry
        ? 'task_retry_scheduled'
        : 'task_requeued';
      if (!rows.length) outcome = 'task_discarded';
    } finally {
      await lease.stop();
      this.executions.delete(lease);
    }
    console.log(
      JSON.stringify({
        event: outcome,
        task_id: task.id,
        entity: task.entity,
        configuration_id: task.configuration_id,
        generation: task.generation,
        error_code: errorCode,
        provider_status: providerStatus,
      }),
    );
    return true;
  }
}
