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

The administrative command supports new entities using trigger or polling detection, including
explicit many-to-one content dependencies. It rejects existing destinations and unsupported
configurations with validation errors; existing entity updates use explicit staging and activation
with a fresh destination (see below). HNSW creation is deferred until initial backfill, as specified
by the managed-storage ADR. Backfill and index creation are separate administrative commands. The
trigger executes with the source writer's privileges; source writer roles need schema `USAGE`,
`SELECT, INSERT, UPDATE` on `localembed.tasks` and `localembed.enqueue_metrics`, `USAGE` on its
identity sequence, and `EXECUTE` on `localembed.enqueue_task(bigint, text, text, text, text)` and
`localembed.revision_eligible(bigint, text)`.

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

For an existing database, stop old workers and run `deno task localembed prepare-worker` to upgrade
the queue, fold duplicate tasks and replace capture functions transactionally. Restart with the
upgraded worker after granting its locking-read function permissions. New migrations include this
structure atomically. Backfill resumes from committed keyset batches after interruption and repeated
execution does not enqueue the same initial batch.

Workers claim tasks with `FOR UPDATE SKIP LOCKED`, use renewable leases, read the latest source
content, and update one destination row per source identifier. A SHA-256 fingerprint includes
rendered content and generation parameters. Unchanged fingerprints skip inference. Before writing,
the worker checks its lease ownership and verifies the source content again; a change during
inference requeues the task. Expired leases can be acquired by another replica. Processing failures
schedule transient retries persistently; terminal or exhausted failures require explicit
administrative reprocessing. See [retry and revision operations](docs/resilience.md). Workers log
task identifiers and lifecycle outcomes without content or vectors.

The worker role needs `SELECT` on source tables, configurations and `localembed.entity_revisions`,
`SELECT, UPDATE` on tasks, and `SELECT, INSERT, UPDATE, DELETE` on entity destinations, schema
`USAGE`, and `EXECUTE` on the entity-specific `localembed.lock_source_<entity>(text)` function and
`localembed.revision_eligible(bigint, text)`. This fixed locking-read function uses the
administrative owner with a fixed search path; PUBLIC execution is revoked. Grant it only to the
trusted worker role so it can lock source rows without UPDATE permission on source tables. For the
reference article entity:
`GRANT EXECUTE ON FUNCTION localembed.lock_source_article(text)
TO localembed_worker`. Backfill,
worker preparation, and index creation use the administrative role. Normal worker startup executes
no DDL. The initial HNSW build uses a regular transactional index build; schedule it before
production query load because it blocks destination writes while building.

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

## Queue coordination

Each applied configuration, entity and source identifier owns one reusable task row. UPDATE triggers
compare only the declared fields and identifier; unrelated fields and unchanged values create no
task. Relevant changes increment a durable generation counter instead of appending another task. A
change during inference preserves the active reservation and advances the requested generation; the
worker discards the old result and leaves the latest generation pending. Completed task rows are
reused on subsequent changes. Failed tasks remain failed, with their error context preserved even if
newer source changes arrive, until explicit administrative reprocessing. The queue represents
synchronization state rather than a history of every source update.

Workers reserve different identifiers independently. Each execution has a UUID token, an expiring
lease and an absolute deadline. Periodic renewal requires the same token and an unexpired lease; an
expired reservation cannot be resurrected. Cancellation propagates to the provider, and final writes
verify token, deadline, content and generation. Interrupted work becomes recoverable; a late
provider response cannot overwrite a replacement worker's result. Reservations are ordered by
request time so repeatedly changing older records do not always jump ahead of other work.

Configure timing through worker environment variables:

| Variable                       | Default                | Meaning                                               |
| ------------------------------ | ---------------------- | ----------------------------------------------------- |
| `LOCAL_EMBED_LEASE_SECONDS`    | `60`                   | Reservation duration                                  |
| `LOCAL_EMBED_RENEW_EVERY_MS`   | One third of the lease | Renewal interval, shorter than the lease              |
| `LOCAL_EMBED_MAX_EXECUTION_MS` | `300000`               | Maximum duration of one execution, including renewals |

The provider request also has a 30-second timeout. A server already computing a cancelled request
may continue its work, and a crash after receiving a vector but before committing can still cause
repeat inference. Source updates and final writes briefly contend on the source row; final writes
lock the source before the task to follow the trigger's lock order. Relevant changes still write
queue state, and renewals add a write each interval. Queue retention and concurrent HNSW
construction remain issues #12 and #13. Revision activation and retry operations are described
below.

See [the reproducible queue workload comparison](docs/queue-coordination.md).

## Query embedding API

Run the API with a separate, randomly generated service key. The API database role needs only
`USAGE` on schema `localembed` and `SELECT` on `localembed.configurations` and
`localembed.entity_revisions`:

```sh
export DATABASE_URL=postgres://localembed_api:password@localhost/localembed
export LOCAL_EMBED_SERVICE_KEY=$(openssl rand -hex 32)
export LOCAL_EMBED_TEI_API_KEY=your-provider-key
deno task api
```

The server binds to `127.0.0.1:8090` by default. Configure `LOCAL_EMBED_API_HOST` and
`LOCAL_EMBED_API_PORT` for your deployment; use a TLS reverse proxy when accessed remotely. The
service key is 32 random bytes encoded as 64 hexadecimal characters and is independent of the
provider key. Send it as a Bearer credential:

```sh
curl http://127.0.0.1:8090/v1/embeddings \
  -H "Authorization: Bearer $LOCAL_EMBED_SERVICE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"entity":"article","input":"query: Como funciona a sincronização incremental?"}'
```

Only applied entities are available. For an entity, the API reads the active applied revision for
that entity, uses its provider and model, and returns `embedding`, `dimensions`, `model`, `provider`
and generation metadata. It never searches, reads source rows, enqueues tasks or persists query
text. The input is sent verbatim: include the reference E5 `query:` prefix yourself; source content
uses the independent `passage:` entity template. The returned fingerprint combines query text and
the entity's generation parameters; it does not identify a source row.

Requests must have exactly `entity` and `input`, use JSON, contain 1–32768 Unicode characters of
input, and fit within 262144 body bytes, including streamed bodies. Authentication happens before
configuration access or inference. Invalid requests return 400, invalid credentials 401, unapplied
entities 404, and configuration/provider failures 503 with sanitized errors. Provider vectors must
have the configured dimension and finite numeric values. Inference has a 30-second timeout and
observes request cancellation. Transient retries share the request deadline. There is no query cache
or per-consumer quota in this version; deployments sharing a service key share access to all applied
entities.

`deno task test` checks validation, authentication, metadata, invalid provider output and timeout.
The API integration test runs with the other scenarios via `deno task test:integration`, exercising
PostgreSQL configuration lookup through a role with read-only permissions and a local
OpenAI-compatible provider. It uses a disposable database, recreates `localembed`, and creates and
drops the temporary `localembed_query_test` role. To additionally verify real inference, use:

```sh
TEST_DATABASE_URL=postgres://postgres:password@localhost/test \
TEST_TEI_ENDPOINT=http://localhost:8080 \
LOCAL_EMBED_TEI_API_KEY=your-provider-key \
deno test --allow-read --allow-env --allow-net tests/api_integration_test.ts
```

See [the implementation improvements and experimental limits](docs/melhorias.md) for article notes.

## Polling and content dependencies

Run `deno task poller` for entities with `source.detection.mode: "polling"`, a unique source ID and
a non-null `timestamptz` update column. The poller persists timestamp/identifier cursors and
reconciliation progress, enqueues only work needing synchronization, and installs no capture
triggers on consumer tables in this mode. Reconciliation handles late commits, physical deletes and
dependency changes that do not change the root timestamp.

Relations explicitly map a root column to a unique dependency key; templates can render fields such
as `{{category.name}}`. Trigger mode also captures changes to these dependencies and fans out work
to affected roots. Workers recheck root and dependency content before committing.

See [setup, correctness policy, permissions and tradeoffs](docs/polling-dependencies.md) and the
[validated configuration example](contracts/examples/localembed.polling.example.json). Polling
trades periodic database reads and eventual detection for operation without consumer capture
triggers. Existing entity changes use staged revisions; failed tasks can be reprocessed explicitly.

## Revisions and failure recovery

New entities use `migrate`; update an existing entity through `stage replacement.json`, a fresh
managed destination, backfill, worker processing, `build-indexes` and `activate <revision>`.
`cancel <revision>` abandons a staged candidate without changing the active revision. Configuration
JSON is immutable; the API selects the active revision and returns metadata such as
`localembed/v1@2`. Activation verifies the candidate and fences old workers and pollers atomically.
It is a maintenance operation that blocks source writes during verification.

Transient failures use persistent bounded retries with exponential backoff, jitter and Retry-After.
Terminal/exhausted failures remain inspectable until an administrator runs
`deno task localembed reprocess <revision> <entity> [source-id]`. Reprocessing is audited and uses
the latest requested generation. Query retries run synchronously under the request deadline.

See [migration, runtime grants, retry policy, staging and rollback](docs/resilience.md). Upgrading
existing installations requires stopping old runtimes, running `prepare-worker`, granting the new
revision permissions and restarting. Old destinations are preserved; their eventual cleanup remains
#12.

## Operational telemetry

The [telemetry setup](docs/telemetry.md) provisions Grafana, Prometheus, Loki and Tempo and
instruments the worker, query API and poller with OpenTelemetry. Queue snapshots use a separate
read-only database role; capture counters persist independently of reusable task rows.

Existing installations must stop old runtimes, run `prepare-worker`, grant enqueue metrics
permissions to source writers/pollers and restart with the new version. Telemetry export is opt-in
through `OTEL_DENO=true`; use a unique `service.instance.id` for each process.

## Consumer hybrid-search demonstration

The [hybrid-search guide](docs/hybrid-search.md) runs a separate consumer that obtains query vectors
from the API, combines ParadeDB BM25 and pgvector with weighted RRF, and checks applied generation
and source fingerprints. `demo:setup`, `demo:search` and `demo:compare` provide setup, query and
disposable storage-comparison tasks. The [recorded comparison](docs/evaluation/hybrid-storage.json)
uses equivalent synthetic data; it does not change managed storage or claim real-model quality.

## Reference deployment

Run `scripts/deployment/prepare.sh` and `docker compose -f deployments/compose.yaml up -d --build`
for the pinned ParadeDB, LocalEmbed roles, TEI and telemetry environment. The same role image runs
through [the Helm chart](deployments/helm/localembed). See
[deployment operation and verification](docs/deployment.md) for credentials, administration, custom
configuration, production boundaries and real-provider checks.
