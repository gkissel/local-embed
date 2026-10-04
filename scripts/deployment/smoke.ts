// Mandatory real-provider pre-release check, separate from simulated protocol tests.
const endpoint = Deno.env.get('LOCAL_EMBED_API_ENDPOINT') ?? 'http://127.0.0.1:8090';
const key = Deno.env.get('LOCAL_EMBED_SERVICE_KEY') ??
  (await Deno.readTextFile('deployments/.secrets/service_key')).trim();
const input = 'query: keyboard for quiet office typing';
async function request(entity: string, text: string, credential = key) {
  return await fetch(`${endpoint}/v1/embeddings`, {
    method: 'POST',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: JSON.stringify({ entity, input: text }),
    signal: AbortSignal.timeout(35000),
  });
}
function require(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const response = await request('demo_article', input);
require(response.status === 200, 'Real TEI query failed');
const result = await response.json();
require(result.model === 'intfloat/multilingual-e5-base', 'Unexpected model');
require(result.dimensions === 768 && result.embedding.length === 768, 'Expected 768 dimensions');
require(
  result.embedding.every((n: unknown) => typeof n === 'number' && Number.isFinite(n)),
  'Invalid vector',
);
require(result.embedding.some((n: number) => n !== 0), 'Zero vector');
require(/^localembed\/v1@\d+$/.test(result.generation.config_version), 'Missing applied revision');
require(/^[a-f0-9]{64}$/.test(result.generation.fingerprint), 'Missing generation fingerprint');
require(
  (await request('demo_article', input, 'invalid')).status === 401,
  'Unauthorized request accepted',
);
require((await request('unknown_entity', input)).status === 404, 'Unknown entity accepted');
// Under the API character limit, over the real model token limit: provider must reject.
const tooLong = await request('demo_article', 'query: ' + 'keyboard '.repeat(700));
require(tooLong.status === 503, 'Real model token overflow should be a sanitized provider failure');
const failure = await tooLong.text();
require(
  !failure.includes(key) && !failure.includes('keyboard') && !failure.includes('http'),
  'Provider details leaked',
);
console.log(
  JSON.stringify({
    event: 'real_tei_query_verified',
    model: result.model,
    dimensions: result.dimensions,
    config_version: result.generation.config_version,
  }),
);
