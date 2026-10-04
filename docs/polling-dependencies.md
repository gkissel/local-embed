# Polling and many-to-one content dependencies

Issue #5 adds a poller and explicit relations to the existing persistent queue. Administrative
migration creates the required objects; runtime startup executes no DDL. New entities may select
`trigger` or `polling`. Existing entity updates use [staging and activation](resilience.md).

## Reference configuration

See [the validated polling example](../contracts/examples/localembed.polling.example.json). It
associates `public.products.category_id` with `public.categories.id` and renders `{{category.name}}`
alongside `{{title}}`. The target must have a non-null, unique scalar key of the declared type; the
source column must have the same PostgreSQL type. A real foreign-key constraint is optional. A null
or missing related row renders its declared fields as empty strings. Only direct many-to-one
dependencies (`relation: "one"`) are supported, with at most 16 dependencies. Nested dependencies,
collections and self-relations are rejected. Relations and fields are explicit; no arbitrary
consumer SQL is accepted.

For the example, create source tables with administrative credentials:

```sql
CREATE TABLE public.categories (id bigint PRIMARY KEY, name text);
CREATE TABLE public.products (
  id bigint PRIMARY KEY,
  title text,
  category_id bigint REFERENCES public.categories(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX products_polling_order ON public.products (updated_at, id);
CREATE INDEX products_category_reference ON public.products (category_id);
```

The consumer must update `updated_at` when changing a product; a column default only handles
insertion. Indexes on consumer-owned tables are recommendations, not implicitly created by
LocalEmbed. Polling requires non-null `timestamptz` and a unique source ID.

```sh
# Administrative DATABASE_URL and provider credentials:
deno task localembed migrate contracts/examples/localembed.polling.example.json
deno task localembed backfill
# Separate terminals, with the respective runtime credentials:
deno task poller
deno task worker
```

On an existing installation, stop old workers, run `deno task localembed prepare-worker` with
administrative credentials, grant runtime permissions and restart. Existing trigger entities keep
their detection mode. This migration does not convert existing entities to polling or apply changed
configurations.

## Detection and durable progress

Every poller tick processes at most one incremental batch and one reconciliation batch per polling
entity. It locks that entity's persisted state until enqueue and cursor updates commit together.
Multiple pollers serialize on the same entity; different entities have independent state. Polling
and workers run independently and communicate through the queue.

The incremental cursor contains the timestamp and typed source identifier. IDs break ties;
timestamps are passed as PostgreSQL text before conversion back to `timestamptz`, preserving
microseconds instead of converting the cursor through JavaScript Date. Each incremental window has a
fixed database-clock upper bound. The next window overlaps by `source.detection.overlap_seconds`
(default 60); an unchanged fingerprint creates no task.

A timestamp alone does not express commit order. PostgreSQL READ COMMITTED sees records committed
before each statement begins, so a transaction can become visible after the poller has passed its
timestamp. A bounded overlap accelerates recovery but cannot cover arbitrarily late commits. Full
reconciliation is therefore required. See the primary
[PostgreSQL isolation documentation](https://www.postgresql.org/docs/18/transaction-iso.html).

Reconciliation scans source IDs in typed keyset batches, compares rendered-content fingerprints, and
enqueues missing or outdated embeddings. It then scans destination orphans and enqueues deletion
tasks. Each phase captures an upper identifier boundary; newly arriving higher identifiers do not
continually extend that phase. Its cursor and phase survive restart. After completion it schedules
the next cycle using `operations.reconciliation.interval_seconds` (default 3600). A late commit or
new ID behind the scan cursor is checked on a subsequent cycle. Dependency-only changes are also
detected by these source sweeps even when the root's timestamp did not change.

Pending or processing tasks already have recoverable work and are not repeatedly enqueued by
polling. Workers read current content and recheck it before committing, so changes during successful
inference cause stale results to be discarded and retried. Failed tasks retain their diagnostics and
require explicit [administrative reprocessing](resilience.md). Polling does not turn failed tasks
into pending tasks automatically. It synchronizes surviving current state; it cannot reconstruct
every intermediate value or rows inserted and deleted between observations.

Physical deletion is eventually detected by the orphan phase. The worker rereads the source before
deletion, so a reinserted identifier is processed rather than blindly removed. Convergence requires
the poller and workers to keep progressing and failure handling to be resolved. Reconciliation
interval, total sweep duration and queue backlog all contribute to delay; the configured interval is
not a hard maximum synchronization latency.

## Trigger dependencies and final writes

Trigger mode captures changes to declared root fields, source identifiers and relation columns. On
dependency inserts, deletes, key changes or declared-field updates, a trigger locates affected roots
and enqueues their identifiers in stable order. Unrelated and unchanged parent updates produce no
task. Task changes commit or roll back with the source transaction; no inference runs inside it.
Dependency fan-out may be expensive when one parent has many roots.

The worker final transaction locks the root and existing dependency rows before locking its task and
checking content, generation and lease ownership. Dependency locks follow a stable ordering by table
and identifier. Fixed SECURITY DEFINER helpers with a `pg_catalog` search path provide locking reads
without granting UPDATE on source or dependency tables; PUBLIC execution is revoked. These locks can
briefly contend with consumer writes. PostgreSQL
[documents row-lock behavior](https://www.postgresql.org/docs/18/explicit-locking.html). Normal
consumer transactions can still create deadlocks through their own lock ordering; transient failures
follow the [bounded retry policy](resilience.md).

## Runtime permissions and settings

The poller role requires schema USAGE, SELECT on configurations, roots, dependencies and
destinations, SELECT/INSERT/UPDATE on `localembed.polling_state` and `localembed.tasks`, USAGE on
`localembed.tasks_id_seq`, and EXECUTE on `localembed.enqueue_task(bigint, text,
text, text)` and
`localembed.revision_eligible(bigint, text)`. It needs no source UPDATE or locking-helper execution
privileges.

The worker retains its existing task/destination privileges and SELECT on dependency tables and
revision metadata, plus EXECUTE on `localembed.revision_eligible(bigint, text)`. Grant locking
helpers only to its trusted role. For this example:

```sql
GRANT EXECUTE ON FUNCTION localembed.lock_source_product(text),
  localembed.lock_dep_product_0(text) TO localembed_worker;
```

Dependency helper suffixes correspond to the dependency's zero-based position in the applied array.
Source writers in trigger mode need the existing queue privileges. Dependency writers also need
SELECT on root tables to locate affected identifiers. Do not grant these trigger queue privileges to
consumer writers for a polling-only setup.

| Setting                                      | Default | Meaning                                             |
| -------------------------------------------- | ------- | --------------------------------------------------- |
| `LOCAL_EMBED_POLL_INTERVAL_MS`               | 1000    | Delay between complete poller ticks                 |
| `LOCAL_EMBED_POLL_BATCH_SIZE`                | 100     | Maximum returned records per batch, from 1 to 10000 |
| `source.detection.overlap_seconds`           | 60      | Revisited incremental window duration               |
| `operations.reconciliation.interval_seconds` | 3600    | Delay after a completed reconciliation cycle        |

Batching bounds the number of records processed in a transaction, not total query I/O; missing
indexes and orphan scans can still be expensive. Full sweeps read roots, dependencies and stored
fingerprints even when no inference is needed. This is the completeness cost of polling without
transactional capture. No throughput, WAL or latency improvement is claimed.

Inspect progress without source content:

```sql
SELECT configuration_id, entity, cursor_time, cursor_id, window_end,
       phase, sweep_cursor, sweep_upper, delete_cursor, delete_upper, next_reconcile
FROM localembed.polling_state;
```

## Verification

Seven tests in `tests/polling_integration_test.ts` cover relation validation, atomic provisioning,
equal timestamps with microsecond precision, numeric key ordering, restart, unchanged inputs, late
commits, IDs behind the cursor, dependency-only changes, orphan cleanup, trigger fan-out and
rollback, changes during inference, deletion/reinsertion, concurrent pollers and restricted runtime
roles. Run against a disposable database:

```sh
TEST_DATABASE_URL=postgres://postgres:password@localhost/test \
  deno test --allow-read --allow-env --allow-net tests/polling_integration_test.ts
```

The tests create and delete `localembed`, `public.products`, `public.categories` and temporary
roles. Inference is simulated for deterministic concurrency; this verifies synchronization behavior,
not model quality or production performance.
