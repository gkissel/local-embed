import postgres from 'npm:postgres@3.4.7';
import { applyConfiguration, type Configuration } from '../../services/admin/apply.ts';
import reference from '../../deployments/localembed.reference.json' with { type: 'json' };
import { ENTITY, SOURCE } from './search.ts';

export const articles = [
  [1, 'alpha', true, 'Mechanical keyboard', 'A tactile keyboard for coding and typing.'],
  [
    2,
    'alpha',
    true,
    'Quiet typing device',
    'Silent keys and comfortable text entry for an office.',
  ],
  [3, 'alpha', true, 'Database performance', 'PostgreSQL query indexes and tuning.'],
  [4, 'alpha', true, 'Vector retrieval', 'Embedding similarity and semantic search.'],
  [5, 'alpha', true, 'Lexical search', 'BM25 scoring for exact words and product codes.'],
  [6, 'alpha', true, 'Wireless mouse', 'Pointing device with a precision sensor.'],
  [7, 'beta', true, 'Keyboard confidential', 'PRIVATE_BETA keyboard product roadmap.'],
  [8, 'alpha', false, 'Keyboard draft', 'PRIVATE_DRAFT unpublished typing device.'],
] as const;
export function demoConfiguration(dimensions = 768): Configuration {
  const config = structuredClone(reference) as Configuration;
  config.providers[0].dimensions = dimensions;
  config.entities[0] = {
    ...config.entities[0],
    name: ENTITY,
    source: { table: SOURCE, id: { column: 'id', type: 'bigint' }, detection: { mode: 'trigger' } },
    destination: {
      table: 'localembed.demo_article_embeddings',
      hnsw: { m: 16, ef_construction: 64 },
    },
  };
  return config;
}
export async function setup(url: string, config = demoConfiguration(), simulated = false) {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const [exists] = await sql`SELECT to_regnamespace('hybrid_demo') AS schema`;
    if (exists.schema) throw new Error('hybrid_demo already exists; use a fresh demo database');
    await sql.begin(async (tx) => {
      await tx.unsafe(
        `CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_search;
        CREATE SCHEMA hybrid_demo;
        CREATE TABLE hybrid_demo.articles(id bigint PRIMARY KEY, tenant_id text NOT NULL, published boolean NOT NULL, title text NOT NULL, body text NOT NULL);
        CREATE INDEX articles_bm25 ON hybrid_demo.articles USING bm25(id, tenant_id, published, title, body) WITH (key_field='id')`,
      );
      for (const [id, tenant, published, title, body] of articles) {
        await tx`INSERT INTO hybrid_demo.articles VALUES(${id}, ${tenant}, ${published}, ${title}, ${body})`;
      }
    });
    await applyConfiguration(url, config, simulated ? () => Promise.resolve() : undefined);
  } finally {
    await sql.end();
  }
}
if (import.meta.main) {
  const url = Deno.env.get('DATABASE_URL');
  if (!url) throw new Error('DATABASE_URL is required');
  await setup(url);
}
