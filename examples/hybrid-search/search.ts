import postgres from 'npm:postgres@3.4.7';
import type { Configuration } from '../../services/admin/apply.ts';
import { fingerprint, render } from '../../services/worker/worker.ts';
import { quote, table } from '../../services/worker/content.ts';

export const ENTITY = 'demo_article';
export const SOURCE = 'hybrid_demo.articles';
export type Parameters = {
  candidateLimit: number;
  resultLimit: number;
  rrfK: number;
  lexicalWeight: number;
  semanticWeight: number;
  vectorMode: 'exact' | 'hnsw';
};
export const defaults: Parameters = {
  candidateLimit: 20,
  resultLimit: 5,
  rrfK: 60,
  lexicalWeight: 0.5,
  semanticWeight: 0.5,
  vectorMode: 'exact',
};
export function parameters(value: Partial<Parameters> = {}): Parameters {
  const result = { ...defaults, ...value };
  for (const field of ['candidateLimit', 'resultLimit', 'rrfK'] as const) {
    if (!Number.isInteger(result[field]) || result[field] < 1 || result[field] > 1000) {
      throw new Error('Ranking limits must be integers between 1 and 1000');
    }
  }
  for (const field of ['lexicalWeight', 'semanticWeight'] as const) {
    if (!Number.isFinite(result[field]) || result[field] < 0 || result[field] > 1) {
      throw new Error('Ranking weights must be between 0 and 1');
    }
  }
  if (result.lexicalWeight + result.semanticWeight === 0) {
    throw new Error('At least one weight is required');
  }
  if (!['exact', 'hnsw'].includes(result.vectorMode)) throw new Error('Unknown vector mode');
  return result;
}
export type Ranked = {
  id: string;
  score: number;
  lexicalRank: number | null;
  semanticRank: number | null;
};
/** Stable numeric ID breaks ties; raw BM25 and cosine scores are never added together. */
export function fuse(lexical: string[], semantic: string[], options = defaults): Ranked[] {
  const results = new Map<string, Ranked>();
  for (
    const [ids, weight, field] of [[lexical, options.lexicalWeight, 'lexicalRank'], [
      semantic,
      options.semanticWeight,
      'semanticRank',
    ]] as const
  ) {
    if (weight === 0) continue;
    for (const [offset, id] of ids.entries()) {
      const row = results.get(id) ?? { id, score: 0, lexicalRank: null, semanticRank: null };
      row[field] = offset + 1;
      row.score += weight / (options.rrfK + offset + 1);
      results.set(id, row);
    }
  }
  return [...results.values()].sort((a, b) =>
    b.score - a.score || (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0)
  ).slice(0, options.resultLimit);
}
export type QueryVector = {
  embedding: number[];
  dimensions: number;
  model: string;
  provider: string;
  generation: { config_version: string; fingerprint: string };
};
export type Embeddings = (input: string) => Promise<QueryVector>;
/** Prefix preparation belongs to the consumer until #14; raw lexical query stays unprefixed. */
export function embeddings(endpoint: string, key: string): Embeddings {
  return async (input) => {
    const response = await fetch(endpoint.replace(/\/$/, '') + '/v1/embeddings', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ entity: ENTITY, input }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error('Query embedding service unavailable');
    return await response.json();
  };
}
type Tx = postgres.TransactionSql;
export type Generation = {
  revision: string;
  config: Configuration;
  entity: Configuration['entities'][number];
  provider: Configuration['providers'][number];
};
export async function active(tx: Tx): Promise<Generation> {
  const [row] =
    await tx`SELECT c.id::text AS revision, c.configuration FROM localembed.entity_revisions v
    JOIN localembed.configurations c ON c.id = v.configuration_id WHERE v.entity = ${ENTITY} AND v.state = 'active'`;
  if (!row) throw new Error('Demo entity has no active revision');
  const config = row.configuration as Configuration;
  const entity = config.entities.find((item) => item.name === ENTITY)!;
  const provider = config.providers.find((item) => item.name === entity.provider)!;
  if (
    entity.source.table !== SOURCE || entity.source.id.type !== 'bigint' ||
    entity.dependencies?.length || provider.metric !== 'cosine'
  ) {
    throw new Error('The demonstrator requires its declared bigint source and cosine generation');
  }
  return { revision: row.revision, config, entity, provider };
}
export function lexicalSQL(source = SOURCE): string {
  return `SELECT a.id::text AS id, pdb.score(a.id)::float8 AS score FROM ${table(source)} a
    WHERE a.tenant_id = $1 AND a.published = true AND (a.title ||| $2 OR a.body ||| $2)
    ORDER BY pdb.score(a.id) DESC, a.id LIMIT $3`;
}
/** Filter by source permissions before top-k; fetch content only for the bounded pool. */
export function vectorSQL(
  generation: Generation,
  mode: Parameters['vectorMode'],
  sameTable?: string,
): string {
  const source = table(sameTable ?? SOURCE);
  const destination = table(sameTable ?? generation.entity.destination.table);
  const key = sameTable ? 'id' : 'source_id';
  const distance = '(d.embedding <=> $1::vector)';
  const eligible = sameTable
    ? 'd.tenant_id = $2 AND d.published = true'
    : `EXISTS (SELECT 1 FROM ${source} a WHERE a.id = d.source_id AND a.tenant_id = $2 AND a.published = true)`;
  return `SELECT d.${key}::text AS id, d.fingerprint, ${distance}::float8 AS distance
    FROM ${destination} d WHERE d.embedding IS NOT NULL AND vector_norm(d.embedding) > 0 AND d.configuration_id = $3::bigint AND ${eligible}
    ORDER BY ${mode === 'exact' ? distance + ' + 0, d.' + key : distance} LIMIT $4`;
}
export async function rank(
  tx: Tx,
  generation: Generation,
  vector: number[],
  query: string,
  tenant: string,
  options: Parameters,
  sameTable?: string,
) {
  if (!query.trim() || [...query].length > 1000 || !tenant || tenant.length > 100) {
    throw new Error('Invalid query or tenant');
  }
  if (options.vectorMode === 'hnsw') {
    await tx`SET LOCAL hnsw.iterative_scan = 'strict_order'`;
    await tx`SET LOCAL hnsw.ef_search = 100`;
  }
  const source = sameTable ?? SOURCE;
  const lexical = await tx.unsafe(lexicalSQL(source), [tenant, query, options.candidateLimit]);
  // Bound freshness checks; stale/missing embeddings may underfill semantic candidates.
  const pool = await tx.unsafe(vectorSQL(generation, options.vectorMode, sameTable), [
    JSON.stringify(vector),
    tenant,
    generation.revision,
    options.candidateLimit * 4,
  ]);
  const content = pool.length
    ? await tx.unsafe(
      `SELECT ${
        [...new Set(['id', ...(generation.entity.fields ?? [])])].map(quote).join(', ')
      } FROM ${table(source)} WHERE tenant_id = $1 AND published = true AND id = ANY($2::bigint[])`,
      [tenant, pool.map((row) => row.id)],
    )
    : [];
  const current = new Map(content.map((row) => [String(row.id), row]));
  const fresh: { id: string; distance: number }[] = [];
  for (const row of pool) {
    const sourceRow = current.get(row.id);
    if (
      sourceRow && Number.isFinite(row.distance) &&
      await fingerprint(
          generation.entity,
          generation.provider,
          render(generation.entity, sourceRow),
        ) === row.fingerprint
    ) {
      fresh.push({ id: row.id, distance: row.distance });
    }
  }
  fresh.sort((a, b) => a.distance - b.distance || (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  const semantic = fresh.slice(0, options.candidateLimit);
  const fused = fuse(lexical.map((row) => row.id), semantic.map((row) => row.id), options);
  const final = fused.length
    ? await tx.unsafe(
      `SELECT id::text AS id, title, body FROM ${table(source)}
      WHERE tenant_id = $1 AND published = true AND id = ANY($2::bigint[])`,
      [tenant, fused.map((row) => row.id)],
    )
    : [];
  const byId = new Map(final.map((row) => [row.id, row]));
  return {
    results: fused.filter((row) => byId.has(row.id)).map((row) => ({
      ...row,
      ...byId.get(row.id),
    })),
    candidates: {
      lexical: lexical.map((row) => row.id),
      semantic: semantic.map((row) => row.id),
      inspected: pool.length,
      stale: pool.length - fresh.length,
    },
  };
}
class RevisionChanged extends Error {}
export class HybridSearch {
  private sql: ReturnType<typeof postgres>;
  constructor(url: string, private generate: Embeddings) {
    this.sql = postgres(url, {
      max: 1,
      onnotice: () => {},
      connection: { statement_timeout: 10000 },
    });
  }
  close() {
    return this.sql.end();
  }
  async search(query: string, tenant: string, overrides: Partial<Parameters> = {}) {
    const options = parameters(overrides);
    if (!query.trim() || [...query].length > 1000 || !tenant || tenant.length > 100) {
      throw new Error('Invalid query or tenant');
    }
    const input = 'query: ' + query;
    for (let attempt = 0; attempt < 3; attempt++) {
      const generated = await this.generate(input);
      try {
        return await this.sql.begin('isolation level repeatable read read only', async (tx) => {
          const generation = await active(tx);
          if (
            generated?.generation?.config_version !==
              `${generation.config.version}@${generation.revision}`
          ) throw new RevisionChanged();
          if (
            !Array.isArray(generated.embedding) ||
            generated.embedding.length !== generation.provider.dimensions ||
            !generated.embedding.every((value) =>
              typeof value === 'number' && Number.isFinite(value)
            ) ||
            generated.embedding.every((value) => value === 0) ||
            generated.dimensions !== generation.provider.dimensions ||
            generated.model !== generation.provider.model ||
            generated.provider !== generation.provider.name ||
            generated.generation.fingerprint !==
              await fingerprint(generation.entity, generation.provider, input)
          ) {
            throw new Error('Query generation metadata or vector is incompatible');
          }
          const ranked = await rank(tx, generation, generated.embedding, query, tenant, options);
          return { revision: generation.revision, parameters: options, ...ranked };
        });
      } catch (cause) {
        if (
          !(cause instanceof RevisionChanged) &&
          !(cause && typeof cause === 'object' && 'code' in cause && cause.code === '42P01')
        ) throw cause;
      }
    }
    throw new Error('Configuration changed repeatedly; retry the query later');
  }
}
