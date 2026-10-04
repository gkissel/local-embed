import { embeddings, HybridSearch } from './search.ts';
const url = Deno.env.get('DEMO_DATABASE_URL');
const endpoint = Deno.env.get('LOCAL_EMBED_API_ENDPOINT');
const key = Deno.env.get('LOCAL_EMBED_SERVICE_KEY');
const tenant = Deno.env.get('DEMO_TENANT');
if (!url || !endpoint || !key || !tenant || !Deno.args[0]) {
  throw new Error(
    'Set DEMO_DATABASE_URL, DEMO_TENANT, LOCAL_EMBED_API_ENDPOINT, LOCAL_EMBED_SERVICE_KEY and pass a query',
  );
}
const consumer = new HybridSearch(url, embeddings(endpoint, key));
try {
  console.log(JSON.stringify(
    await consumer.search(Deno.args[0], tenant, {
      vectorMode: (Deno.env.get('DEMO_VECTOR_MODE') ?? 'exact') as 'exact' | 'hnsw',
      candidateLimit: Number(Deno.env.get('DEMO_CANDIDATE_LIMIT') ?? 20),
      resultLimit: Number(Deno.env.get('DEMO_RESULT_LIMIT') ?? 5),
      rrfK: Number(Deno.env.get('DEMO_RRF_K') ?? 60),
      lexicalWeight: Number(Deno.env.get('DEMO_LEXICAL_WEIGHT') ?? 0.5),
      semanticWeight: Number(Deno.env.get('DEMO_SEMANTIC_WEIGHT') ?? 0.5),
    }),
    null,
    2,
  ));
} catch {
  console.error('Hybrid query failed; verify applied generation and service availability');
  Deno.exitCode = 1;
} finally {
  await consumer.close();
}
