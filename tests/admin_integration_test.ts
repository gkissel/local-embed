import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import postgres from 'npm:postgres@3.4.7';
import { applyConfiguration, validateConfiguration } from '../services/admin/apply.ts';
import example from '../contracts/examples/localembed.v1.example.json' with { type: 'json' };

Deno.test('configuration rejects invalid references and placeholders', () => {
  const invalidTemplate = structuredClone(example);
  invalidTemplate.entities[0].template = '{{missing}}';
  assertThrows(
    () => validateConfiguration(invalidTemplate),
    Error,
    'template field missing is not declared',
  );
  const config = structuredClone(example);
  config.entities[0].provider = 'missing';
  try {
    validateConfiguration(config);
    throw new Error('validation accepted invalid provider');
  } catch (error) {
    assertEquals((error as Error).message, 'article: unknown provider missing');
  }
});

Deno.test({
  name: 'apply is atomic and source changes persist tasks transactionally',
  ignore: Deno.permissions.querySync({ name: 'env', variable: 'TEST_DATABASE_URL' }).state !==
      'granted' || !Deno.env.get('TEST_DATABASE_URL'),
  fn: async () => {
    const url = Deno.env.get('TEST_DATABASE_URL')!;
    const sql = postgres(url, { max: 1 });
    const probe = async () => {};
    try {
      await sql.unsafe(
        'CREATE EXTENSION IF NOT EXISTS vector; DROP SCHEMA IF EXISTS localembed CASCADE; DROP TABLE IF EXISTS public.articles; CREATE TABLE public.articles (id uuid PRIMARY KEY, title text, body text)',
      );
      const invalid = structuredClone(example);
      invalid.entities[0].fields.push('missing');
      await assertRejects(
        () => applyConfiguration(url, invalid, probe),
        Error,
        'field missing does not exist',
      );
      const [absent] = await sql`SELECT to_regnamespace('localembed') AS schema`;
      assertEquals(absent.schema, null);
      await assertRejects(
        () =>
          applyConfiguration(url, example, () => Promise.reject(new Error('provider unavailable'))),
        Error,
        'provider unavailable',
      );
      await applyConfiguration(url, example, probe);
      await sql`INSERT INTO public.articles VALUES ('00000000-0000-0000-0000-000000000001', 'Title', 'Body')`;
      await sql`UPDATE public.articles SET title = 'Changed'`;
      await assertRejects(
        () =>
          sql.begin(async (tx) => {
            await tx`UPDATE public.articles SET title = 'Rolled back'`;
            throw new Error('rollback');
          }),
        Error,
        'rollback',
      );
      await sql`UPDATE public.articles SET id = '00000000-0000-0000-0000-000000000002'`;
      await sql`DELETE FROM public.articles`;
      const tasks =
        await sql`SELECT operation, source_id, status FROM localembed.tasks ORDER BY id`;
      assertEquals(tasks.map((t) => t.source_id), [
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000002',
      ]);
      assertEquals(tasks.map((t) => t.operation), [
        'upsert',
        'upsert',
        'delete',
        'upsert',
        'delete',
      ]);
      assertEquals(
        tasks.every((t) => t.status === 'pending'),
        true,
      );
      await assertRejects(
        () => applyConfiguration(url, example, probe),
        Error,
        'destination already exists',
      );
      const [count] = await sql`SELECT count(*)::int AS count FROM localembed.configurations`;
      assertEquals(count.count, 1);
    } finally {
      await sql.unsafe(
        'DROP SCHEMA IF EXISTS localembed CASCADE; DROP TABLE IF EXISTS public.articles',
      );
      await sql.end();
    }
  },
});
