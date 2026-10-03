# LocalEmbed

LocalEmbed keeps embeddings synchronized with PostgreSQL while leaving search and application
concerns with the consumer. The repository includes the versioned configuration and query contracts,
administrative provisioning, and a PostgreSQL-backed synchronization worker.

## Workspace

The project uses Deno workspaces and native tasks. Install [Deno 2](https://deno.com/) and run:

```sh
deno task validate:contracts
deno task check
deno task docs:build
```

The public configuration contract is at `contracts/schema/localembed.v1.schema.json`, with its
canonical example in `contracts/examples/`. The initial query API is described by
`contracts/openapi/localembed.v1.yaml`.

To preview the documentation locally, run `deno task docs:serve` and open the address printed by
Lume. `deno task docs:prepare` copies the public contracts into the Lume input so the generated site
serves the JSON Schema, canonical example, and OpenAPI document.

## Apply a trigger-backed configuration

Install pgvector in PostgreSQL 18 or later (`CREATE EXTENSION vector`) using the database
administrator role, then run:

```sh
export DATABASE_URL=postgres://admin:password@localhost/localembed
export LOCAL_EMBED_TEI_API_KEY=your-provider-key
deno task localembed migrate contracts/examples/localembed.v1.example.json
```

The command validates the public schema, provider references, template fields, source columns,
non-null unique identifiers, and provider output dimensions before committing any objects. It
persists the applied configuration, provisions a fixed-dimension destination, and installs triggers
that enqueue persistent `upsert` and `delete` tasks in the source transaction. No inference runs in
those triggers. Changes to source identifiers enqueue deletion of the old identifier as well.

This first administrative command supports new entities using trigger detection without content
dependencies. It rejects existing destinations and unsupported configurations with validation
errors; configuration updates, polling, and dependencies arrive in later issues. HNSW creation is
deferred until initial backfill, as specified by the managed-storage ADR. Backfill and index
creation are separate administrative commands. The trigger executes with the source writer's
privileges; runtime roles need `USAGE` on `localembed`, `INSERT` on `localembed.tasks`, and `USAGE`
on its identity sequence.

Run the database integration test against a disposable PostgreSQL 18 database with pgvector:

```sh
TEST_DATABASE_URL=postgres://postgres:password@localhost/test deno task test:integration
```

The integration test creates and removes `public.articles` and the `localembed` schema.

## Synchronization worker and reference inference

Start the CPU inference server with the reference model pinned to an immutable revision:

```sh
export LOCAL_EMBED_TEI_API_KEY=your-provider-key
docker compose -f deployments/tei.compose.yaml up -d
```

The host-side example is `deployments/localembed.reference.json`. Apply it with
`deno task localembed migrate deployments/localembed.reference.json` after creating
`public.articles` with the configured columns. For other configurations, set the TEI `endpoint` to
`http://localhost:8080`. The worker uses the OpenAI-compatible `/v1/embeddings` endpoint through the
Vercel AI SDK. The administrative TEI preflight uses `/embed`. Include the E5 `passage:` prefix in
the entity template for source content. The server pins `intfloat/multilingual-e5-base` to revision
`129286372ebbc09af0394786dd03e16427ade171`; its vectors have 768 dimensions.

After applying configuration, enqueue existing records, run workers, and build HNSW after initial
tasks finish:

```sh
deno task localembed backfill
deno task worker
# In another terminal, with administrative DATABASE_URL:
deno task localembed build-indexes
```

For a database provisioned by the first administrative implementation, first run
`deno task localembed prepare-worker` to add queue lease fields and durable backfill state. New
migrations include this structure atomically. Backfill resumes from committed keyset batches after
interruption and repeated execution does not enqueue the same initial batch.

Workers claim tasks with `FOR UPDATE SKIP LOCKED`, use expiring leases, read the latest source
content, and update one destination row per source identifier. A SHA-256 fingerprint includes
rendered content and generation parameters. Unchanged fingerprints skip inference. Before writing,
the worker checks its lease ownership and verifies the source content again; a change during
inference requeues the task. Expired leases can be acquired by another replica. Processing failures
retain a failed task; retry classification and administrative reprocessing belong to issue #6.
Workers log task identifiers and lifecycle outcomes without content or vectors.

The worker role needs `SELECT` on source tables and configurations, `SELECT, UPDATE` on tasks, and
`SELECT, INSERT, UPDATE, DELETE` on entity destinations, plus schema `USAGE`. Backfill, worker
preparation, and index creation use the administrative role. Normal worker startup executes no DDL.
The initial HNSW build uses a regular transactional index build; schedule it before production query
load because it blocks destination writes while building.

Inspect progress with:

```sql
SELECT entity, status, count(*) FROM localembed.tasks GROUP BY entity, status;
SELECT * FROM localembed.backfills;
SELECT source_id, fingerprint, vector_dims(embedding) FROM localembed.article_embeddings;
SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'localembed';
```

`deno task test:integration` verifies backfill, multiple workers, stale inference, fingerprint
skips, deletion, lease recovery, HNSW creation, and the OpenAI-compatible SDK request against a
local mock server. Use a disposable database as described above. The mock exercises the protocol
without downloading the real model.

To run the same database scenarios against the real TEI server, set its endpoint and the provider
key as well:

```sh
TEST_DATABASE_URL=postgres://postgres:password@localhost/test \
TEST_TEI_ENDPOINT=http://localhost:8080 \
LOCAL_EMBED_TEI_API_KEY=your-provider-key \
deno task test:integration
```

Reference sources: [AI SDK embedding interface](https://ai-sdk.dev/docs/ai-sdk-core/embeddings) and
[pinned E5 model revision](https://huggingface.co/intfloat/multilingual-e5-base/tree/129286372ebbc09af0394786dd03e16427ade171).

The local reference database is ParadeDB PostgreSQL 18 with pgvector and `pg_search` in one
database. Its image is pinned by digest in `deployments/database.compose.yaml`:

```sh
POSTGRES_PASSWORD=your-local-password docker compose -f deployments/database.compose.yaml up -d
```

The database and TEI files provide the infrastructure needed for host-side Deno development; full
service packaging remains issue #9. Enable the extensions explicitly in the target database and
record installed versions:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_search;
SHOW server_version;
SELECT extname, extversion FROM pg_extension WHERE extname IN ('vector', 'pg_search');
```
