import { assertEquals, assertRejects } from '@std/assert';
import postgres from 'npm:postgres@3.4.7';
import { applyConfiguration, type Configuration } from '../services/admin/apply.ts';
import { backfill, buildIndexes } from '../services/admin/synchronize.ts';
import { validManagedIndex } from '../services/admin/indexes.ts';
import { cleanup } from '../services/admin/retention.ts';
import { Worker } from '../services/worker/worker.ts';
import reference from '../deployments/localembed.reference.json' with { type: 'json' };
const url =
  Deno.permissions.querySync({ name: 'env', variable: 'TEST_DATABASE_URL' }).state === 'granted'
    ? Deno.env.get('TEST_DATABASE_URL')
    : undefined;
const source = '00000000-0000-0000-0000-000000000001';
async function fixture() {
  const sql = postgres(url!, { max: 1, onnotice: () => {} });
  await sql.unsafe(
    'CREATE EXTENSION IF NOT EXISTS vector; DROP SCHEMA IF EXISTS localembed CASCADE; DROP TABLE IF EXISTS public.articles CASCADE; CREATE TABLE public.articles(id uuid PRIMARY KEY,title text,body text)',
  );
  await sql`INSERT INTO public.articles VALUES (${source},'title','body')`;
  const config = structuredClone(reference) as Configuration;
  config.providers[0].dimensions = 3;
  await applyConfiguration(url!, config, () => Promise.resolve());
  const worker = new Worker(url!, () => Promise.resolve([1, 0, 0]));
  return {
    sql,
    config,
    worker,
    async close() {
      await worker.close();
      await sql.unsafe('DROP SCHEMA localembed CASCADE; DROP TABLE public.articles CASCADE');
      await sql.end();
    },
  };
}
async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Timed out waiting for concurrent index phase');
}
Deno.test({
  name: 'online HNSW validates catalog and resumes metadata despite incremental pending work',
  ignore: !url,
  fn: async () => {
    const f = await fixture();
    try {
      await assertRejects(() => buildIndexes(url!, true), Error, 'backfill must finish');
      await backfill(url!);
      await assertRejects(() => buildIndexes(url!), Error, 'process all queued tasks');
      await buildIndexes(url!, true); // Backfill enqueued, inference intentionally not yet drained.
      assertEquals(
        await validManagedIndex(f.sql, f.config.entities[0], f.config.providers[0]),
        true,
      );
      await f.sql`UPDATE localembed.backfills SET indexed = false`;
      await buildIndexes(url!, true);
      assertEquals((await f.sql`SELECT indexed FROM localembed.backfills`)[0].indexed, true);
      await f.sql.unsafe(
        'DROP INDEX localembed.article_embeddings_hnsw; CREATE INDEX article_embeddings_hnsw ON localembed.article_embeddings USING hnsw(embedding vector_l2_ops)',
      );
      await assertRejects(() => buildIndexes(url!, true), Error, 'conflicting definition');
      assertEquals(
        await validManagedIndex(f.sql, f.config.entities[0], f.config.providers[0]),
        false,
      );
      await f.sql.unsafe(
        'DROP INDEX localembed.article_embeddings_hnsw; CREATE INDEX article_embeddings_hnsw ON localembed.article_embeddings USING hnsw(embedding vector_cosine_ops) WITH(m=8,ef_construction=64)',
      );
      await assertRejects(() => buildIndexes(url!, true), Error, 'conflicting definition');
      await f.sql.unsafe(
        'DROP INDEX localembed.article_embeddings_hnsw; CREATE INDEX article_embeddings_hnsw ON localembed.article_embeddings USING hnsw(embedding vector_cosine_ops) WHERE configuration_id=1',
      );
      await assertRejects(() => buildIndexes(url!, true), Error, 'conflicting definition');
      await f.sql.unsafe(
        'DROP INDEX localembed.article_embeddings_hnsw; CREATE TABLE localembed.article_embeddings_hnsw(id integer)',
      );
      await assertRejects(() => buildIndexes(url!, true), Error, 'conflicting definition');
    } finally {
      await f.close();
    }
  },
});
Deno.test({
  name: 'online HNSW permits writes, fences administrators and recovers a cancelled invalid index',
  ignore: !url,
  fn: async () => {
    const f = await fixture();
    const blocker = postgres(url!, { max: 1, onnotice: () => {} });
    let building: Promise<unknown> | undefined;
    try {
      await backfill(url!);
      await f.worker.tick();
      // An old writer makes CREATE CONCURRENTLY wait after committing its invalid catalog entry.
      await blocker.unsafe('BEGIN');
      await blocker`UPDATE localembed.article_embeddings SET updated_at=clock_timestamp()`;
      building = buildIndexes(url!, true).then(() => null, (error) => error);
      await waitFor(async () =>
        (await f
          .sql`SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('localembed.article_embeddings_hnsw') AND NOT indisvalid`)
          .length > 0
      );
      // This update commits while the builder holds its DDL lock; use a separate row to avoid row contention.
      await f
        .sql`INSERT INTO localembed.article_embeddings(source_id,embedding,fingerprint,configuration_id) VALUES ('00000000-0000-0000-0000-000000000002','[0,1,0]','probe',1)`;
      await assertRejects(() => buildIndexes(url!, true), Error, 'Another administrator');
      await assertRejects(() => cleanup(url!, false), Error, 'Another administrator');
      await f
        .sql`SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name='localembed-index-admin' AND query LIKE 'CREATE INDEX CONCURRENTLY%'`;
      const error = await building;
      assertEquals(error instanceof Error, true);
      assertEquals((await f.sql`SELECT indexed FROM localembed.backfills`)[0].indexed, false);
      await blocker.unsafe('ROLLBACK');
      await buildIndexes(url!, true); // Drops only the invalid index with the matching definition.
      assertEquals(
        await validManagedIndex(f.sql, f.config.entities[0], f.config.providers[0]),
        true,
      );
      assertEquals(
        (await f.sql`SELECT count(*)::int AS count FROM localembed.article_embeddings`)[0].count,
        2,
      );
      assertEquals(
        (await f
          .sql`SELECT count(*)::int AS count FROM localembed.admin_actions WHERE action='index_build_started'`)[
            0
          ].count,
        2,
      );
    } finally {
      await blocker.unsafe('ROLLBACK').catch(() => {});
      await building;
      await blocker.end();
      await f.close();
    }
  },
});
Deno.test({
  name: 'a lost administrative session releases ownership and a fresh command recovers',
  ignore: !url,
  fn: async () => {
    const f = await fixture();
    const blocker = postgres(url!, { max: 1, onnotice: () => {} });
    let building: Promise<unknown> | undefined;
    try {
      await backfill(url!);
      await f.worker.tick();
      await blocker.unsafe('BEGIN');
      await blocker`UPDATE localembed.article_embeddings SET updated_at=clock_timestamp()`;
      building = buildIndexes(url!, true).then(() => null, (error) => error);
      await waitFor(async () =>
        (await f
          .sql`SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('localembed.article_embeddings_hnsw') AND NOT indisvalid`)
          .length > 0
      );
      await f
        .sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='localembed-index-admin' AND query LIKE 'CREATE INDEX CONCURRENTLY%'`;
      assertEquals((await building) instanceof Error, true);
      await blocker.unsafe('ROLLBACK');
      await buildIndexes(url!, true);
      assertEquals(
        await validManagedIndex(f.sql, f.config.entities[0], f.config.providers[0]),
        true,
      );
    } finally {
      await blocker.unsafe('ROLLBACK').catch(() => {});
      await building;
      await blocker.end();
      await f.close();
    }
  },
});
