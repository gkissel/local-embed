# Consumer hybrid-search demonstration (#8)

`examples/hybrid-search/` is a consumer application. It obtains a query embedding from LocalEmbed's
HTTP API, retrieves lexical candidates through ParadeDB/pg_search and semantic candidates through
pgvector, then performs reciprocal-rank fusion (RRF). Search, tenant policy, result content and
ranking parameters belong to this demonstrator. LocalEmbed's schema/API/runtime search behavior is
unchanged; managed destinations remain the storage decision in ADR-0007.

## Run with the reference model

Use the pinned ParadeDB PostgreSQL 18 image in `deployments/database.compose.yaml` and pinned TEI
image/model revision in `deployments/tei.compose.yaml`. Setup requires an administrative URL,
pg_search/pgvector and running TEI with `LOCAL_EMBED_TEI_API_KEY` set. A new demo schema is created;
existing `hybrid_demo` is rejected rather than overwritten.

```sh
DATABASE_URL='<administrative URL>' deno task demo:setup
DATABASE_URL='<administrative URL>' deno task localembed backfill
```

The applied entity is `demo_article`, source `hybrid_demo.articles`, bigint identifier `id`, and
destination `localembed.demo_article_embeddings`. Its provider is the reference multilingual E5
model with 768 dimensions and a `passage:` template. Worker/API startup and migrations follow the
README and resilience guide. Run the worker until backfill tasks finish, then build HNSW:

```sh
DATABASE_URL='<administrative URL>' deno task localembed build-indexes
```

The source BM25 index uses `USING bm25` with `id`, `tenant_id`, `published`, `title` and `body`.
This is the syntax exercised on pg_search 0.22.6; newer docs call the access method `paradedb`
starting in 0.25.0. Do not silently substitute extension/model versions in a reproducibility report.

Grant existing worker/source-writer privileges for this entity, including
`localembed.lock_source_demo_article(text)` to the worker. The consumer uses a separate reader:

```sql
CREATE ROLE hybrid_reader LOGIN;
-- Provision its password through your normal secret mechanism.
GRANT USAGE ON SCHEMA hybrid_demo, localembed TO hybrid_reader;
GRANT SELECT ON hybrid_demo.articles, localembed.configurations,
  localembed.entity_revisions, localembed.demo_article_embeddings TO hybrid_reader;
```

No source/destination writes, queue privileges or administrative locking helpers are required for
search. When staging another destination, grant its SELECT permission before activation. The
read-only repeatable-read transaction provides one source/generation snapshot for each ranking.

Start the existing query API and use:

```sh
DEMO_DATABASE_URL='<reader URL>' DEMO_TENANT=alpha \
  LOCAL_EMBED_API_ENDPOINT=http://127.0.0.1:8090 \
  LOCAL_EMBED_SERVICE_KEY='<configured service key>' \
  deno task demo:search 'keyboard'
```

The CLI prints revision, ranking parameters, candidate identifiers/counts and final authorized
source content. Synthetic integration tests use a controlled three-dimensional provider; the
real-model run above is available but was not executed for #8. TEI API verification remains #17. An
unsuccessful provider preflight rolls back LocalEmbed provisioning but can leave the separately
created demo source/schema; use a fresh disposable environment for retries.

## Ranking and freshness

| Parameter/environment  | Default                  |
| ---------------------- | ------------------------ |
| `DEMO_CANDIDATE_LIMIT` | 20 per ranker            |
| `DEMO_RESULT_LIMIT`    | 5 results                |
| `DEMO_RRF_K`           | 60                       |
| `DEMO_LEXICAL_WEIGHT`  | 0.5                      |
| `DEMO_SEMANTIC_WEIGHT` | 0.5                      |
| `DEMO_VECTOR_MODE`     | `exact`; optional `hnsw` |

For a document `d`, with 1-based rank and no contribution from a missing ranker:

```text
score(d) = lexicalWeight / (rrfK + lexicalRank(d))
         + semanticWeight / (rrfK + semanticRank(d))
```

A zero weight disables that branch's contribution. Raw BM25 scores and cosine distances are not
summed. Each branch and the final merge use numeric bigint identifiers to break ties; IDs remain
strings in JSON, including values above JavaScript's exact integer range. Limits/k are bounded
integers, and weights are finite 0..1 with at least one positive weight.

The API receives `query: <text>` for E5; BM25 receives the unprefixed text. Prefix/token preparation
is demonstrator-owned pending #14. The consumer verifies `config_version=localembed/v1@<revision>`,
provider/model, dimensions, finite nonzero cosine vector and the query fingerprint against the
active generation resolved inside its database snapshot. A mismatched revision retries the API
request, with at most three generation attempts. Continuous activation fails explicitly rather than
mixing dimensions/generations. Retries can duplicate query inference; cache work remains #16.

If activation commits **after** the repeatable-read snapshot has resolved an older active revision,
that request deliberately finishes against the retained old destination and old source snapshot.
This is an explicit retained-snapshot policy, not a promise to return the newest revision at the
instant the response arrives. Keep retired destinations until reader grace/retention permits their
removal (#12). A missing destination during a cleanup race also causes a bounded generation retry.

Both candidate branches bind the same tenant and `published=true` before limiting candidates; final
content retrieval repeats the filters. Tenant selection comes from trusted consumer/operator
context. These predicates are not an authentication system or a claim of database RLS isolation: the
demo reader is a trusted server role able to read its source tables. A public multiuser consumer
must derive tenant identity from its authentication/authorization, not arbitrary request input.

Semantic retrieval selects a bounded pool of at most `4 * candidateLimit`. For that pool, it fetches
only configured content fields and recomputes fingerprints under the same snapshot, dropping stale,
wrong-revision, zero or missing embeddings. Task cleanup therefore cannot make freshness checks
silently accept stale vectors. Lexical matches remain eligible while embeddings are missing or
outdated. After freshness checks, semantic candidates are re-ranked and bounded to candidateLimit.
Results can underfill if too many pool vectors are outdated; full freshness scanning is not hidden
inside the query. Final source title/body is fetched only for fused result IDs, except content
fields already required for bounded freshness checks.

`exact` uses a distance expression that prevents an ANN index scan and deterministically breaks
cutoff ties by source ID. `hnsw` opts into approximate candidate retrieval with iterative scans and
`ef_search=100`; freshness/security filters still apply, but approximate membership/recall can
differ. The planner may choose a different path. The eligibility EXISTS can become a semi-join
before top-k; security filters must be applied before candidate admission. A CTE/view does not prove
join-free or faster execution. Recorded plans show the actual behavior.

## Storage comparison

The disposable comparison copies the same source data/vectors into `hybrid_compare.articles`, with
BM25 and HNSW indexes. It is a snapshot experiment, not a supported same-table LocalEmbed
destination or a synchronized consumer deployment. It rejects existing LocalEmbed/demo/comparison
schemas.

```sh
TEST_DATABASE_URL='<empty disposable pinned ParadeDB URL>' \
  deno task demo:compare /tmp/hybrid-storage.json
```

`DEMO_COMPARISON_ROWS` defaults to 512 (8..10000). This script uses deterministic dense 3D vectors
from a fixed seed, verifies identical exact candidates/results, rebuilds both BM25 indexes over the
complete corpus, performs five warmups and 30 paired samples with alternating layout order, and
saves EXPLAIN (ANALYZE, BUFFERS) plans. Timings include snapshot transactions, candidate reads,
fingerprint validation and RRF; they exclude HTTP API/provider inference. It removes its created
test schemas after the run. All write/migration probes are rolled back.

The committed [raw report](evaluation/hybrid-storage.json) records PostgreSQL 18.3, pg_search
0.22.6, pgvector 0.8.1 and Deno 2.9.7 on the pinned ParadeDB image. On this small synthetic local
run:

| Layout               |     p50 |     p95 |
| -------------------- | ------: | ------: |
| Separate destination | 4.72 ms | 5.52 ms |
| Same-table snapshot  | 4.60 ms | 6.20 ms |

Results/candidates matched exactly. Small latency differences with this workload do not justify a
storage change or predict performance for 768-dimensional real embeddings. Initial measurements were
confounded by different BM25 build histories; both indexes were rebuilt before the committed
measurement. ANN plans are diagnostic and separate from these exact timings: sequence scans were
disabled only to inspect index eligibility, not as recommended production tuning. On this fixture
the same-table plan used HNSW; the separate plan used a joined/indexed path instead.

Three single structural contention probes distinguish storage from the actual worker protocol:

- Updating only the separate destination did not block a source update.
- Updating the destination while holding the worker's source SHARE row lock did block it.
- Updating a vector on the same source row also blocked the source update.

These probes demonstrate lock conflicts; their observation times are not loaded latency estimates.
Separating storage does not remove the worker's short source lock used for correctness.

A comparison-only trigger ignored vector-only updates (zero invalidations) and noticed a content
update (one). An unconditional capture trigger can recapture every worker vector write and create an
endless work loop; direct self-writing triggers can recurse. A same-table implementation must
explicitly exclude generation columns, preserve failed work and coordinate concurrent writes.

The rolled-back DDL probe created an empty 4D replacement destination/index in 1.28 ms without an
exclusive source-table lock. Altering the copied source vector column to 4D, discarding its
synthetic vectors and rebuilding dependent indexes, took 11.66 ms and held ACCESS EXCLUSIVE on the
source. This compares DDL-only operations of different scope; it excludes backfill, inference and
activation. A real model/dimension migration needs new embeddings in either layout. Current managed
activation still has the maintenance lock described in #6; reducing it is #23, and warm rollback is
#24.

Separate storage lets runtime workers retain SELECT-only consumer-source privileges plus managed
writes/fixed locking helpers. Same-table storage needs narrowly granted UPDATE on generation columns
and consumer-owned table/index migrations. Table-level UPDATE is unnecessarily broad. Model changes
with the same dimensions still invalidate generation fingerprints; dimension changes can require
source rewrites/index rebuilds. Rollback, retention and business-write availability need explicit
coordination in either layout.

The dataset, vector dimension, cache state, lack of concurrent query load and simulated inference
limit this result. Formal semantic-quality, high-dimensional scale and production workload
measurement remain #10. ADR-0007 remains unchanged.

## Verification and sources

Run `deno task check`, `deno task test`, and `TEST_DATABASE_URL=... deno task test:integration`.
Five integration scenarios cover real BM25/pgvector with HTTP API responses, tenant/draft filtering,
freshness after task cleanup, bad vectors, activation retries, retained snapshots, exact layout
parity and a restricted reader. The pure RRF test covers ties beyond the exact integer range.

Primary references:
[ParadeDB hybrid-search example](https://www.paradedb.com/blog/hybrid-search-in-postgresql-the-missing-manual),
[ParadeDB index reference](https://www.paradedb.com/docs/reference/indexing/create-index),
[pgvector filtering/iterative scans](https://github.com/pgvector/pgvector#filtering).
