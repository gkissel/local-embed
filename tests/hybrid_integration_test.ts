import { assert, assertEquals, assertRejects } from '@std/assert';
import postgres from 'npm:postgres@3.4.7';
import { demoConfiguration, setup } from '../examples/hybrid-search/setup.ts';
import {
  active,
  type Embeddings,
  embeddings,
  HybridSearch,
  parameters,
  rank,
} from '../examples/hybrid-search/search.ts';
import { createComparison, VARIANT } from '../examples/hybrid-search/comparison.ts';
import { ConfigurationStore, createHandler } from '../services/api/api.ts';
import { applyConfiguration } from '../services/admin/apply.ts';
import { activate } from '../services/admin/revisions.ts';
import { backfill, buildIndexes } from '../services/admin/synchronize.ts';
import { type Generate, Worker } from '../services/worker/worker.ts';
const ignored = () =>
  Deno.permissions.querySync({ name: 'env', variable: 'TEST_DATABASE_URL' }).state !== 'granted' ||
  !Deno.env.get('TEST_DATABASE_URL');
const inference: Generate = (provider, text) => {
  const vector = text.startsWith('query:') || text.includes('Quiet typing')
    ? [1, 0, 0]
    : text.includes('Mechanical keyboard')
    ? [0.8, 0.6, 0]
    : [0, 1, 0];
  return Promise.resolve([...vector, ...Array(provider.dimensions - 3).fill(0)]);
};
async function drain(url: string) {
  const worker = new Worker(url, inference);
  try {
    while (await worker.tick()) { /* bounded fixture work */ }
  } finally {
    await worker.close();
  }
}
async function fixture(
  run: (sql: ReturnType<typeof postgres>, url: string, generate: Embeddings) => Promise<void>,
) {
  const url = Deno.env.get('TEST_DATABASE_URL')!;
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const store = new ConfigurationStore(url);
  const key = 'a'.repeat(64);
  let server: Deno.HttpServer<Deno.NetAddr> | undefined;
  try {
    await sql.unsafe(
      'DROP SCHEMA IF EXISTS hybrid_compare CASCADE; DROP SCHEMA IF EXISTS localembed CASCADE; DROP SCHEMA IF EXISTS hybrid_demo CASCADE',
    );
    await setup(url, demoConfiguration(3), true);
    await backfill(url);
    await drain(url);
    await buildIndexes(url);
    server = Deno.serve(
      { hostname: '127.0.0.1', port: 0, onListen: () => {} },
      createHandler(key, (entity) => store.load(entity), inference),
    );
    await run(sql, url, embeddings(`http://127.0.0.1:${server.addr.port}`, key));
  } finally {
    await server?.shutdown();
    await store.close();
    await sql.unsafe(
      'DROP SCHEMA IF EXISTS hybrid_compare CASCADE; DROP SCHEMA IF EXISTS localembed CASCADE; DROP SCHEMA IF EXISTS hybrid_demo CASCADE; DROP ROLE IF EXISTS hybrid_reader_test',
    );
    await sql.end();
  }
}
Deno.test({
  name:
    'real BM25 and pgvector consumer query fuses API vectors and excludes other tenants/drafts in both branches',
  ignore: ignored(),
  fn: () =>
    fixture(async (_sql, url, generate) => {
      const consumer = new HybridSearch(url, generate);
      try {
        const result = await consumer.search('keyboard', 'alpha', { candidateLimit: 3 });
        assertEquals(result.revision, '1');
        assertEquals(result.candidates.lexical, ['1']);
        assertEquals(result.candidates.semantic.slice(0, 2), ['2', '1']);
        assertEquals(result.results[0].id, '1');
        assertEquals(result.results[0].score, 0.5 / 61 + 0.5 / 62);
        for (const id of [...result.candidates.lexical, ...result.candidates.semantic]) {
          assert(!['7', '8'].includes(id));
        }
        assertEquals(JSON.stringify(result).includes('PRIVATE_'), false);
      } finally {
        await consumer.close();
      }
    }),
});
Deno.test({
  name:
    'hybrid freshness survives task cleanup; stale/missing/wrong-generation vectors remain lexical-only',
  ignore: ignored(),
  fn: () =>
    fixture(async (sql, url, generate) => {
      const consumer = new HybridSearch(url, generate);
      try {
        await sql`DELETE FROM localembed.tasks WHERE status = 'done'`;
        await sql`UPDATE hybrid_demo.articles SET body = 'changed keyboard information' WHERE id = 1`;
        let result = await consumer.search('keyboard', 'alpha');
        assert(result.candidates.lexical.includes('1'));
        assert(!result.candidates.semantic.includes('1'));
        assertEquals(result.candidates.stale, 1);
        await sql`DELETE FROM localembed.demo_article_embeddings WHERE source_id = 2`;
        await sql`UPDATE localembed.demo_article_embeddings SET embedding = '[0,0,0]'::vector WHERE source_id = 3`;
        result = await consumer.search('keyboard', 'alpha');
        assert(!result.candidates.semantic.includes('2'));
        assert(!result.candidates.semantic.includes('3'));
        await sql`INSERT INTO localembed.configurations(configuration) SELECT configuration FROM localembed.configurations WHERE id=1`;
        await sql`UPDATE localembed.demo_article_embeddings SET configuration_id=2 WHERE source_id=6`;
        assert(!(await consumer.search('keyboard', 'alpha')).candidates.semantic.includes('6'));
        const ann = await consumer.search('keyboard', 'alpha', { vectorMode: 'hnsw' });
        for (const id of [...ann.candidates.lexical, ...ann.candidates.semantic]) {
          assert(!['7', '8'].includes(id));
        }
        const bad = new HybridSearch(
          url,
          async (input) => ({ ...await generate(input), embedding: [0, 0, 0] }),
        );
        try {
          await assertRejects(() => bad.search('keyboard', 'alpha'), Error, 'incompatible');
        } finally {
          await bad.close();
        }
      } finally {
        await consumer.close();
      }
    }),
});
Deno.test({
  name: 'consumer repeats query inference after activation and rejects unbounded generation races',
  ignore: ignored(),
  fn: () =>
    fixture(async (_sql, url, generate) => {
      let calls = 0;
      const consumer = new HybridSearch(url, async (input) => {
        const response = await generate(input);
        if (++calls === 1) {
          const config = demoConfiguration(4);
          config.entities[0].destination.table = 'localembed.demo_article_embeddings_v2';
          const revision = await applyConfiguration(url, config, () => Promise.resolve(), true);
          await backfill(url);
          await drain(url);
          await buildIndexes(url);
          await activate(url, revision);
        }
        return response;
      });
      try {
        assertEquals((await consumer.search('keyboard', 'alpha')).revision, '2');
        assertEquals(calls, 2);
      } finally {
        await consumer.close();
      }
      calls = 0;
      const stale = new HybridSearch(url, async (input) => {
        calls++;
        const value = await generate(input);
        value.generation.config_version = 'localembed/v1@1';
        return value;
      });
      try {
        await assertRejects(() => stale.search('keyboard', 'alpha'), Error, 'changed repeatedly');
        assertEquals(calls, 3);
      } finally {
        await stale.close();
      }
    }),
});
Deno.test({
  name:
    'same-table experimental ranking matches separate exact candidates and restricted reader needs no writes',
  ignore: ignored(),
  fn: () =>
    fixture(async (sql, url, generate) => {
      await sql.begin(async (tx) => {
        const generation = await active(tx);
        await createComparison(tx, generation);
        const separate = await rank(tx, generation, [1, 0, 0], 'keyboard', 'alpha', parameters());
        const same = await rank(
          tx,
          generation,
          [1, 0, 0],
          'keyboard',
          'alpha',
          parameters(),
          VARIANT,
        );
        assertEquals(same.results, separate.results);
        assertEquals(same.candidates, separate.candidates);
      });
      await sql.unsafe(
        'CREATE ROLE hybrid_reader_test NOLOGIN; GRANT USAGE ON SCHEMA hybrid_demo, localembed TO hybrid_reader_test; GRANT SELECT ON hybrid_demo.articles, localembed.configurations, localembed.entity_revisions, localembed.demo_article_embeddings TO hybrid_reader_test',
      );
      const address = new URL(url);
      address.searchParams.set('options', '-c role=hybrid_reader_test');
      const consumer = new HybridSearch(address.toString(), generate);
      try {
        assertEquals((await consumer.search('keyboard', 'alpha')).results[0].id, '1');
      } finally {
        await consumer.close();
      }
      const reader = postgres(address.toString(), { max: 1 });
      try {
        await assertRejects(
          () => reader`UPDATE hybrid_demo.articles SET title = 'forbidden'`,
          Error,
          'permission denied',
        );
      } finally {
        await reader.end();
      }
    }),
});

Deno.test({
  name:
    'read-only consumer snapshot deliberately completes on retained generation after activation',
  ignore: ignored(),
  fn: () =>
    fixture(async (sql, url) => {
      const config = demoConfiguration(4);
      config.entities[0].destination.table = 'localembed.demo_article_embeddings_v2';
      const revision = await applyConfiguration(url, config, () => Promise.resolve(), true);
      await backfill(url);
      await drain(url);
      await buildIndexes(url);
      await sql.begin('isolation level repeatable read read only', async (tx) => {
        const generation = await active(tx);
        assertEquals(generation.revision, '1');
        await activate(url, revision);
        const retained = await rank(tx, generation, [1, 0, 0], 'keyboard', 'alpha', parameters());
        assertEquals(retained.results[0].id, '1');
      });
      await sql.begin('read only', async (tx) => assertEquals((await active(tx)).revision, '2'));
    }),
});
