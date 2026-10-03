import postgres from 'npm:postgres@3.4.7';

// Destructive disposable-database probe. A source root allows the same workload
// to exercise the pre-coalescing commit through an isolated checkout.
const url = Deno.env.get('TEST_DATABASE_URL');
if (!url) throw new Error('TEST_DATABASE_URL must point to a disposable database');
const root = new URL(Deno.env.get('LOCAL_EMBED_SOURCE_ROOT') ?? '../', import.meta.url);
const { applyConfiguration } = await import(new URL('services/admin/apply.ts', root).href);
const { Worker } = await import(new URL('services/worker/worker.ts', root).href);
const config = JSON.parse(
  await Deno.readTextFile(new URL('contracts/examples/localembed.v1.example.json', root)),
);
config.entities[0].source.id.type = 'bigint';
const sql = postgres(url, { max: 1, onnotice: () => {} });
type WorkerLike = { tick(): Promise<boolean>; close(): Promise<void> };
const workers: WorkerLike[] = [];
try {
  await sql.unsafe(
    'CREATE EXTENSION IF NOT EXISTS vector; DROP SCHEMA IF EXISTS localembed CASCADE; DROP TABLE IF EXISTS public.articles; CREATE TABLE public.articles(id bigint PRIMARY KEY, title text, body text, views integer DEFAULT 0)',
  );
  await applyConfiguration(url, config, () => Promise.resolve());
  await sql`INSERT INTO public.articles(id,title,body) VALUES (1,'Initial','Body')`;
  await sql.begin(async (tx) => {
    for (let i = 0; i < 50; i++) await tx`UPDATE public.articles SET views = views + 1`;
    for (let i = 0; i < 50; i++) await tx`UPDATE public.articles SET title = title`;
    for (let i = 0; i < 20; i++) await tx`UPDATE public.articles SET title = ${'Changed ' + i}`;
  });
  const [count] = await sql`SELECT count(*)::int AS rows FROM localembed.tasks`;
  const columns =
    await sql`SELECT 1 FROM information_schema.columns WHERE table_schema = 'localembed' AND table_name = 'tasks' AND column_name = 'generation'`;
  const captures = columns.length
    ? Number((await sql`SELECT sum(generation) AS captures FROM localembed.tasks`)[0].captures)
    : count.rows;
  let calls = 0;
  let settled = 0;
  const release = Promise.withResolvers<void>();
  const inference = async () => {
    calls++;
    await release.promise;
    return Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0);
  };
  for (let i = 0; i < 3; i++) workers.push(new Worker(url, inference));
  const tasks = workers.map((worker) =>
    worker.tick().then(() => {
      settled++;
    })
  );
  try {
    const deadline = Date.now() + 10000;
    while (calls + settled < 3) {
      if (Date.now() > deadline) throw new Error('Workers did not reach the inference barrier');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    release.resolve();
  }
  await Promise.all(tasks);
  while ((await Promise.all(workers.map((worker) => worker.tick()))).some(Boolean)) { /* drain */ }
  const [destination] = await sql`SELECT count(*)::int AS rows FROM localembed.article_embeddings`;
  console.log(
    JSON.stringify({
      workload: {
        inserts: 1,
        unrelated_updates: 50,
        unchanged_updates: 50,
        content_updates: 20,
        workers: 3,
      },
      trigger_captures: captures,
      queue_rows: count.rows,
      inference_calls: calls,
      destination_rows: destination.rows,
    }),
  );
} finally {
  await Promise.all(workers.map((worker) => worker.close()));
  await sql.unsafe(
    'DROP SCHEMA IF EXISTS localembed CASCADE; DROP TABLE IF EXISTS public.articles',
  );
  await sql.end();
}
