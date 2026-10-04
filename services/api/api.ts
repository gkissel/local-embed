import postgres from 'postgres';
import { attemptLimit, classify, ProcessingError, retryDelay, waitRetry } from '../shared/retry.ts';
import type { Configuration } from '../admin/apply.ts';
import { fingerprint, type Generate, generate } from '../worker/worker.ts';
import { cancellable } from '../worker/lease.ts';

export type LoadConfiguration = (entity: string) => Promise<Configuration | undefined>;
const MAX_BODY_BYTES = 262144;
const error = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status });

/** Only applied entities are exposed; source data, tasks and vectors are never queried. */
export class ConfigurationStore {
  private sql: ReturnType<typeof postgres>;
  constructor(url: string) {
    this.sql = postgres(url, {
      max: 2,
      connection: { statement_timeout: 5000 },
    });
  }
  async load(entity: string): Promise<Configuration | undefined> {
    const [row] = await this.sql`SELECT c.id, c.configuration FROM localembed.entity_revisions v
      JOIN localembed.configurations c ON c.id = v.configuration_id WHERE v.entity = ${entity} AND v.state = 'active'`;
    return row
      ? { ...row.configuration as Configuration, applied_revision: String(row.id) }
      : undefined;
  }
  close(): Promise<void> {
    return this.sql.end();
  }
}

async function readBody(request: Request): Promise<unknown> {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    throw new Error('Invalid body size');
  }
  if (!request.body) throw new Error('Missing body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error('Body too large');
      chunks.push(value);
    }
  } catch (cause) {
    await reader.cancel().catch(() => {});
    throw cause;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

/** Service keys are 32 random bytes encoded as 64 hexadecimal characters. */
export function createHandler(
  key: string,
  load: LoadConfiguration,
  inference: Generate = generate,
  timeoutMs = 30000,
): (request: Request) => Promise<Response> {
  if (!/^[a-fA-F0-9]{64}$/.test(key)) throw new Error('Service key must encode 32 bytes as hex');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Timeout must be positive');
  const expected = new TextEncoder().encode(`Bearer ${key}`);
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (path !== '/v1/embeddings') return error(404, 'not_found', 'Route not found');
    if (request.method !== 'POST') {
      const response = error(405, 'method_not_allowed', 'Use POST');
      response.headers.set('Allow', 'POST');
      return response;
    }
    const supplied = new TextEncoder().encode(request.headers.get('authorization') ?? '');
    let mismatch = supplied.length ^ expected.length;
    for (let i = 0; i < expected.length; i++) mismatch |= expected[i] ^ (supplied[i] ?? 0);
    if (mismatch) return error(401, 'unauthorized', 'Missing or invalid service key');
    const mediaType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (mediaType !== 'application/json') {
      return error(400, 'validation_error', 'Content-Type must be application/json');
    }
    let value: unknown;
    try {
      value = await readBody(request);
    } catch {
      return error(400, 'validation_error', 'Invalid JSON or body exceeds 262144 bytes');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return error(400, 'validation_error', 'Expected an object with entity and input');
    }
    const body = value as Record<string, unknown>;
    if (
      Object.keys(body).length !== 2 || typeof body.entity !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(body.entity) || typeof body.input !== 'string' ||
      [...body.input].length < 1 || [...body.input].length > 32768
    ) return error(400, 'validation_error', 'Invalid entity, input or additional properties');
    try {
      const deadline = Date.now() + timeoutMs;
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
      const config = await cancellable(load(body.entity), signal);
      const entity = config?.entities.find((item) => item.name === body.entity);
      if (!config || !entity) return error(404, 'entity_not_found', 'Entity is not applied');
      const provider = config.providers.find((item) => item.name === entity.provider);
      if (!provider) throw new Error('Missing provider');
      let vector: number[] | undefined;
      const policy = config.operations?.retries ?? {};
      for (let attempt = 1; attempt <= attemptLimit(policy); attempt++) {
        try {
          vector = await cancellable(inference(provider, body.input, signal), signal);
          break;
        } catch (cause) {
          const failure = classify(cause);
          if (signal.aborted || !failure.retryable || attempt === attemptLimit(policy)) throw cause;
          const delay = retryDelay(attempt, failure, policy);
          if (delay >= deadline - Date.now()) throw cause;
          await waitRetry(delay, signal);
        }
      }
      if (
        !Array.isArray(vector) || vector.length !== provider.dimensions ||
        !vector.every((n) => typeof n === 'number' && Number.isFinite(n))
      ) throw new ProcessingError('invalid_embedding');
      return Response.json({
        embedding: vector,
        dimensions: provider.dimensions,
        model: provider.model,
        provider: provider.name,
        generation: {
          config_version: config.applied_revision
            ? `${config.version}@${config.applied_revision}`
            : config.version,
          fingerprint: await fingerprint(entity, provider, body.input),
        },
      });
    } catch {
      return error(503, 'provider_unavailable', 'Embedding service is unavailable');
    }
  };
}
