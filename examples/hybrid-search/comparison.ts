import type postgres from 'npm:postgres@3.4.7';
import { table } from '../../services/worker/content.ts';
import type { Generation } from './search.ts';
export const VARIANT = 'hybrid_compare.articles';
/** Explicit experiment only. No consumer/core migration writes vectors into the source. */
export async function createComparison(tx: postgres.TransactionSql, generation: Generation) {
  const [exists] = await tx`SELECT to_regnamespace('hybrid_compare') AS schema`;
  if (exists.schema) throw new Error('Comparison schema already exists');
  await tx.unsafe(`CREATE SCHEMA hybrid_compare;
    CREATE TABLE ${table(VARIANT)} AS SELECT a.*, d.embedding, d.fingerprint, d.configuration_id
      FROM hybrid_demo.articles a LEFT JOIN ${
    table(generation.entity.destination.table)
  } d ON d.source_id = a.id;
    ALTER TABLE ${table(VARIANT)} ADD PRIMARY KEY(id);
    CREATE INDEX compare_bm25 ON ${
    table(VARIANT)
  } USING bm25(id, tenant_id, published, title, body) WITH (key_field='id');
    CREATE INDEX compare_hnsw ON ${
    table(VARIANT)
  } USING hnsw(embedding vector_cosine_ops) WITH (m=16, ef_construction=64);
    ANALYZE ${table(VARIANT)}`);
}
