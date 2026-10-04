import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import postgres from 'npm:postgres@3.4.7';
import {
  applyConfiguration,
  type Configuration,
  validateConfiguration,
} from '../services/admin/apply.ts';
import { prepareWorker } from '../services/admin/synchronize.ts';
import { Poller } from '../services/poller/poller.ts';
import { type Generate, Worker } from '../services/worker/worker.ts';
import example from '../contracts/examples/localembed.v1.example.json' with { type: 'json' };

const configured = (mode = 'polling'): Configuration => ({
  version: 'localembed/v1',
  providers: [{ ...example.providers[0], type: 'tei', metric: 'cosine', dimensions: 3 }],
  entities: [{
    name: 'product',
    source: {
      table: 'public.products',
      id: { column: 'id', type: 'bigint' },
      detection: {
        mode,
        ...(mode === 'polling' ? { updated_at: 'updated_at', overlap_seconds: 0 } : {}),
      },
    },
    fields: ['title'],
    dependencies: [{
      name: 'category',
      relation: 'one',
      fields: ['name'],
      source_column: 'category_id',
      target: { table: 'public.categories', id: { column: 'id', type: 'bigint' } },
    }],
    provider: example.providers[0].name,
    template: '{{title}} {{category.name}}',
    destination: { table: 'localembed.product_embeddings' },
  }],
});
const ignored = () =>
  Deno.permissions.querySync({ name: 'env', variable: 'TEST_DATABASE_URL' }).state !== 'granted' ||
  !Deno.env.get('TEST_DATABASE_URL');
const setup = async (sql: ReturnType<typeof postgres>) => {
  await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS vector;
    DROP SCHEMA IF EXISTS localembed CASCADE;
    DROP TABLE IF EXISTS public.products; DROP TABLE IF EXISTS public.categories;
    CREATE TABLE public.categories(id bigint PRIMARY KEY, name text, irrelevant text);
    CREATE TABLE public.products(id bigint PRIMARY KEY, title text, category_id bigint, updated_at timestamptz NOT NULL);
    INSERT INTO public.categories VALUES(1, 'First category', ''), (2, 'Second category', '')`);
};
const cleanup = async (sql: ReturnType<typeof postgres>) => {
  await sql.unsafe(
    'DROP SCHEMA IF EXISTS localembed CASCADE; DROP TABLE IF EXISTS public.products; DROP TABLE IF EXISTS public.categories',
  );
  await sql.end();
};
const drain = async (worker: Worker) => {
  let limit = 30;
  while (await worker.tick()) {
    if (!--limit) throw new Error('Queue did not converge');
  }
};

Deno.test('dependency contract rejects ambiguous relations and undeclared template fields', () => {
  const config = configured();
  assertEquals(validateConfiguration(config), config);
  config.entities[0].dependencies![0].relation = 'many';
  assertThrows(() => validateConfiguration(config), Error, 'many-to-one');
  config.entities[0].dependencies![0].relation = 'one';
  config.entities[0].template = '{{category.missing}}';
  assertThrows(() => validateConfiguration(config), Error, 'not declared');
});

Deno.test({
  name:
    'polling resumes typed tied timestamp cursors, skips unchanged input and reconciles physical deletion',
  ignore: ignored(),
  fn: async () => {
    const url = Deno.env.get('TEST_DATABASE_URL')!;
    const sql = postgres(url, { max: 1 });
    let poller = new Poller(url, 1);
    const inputs: string[] = [];
    const worker = new Worker(url, (_provider, text) => {
      inputs.push(text);
      return Promise.resolve([1, 0, 0]);
    });
    try {
      await setup(sql);
      const config = configured();
      await applyConfiguration(url, config, () => Promise.resolve());
      await sql.unsafe(
        "INSERT INTO public.products VALUES (1, 'One', 1, '2020-01-01 00:00:00.123456+00'), (2, 'Two', 1, '2020-01-01 00:00:00.123456+00'), (10, 'Ten', 2, '2020-01-01 00:00:00.123456+00')",
      );
      const triggers =
        await sql`SELECT 1 FROM pg_trigger WHERE tgrelid IN ('public.products'::regclass, 'public.categories'::regclass) AND NOT tgisinternal`;
      assertEquals(triggers.length, 0);
      await poller.tick();
      const [cursor] =
        await sql`SELECT cursor_id, cursor_time::text AS stamp FROM localembed.polling_state`;
      assertEquals(cursor.cursor_id, '1');
      assertEquals(cursor.stamp.includes('.123456'), true);
      await poller.close();
      poller = new Poller(url, 1);
      await poller.tick();
      await poller.tick();
      const tasks = await sql`SELECT source_id FROM localembed.tasks ORDER BY id`;
      assertEquals(tasks.map((task) => task.source_id), ['1', '2', '10']);
      await drain(worker);
      assertEquals(inputs, ['One First category', 'Two First category', 'Ten Second category']);
      for (let i = 0; i < 4; i++) await poller.tick();
      const before = await sql`SELECT source_id, generation FROM localembed.tasks ORDER BY id`;
      await poller.tick();
      await drain(worker);
      assertEquals(
        await sql`SELECT source_id, generation FROM localembed.tasks ORDER BY id`,
        before,
      );
      assertEquals(inputs.length, 3);
      await sql`DELETE FROM public.products WHERE id = 2`;
      await sql`UPDATE localembed.polling_state SET next_reconcile = '-infinity'`;
      for (let i = 0; i < 5; i++) await poller.tick();
      await drain(worker);
      const rows =
        await sql`SELECT source_id FROM localembed.product_embeddings ORDER BY source_id`;
      assertEquals(rows.map((row) => row.source_id), ['1', '10']);
    } finally {
      await poller.close();
      await worker.close();
      await cleanup(sql);
    }
  },
});

Deno.test({
  name:
    'full reconciliation finds late commits, dependency-only changes and identifiers behind the cursor',
  ignore: ignored(),
  fn: async () => {
    const url = Deno.env.get('TEST_DATABASE_URL')!;
    const sql = postgres(url, { max: 1 });
    const writer = postgres(url, { max: 1 });
    const poller = new Poller(url, 2);
    const inputs: string[] = [];
    const worker = new Worker(url, (_provider, text) => {
      inputs.push(text);
      return Promise.resolve([1, 0, 0]);
    });
    let commit!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const release = new Promise<void>((resolve) => {
      commit = resolve;
    });
    let transaction: Promise<unknown> | undefined;
    try {
      await setup(sql);
      await sql.unsafe("INSERT INTO public.products VALUES (10, 'Initial', 1, '2020-01-01')");
      await applyConfiguration(url, configured(), () => Promise.resolve());
      await poller.tick();
      await drain(worker);
      transaction = writer.begin(async (tx) => {
        await tx.unsafe(
          "UPDATE public.products SET title = 'Late commit', updated_at = '2020-01-02' WHERE id = 10; INSERT INTO public.products VALUES (1, 'Late insert', 2, '2019-01-01')",
        );
        started();
        await release;
      });
      await ready;
      // Polling advances its timestamp window while the writer is still uncommitted.
      await poller.tick();
      await poller.tick();
      commit();
      await transaction;
      await poller.tick();
      await drain(worker);
      assertEquals(inputs, ['Initial First category']);
      await sql`UPDATE localembed.polling_state SET next_reconcile = '-infinity'`;
      for (let i = 0; i < 4; i++) await poller.tick();
      await drain(worker);
      assertEquals(inputs.includes('Late commit First category'), true);
      assertEquals(inputs.includes('Late insert Second category'), true);
      await sql`UPDATE public.categories SET name = 'Changed dependency' WHERE id = 1`;
      await sql`UPDATE localembed.polling_state SET next_reconcile = '-infinity'`;
      for (let i = 0; i < 4; i++) await poller.tick();
      await drain(worker);
      assertEquals(inputs.at(-1), 'Late commit Changed dependency');
      await sql`DELETE FROM public.categories WHERE id = 1`;
      await sql`UPDATE localembed.polling_state SET next_reconcile = '-infinity'`;
      for (let i = 0; i < 4; i++) await poller.tick();
      await drain(worker);
      assertEquals(inputs.at(-1), 'Late commit ');
    } finally {
      commit();
      await transaction;
      await writer.end();
      await poller.close();
      await worker.close();
      await cleanup(sql);
    }
  },
});

Deno.test({
  name:
    'trigger dependency fan-out includes inserts, deletes, key and relation changes and fences old inference',
  ignore: ignored(),
  fn: async () => {
    const url = Deno.env.get('TEST_DATABASE_URL')!;
    const sql = postgres(url, { max: 1 });
    let change = false;
    const inputs: string[] = [];
    const inference: Generate = async (_provider, text) => {
      inputs.push(text);
      if (change) {
        change = false;
        await sql`UPDATE public.categories SET name = 'Changed during inference' WHERE id = 1`;
      }
      return [1, 0, 0];
    };
    const worker = new Worker(url, inference);
    try {
      await setup(sql);
      await applyConfiguration(url, configured('trigger'), () => Promise.resolve());
      await sql.unsafe(
        "INSERT INTO public.products VALUES (1, 'One', 1, now()), (2, 'Two', 1, now()), (10, 'Ten', 2, now())",
      );
      await drain(worker);
      await sql`UPDATE public.categories SET irrelevant = 'No task' WHERE id = 1`;
      assertEquals(await worker.tick(), false);
      await sql`UPDATE public.categories SET name = 'Changed' WHERE id = 1`;
      change = true;
      await drain(worker);
      assertEquals(inputs.includes('One Changed during inference'), true);
      assertEquals(inputs.includes('Two Changed during inference'), true);
      assertEquals(inputs.filter((text) => text.startsWith('Ten')).length, 1);
      await sql`UPDATE public.products SET category_id = 2 WHERE id = 1`;
      await drain(worker);
      assertEquals(inputs.at(-1), 'One Second category');
      await sql`UPDATE public.categories SET id = 3 WHERE id = 2`;
      await drain(worker);
      assertEquals(inputs.includes('Ten '), true);
      await sql`INSERT INTO public.categories VALUES (2, 'Reinserted', '')`;
      await drain(worker);
      assertEquals(inputs.includes('One Reinserted'), true);
      await sql`DELETE FROM public.categories WHERE id = 2`;
      await drain(worker);
      assertEquals(inputs.at(-1)?.endsWith(' '), true);
      const before = await sql`SELECT source_id, generation FROM localembed.tasks ORDER BY id`;
      await assertRejects(
        () =>
          sql.begin(async (tx) => {
            await tx`UPDATE public.categories SET name = 'Rollback' WHERE id = 1`;
            throw new Error('rollback');
          }),
        Error,
        'rollback',
      );
      assertEquals(
        await sql`SELECT source_id, generation FROM localembed.tasks ORDER BY id`,
        before,
      );
      await prepareWorker(url);
      assertEquals(await worker.tick(), false);
      await sql`UPDATE public.categories SET name = 'After prepare' WHERE id = 1`;
      await drain(worker);
      assertEquals(inputs.at(-1), 'Two After prepare');
    } finally {
      await worker.close();
      await cleanup(sql);
    }
  },
});

Deno.test({
  name: 'polling and dependency provisioning reject incompatible columns atomically',
  ignore: ignored(),
  fn: async () => {
    const url = Deno.env.get('TEST_DATABASE_URL')!;
    const sql = postgres(url, { max: 1 });
    try {
      await setup(sql);
      const config = configured();
      config.entities[0].source.detection.updated_at = 'title';
      await assertRejects(
        () => applyConfiguration(url, config, () => Promise.resolve()),
        Error,
        'non-null timestamptz',
      );
      const [absent] = await sql`SELECT to_regnamespace('localembed') AS schema`;
      assertEquals(absent.schema, null);
      config.entities[0].source.detection.updated_at = 'updated_at';
      config.entities[0].dependencies![0].source_column = 'title';
      await assertRejects(
        () => applyConfiguration(url, config, () => Promise.resolve()),
        Error,
        'compatible source column',
      );
      config.entities[0].dependencies![0].source_column = 'category_id';
      config.entities[0].dependencies![0].fields = ['name', 'missing'];
      await assertRejects(
        () => applyConfiguration(url, config, () => Promise.resolve()),
        Error,
        'does not exist',
      );
      assertEquals((await sql`SELECT to_regnamespace('localembed') AS schema`)[0].schema, null);
    } finally {
      await cleanup(sql);
    }
  },
});

Deno.test({
  name:
    'concurrent restricted pollers preserve durable cursors and read-only worker locks dependency rows',
  ignore: ignored(),
  fn: async () => {
    const url = Deno.env.get('TEST_DATABASE_URL')!;
    const sql = postgres(url, { max: 1 });
    let worker: Worker | undefined;
    const pollers: Poller[] = [];
    try {
      await setup(sql);
      await applyConfiguration(url, configured(), () => Promise.resolve());
      await sql.unsafe(
        "INSERT INTO public.products VALUES (1, 'One', 1, now()), (2, 'Two', 2, now()); CREATE ROLE localembed_poll_test NOLOGIN; CREATE ROLE localembed_dep_worker_test NOLOGIN; GRANT USAGE ON SCHEMA localembed, public TO localembed_poll_test, localembed_dep_worker_test; GRANT SELECT ON public.products, public.categories, localembed.configurations, localembed.entity_revisions TO localembed_poll_test, localembed_dep_worker_test; GRANT EXECUTE ON FUNCTION localembed.revision_eligible(bigint, text) TO localembed_poll_test, localembed_dep_worker_test; GRANT SELECT ON localembed.product_embeddings TO localembed_poll_test; GRANT SELECT, INSERT, UPDATE ON localembed.polling_state, localembed.tasks TO localembed_poll_test; GRANT USAGE ON SEQUENCE localembed.tasks_id_seq TO localembed_poll_test; GRANT EXECUTE ON FUNCTION localembed.enqueue_task(bigint, text, text, text) TO localembed_poll_test; GRANT SELECT, UPDATE ON localembed.tasks TO localembed_dep_worker_test; GRANT SELECT, INSERT, UPDATE, DELETE ON localembed.product_embeddings TO localembed_dep_worker_test; GRANT EXECUTE ON FUNCTION localembed.lock_source_product(text), localembed.lock_dep_product_0(text) TO localembed_dep_worker_test",
      );
      const restricted = (role: string) => {
        const address = new URL(url);
        address.searchParams.set('options', '-c role=' + role);
        return address.toString();
      };
      pollers.push(
        new Poller(restricted('localembed_poll_test'), 1),
        new Poller(restricted('localembed_poll_test'), 1),
      );
      await Promise.all(pollers.map((poller) => poller.tick()));
      const tasks = await sql`SELECT source_id, generation FROM localembed.tasks ORDER BY id`;
      assertEquals(tasks.map((task) => task.source_id), ['1', '2']);
      assertEquals(tasks.map((task) => task.generation), ['1', '1']);
      const texts: string[] = [];
      worker = new Worker(restricted('localembed_dep_worker_test'), (_provider, text) => {
        texts.push(text);
        return Promise.resolve([1, 0, 0]);
      });
      await drain(worker);
      assertEquals(texts.sort(), ['One First category', 'Two Second category']);
      const [permissions] =
        await sql`SELECT has_table_privilege('localembed_dep_worker_test', 'public.products', 'UPDATE') AS root_update, has_table_privilege('localembed_dep_worker_test', 'public.categories', 'UPDATE') AS dependency_update`;
      assertEquals(permissions.root_update, false);
      assertEquals(permissions.dependency_update, false);
    } finally {
      await worker?.close();
      await Promise.all(pollers.map((poller) => poller.close()));
      await sql.unsafe(
        'DROP OWNED BY localembed_poll_test, localembed_dep_worker_test; DROP ROLE localembed_poll_test, localembed_dep_worker_test',
      );
      await cleanup(sql);
    }
  },
});

Deno.test({
  name:
    'polling worker discards results after concurrent source changes and deletion without capture triggers',
  ignore: ignored(),
  fn: async () => {
    const url = Deno.env.get('TEST_DATABASE_URL')!;
    const sql = postgres(url, { max: 1 });
    const poller = new Poller(url, 10);
    let action: (() => Promise<unknown>) | undefined;
    const inputs: string[] = [];
    const worker = new Worker(url, async (_provider, text) => {
      inputs.push(text);
      const current = action;
      action = undefined;
      if (current) await current();
      return [1, 0, 0];
    });
    try {
      await setup(sql);
      await applyConfiguration(url, configured(), () => Promise.resolve());
      await sql.unsafe("INSERT INTO public.products VALUES (1, 'Before', 1, '2020-01-01')");
      await poller.tick();
      action = () => sql`UPDATE public.products SET title = 'During', category_id = 2 WHERE id = 1`;
      await drain(worker);
      assertEquals(inputs, ['Before First category', 'During Second category']);
      await sql`UPDATE public.products SET title = 'Delete while computing', updated_at = clock_timestamp() WHERE id = 1`;
      await poller.tick();
      await poller.tick();
      action = () => sql`DELETE FROM public.products WHERE id = 1`;
      await drain(worker);
      assertEquals((await sql`SELECT * FROM localembed.product_embeddings`).length, 0);
      await sql.unsafe(
        "INSERT INTO public.products VALUES (1, 'Reinserted', 1, clock_timestamp())",
      );
      await poller.tick();
      await poller.tick();
      await drain(worker);
      assertEquals(inputs.at(-1), 'Reinserted First category');
      assertEquals((await sql`SELECT * FROM localembed.product_embeddings`).length, 1);
    } finally {
      await poller.close();
      await worker.close();
      await cleanup(sql);
    }
  },
});
