import postgres from 'postgres';
import type { Configuration } from '../admin/apply.ts';

export const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
export const table = (s: string) => s.split('.').map(quote).join('.');
type Entity = Configuration['entities'][number];
type Provider = Configuration['providers'][number];
export type Generate = (provider: Provider, text: string) => Promise<number[]>;
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
export const generate: Generate = async (provider, text) => {
  const [{ embed }, { createOpenAI }] = await Promise.all([import('ai'), import('@ai-sdk/openai')]);
  const key = Deno.env.get(provider.secret_env);
  if (!key) throw new Error(`Missing environment variable ${provider.secret_env}`);
  const baseURL = provider.endpoint.replace(/\/$/, '') + (provider.type === 'tei' ? '/v1' : '');
  const client = createOpenAI({ baseURL, apiKey: key });
  const { embedding } = await embed({
    model: client.embedding(provider.model),
    value: text,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(30000),
  });
  return embedding;
};

export class Worker {
  private sql: ReturnType<typeof postgres>;
  constructor(url: string, private inference: Generate = generate, private leaseSeconds = 60) {
    if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) {
      throw new Error('leaseSeconds must be positive');
    }
    this.sql = postgres(url, { max: 2 });
  }
  close(): Promise<void> {
    return this.sql.end();
  }
  /** Claims one task without blocking other replicas. Expired leases are reclaimable. */
  async tick(): Promise<boolean> {
    const sql = this.sql;
    const [task] = await sql`WITH candidate AS (
      SELECT id FROM localembed.tasks
      WHERE status = 'pending' OR (status = 'processing' AND lease_until < now())
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE localembed.tasks t SET status = 'processing', attempts = attempts + 1,
      lease_until = now() + ${this.leaseSeconds} * interval '1 second'
      FROM candidate c WHERE t.id = c.id RETURNING t.*`;
    if (!task) return false;
    try {
      const [revision] =
        await sql`SELECT configuration FROM localembed.configurations WHERE id = ${task.configuration_id}`;
      const config = revision.configuration as Configuration;
      const entity = config.entities.find((e) => e.name === task.entity)!;
      const provider = config.providers.find((p) => p.name === entity.provider)!;
      const idType =
        { uuid: 'uuid', bigint: 'bigint', text: 'text', ulid: 'text' }[entity.source.id.type];
      const sourceQuery = `SELECT * FROM ${table(entity.source.table)} WHERE ${
        quote(entity.source.id.column)
      } = $1::${idType}`;
      const [row] = await sql.unsafe(sourceQuery, [task.source_id]);
      const text = row ? render(entity, row) : '';
      const hash = row ? await fingerprint(entity, provider, text) : null;
      const [stored] = await sql.unsafe(
        `SELECT fingerprint FROM ${
          table(entity.destination.table)
        } WHERE source_id = $1::${idType}`,
        [task.source_id],
      );
      const vector = row && stored?.fingerprint !== hash
        ? await this.inference(provider, text)
        : null;
      if (
        vector &&
        (vector.length !== provider.dimensions ||
          !vector.every((n) => typeof n === 'number' && Number.isFinite(n)))
      ) throw new Error(`Provider returned invalid embedding dimensions or values`);
      await sql.begin(async (tx) => {
        const [owned] =
          await tx`SELECT id FROM localembed.tasks WHERE id = ${task.id} AND attempts = ${task.attempts} AND status = 'processing' AND lease_until > now() FOR UPDATE`;
        if (!owned) return;
        // Serializes final writes, including absent source rows, across replicas.
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${
          entity.destination.table + ':' + task.source_id
        }, 0))`;
        const [current] = await tx.unsafe(sourceQuery + ' FOR SHARE', [task.source_id]);
        const currentHash = current
          ? await fingerprint(entity, provider, render(entity, current))
          : null;
        if (currentHash !== hash) {
          await tx`UPDATE localembed.tasks SET status = 'pending', lease_until = NULL WHERE id = ${task.id}`;
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
          // Another replica may have removed the destination since the first read.
          const [present] = await tx.unsafe(
            `SELECT fingerprint FROM ${
              table(entity.destination.table)
            } WHERE source_id = $1::${idType}`,
            [task.source_id],
          );
          if (present?.fingerprint !== hash) {
            await tx`UPDATE localembed.tasks SET status = 'pending', lease_until = NULL WHERE id = ${task.id}`;
            return;
          }
        }
        await tx`UPDATE localembed.tasks SET status = 'done', lease_until = NULL, last_error = NULL WHERE id = ${task.id}`;
      });
      console.log(
        JSON.stringify({ event: 'task_processed', task_id: task.id, entity: task.entity }),
      );
    } catch {
      // Detailed provider classification and administrative retries belong to issue #6.
      await sql`UPDATE localembed.tasks SET status = 'failed', lease_until = NULL, last_error = 'processing failed' WHERE id = ${task.id} AND attempts = ${task.attempts} AND status = 'processing'`;
      console.error(
        JSON.stringify({ event: 'task_failed', task_id: task.id, entity: task.entity }),
      );
    }
    return true;
  }
}
