# Resumable administrative HNSW construction (#13)

For a live destination, use the explicit administrator command:

```sh
deno task localembed build-indexes --concurrently
# Compose equivalent, using the administrative credential:
docker compose -f deployments/compose.yaml run --rm admin build-indexes --concurrently
```

For initial offline loading, `build-indexes` retains ordinary construction. It checks that queued
work is done before constructing a missing/invalid index and blocks destination writes during the
build. Pause writers for this workflow; the queue check is a precondition, not a continuous writer
barrier. Normal workers never create indexes.

Concurrent construction requires completed backfill enqueue, but permits pending/processing/failed
incremental tasks. Completing backfill establishes the initial enqueue boundary; it does not mean
that every initial embedding already exists. PostgreSQL/pgvector allow indexing while workers
populate/update the destination. This command does not require a perpetually empty live queue.
Candidate activation still independently requires synchronized data and its maintenance window.

## Ownership, verification and recovery

The command reserves one physical database session and takes nonblocking **session** advisory lock
78129412. The same key serializes migrations, activation, cancellation and retention. Every index
statement runs in autocommit, outside explicit transactions, including `CREATE INDEX CONCURRENTLY`
and invalid-index `DROP INDEX CONCURRENTLY`. Ownership lasts across the separate PostgreSQL phases;
a competing index command or cleanup rejects its attempt. Other administrators that use blocking
locks wait. Session closure releases ownership, including after a fatal disconnect; the command
never deliberately resumes DDL on a new session after losing the lock.

The named relation is inspected in PostgreSQL catalogs. A matching index must target the exact
managed destination and `embedding` column, use HNSW and the provider's operator class, have the
configured `m`/`ef_construction` values and exactly one key without expression, predicate, uniqueness
or included columns. Readiness also requires `indisvalid`, `indisready` and `indislive`. Activation
uses the same validator. PostgreSQL identifier truncation is applied consistently before lookup/DDL;
a name collision with another object/definition fails for manual investigation.

- A valid matching index is reused, repairing `backfills.indexed` after a crash between committed
  DDL and the metadata update.
- A matching invalid/incomplete index is dropped in the selected build mode, then recreated and
  verified. Restart by running the same command; `IF NOT EXISTS` is not used as a validity check.
- A conflicting definition is never automatically dropped. Inspect it, back up the relevant
  configuration, and resolve the conflict administratively before retrying.

`admin_actions` records `index_build_started` and `index_build_finished`, including revision, mode
and build duration on completion. An unfinished start is diagnostic evidence, not proof that DDL
is still running. Catalog state and `pg_stat_progress_create_index` establish actual progress.
Each entity completes independently; an error later in a multi-entity run does not roll back earlier
successful indexes or audit entries. Re-execution verifies and resumes them.

## Operation and costs

Monitor `pg_stat_progress_create_index`, `pg_stat_activity` and `pg_locks` for long transactions and
phase waits. Cancel the specific administrative backend if needed; cancellation may leave an invalid
index, so rerun the managed command. Configure a suitable statement/lock timeout on the administrative
role or database if your maintenance policy requires a deadline. This command has no fixed build
execution deadline: large indexes and old snapshots can take substantially longer than small fixtures.
Do not terminate unrelated database sessions automatically.

Concurrent mode avoids the ordinary index build's relation lock that excludes INSERT/UPDATE/DELETE;
it does not remove row-lock contention, resource competition, or every wait. PostgreSQL does more
work and can wait for transactions/snapshots between phases. HNSW graph construction consumes CPU
and memory, can spill when `maintenance_work_mem` is insufficient, and adds index/WAL/storage work.
Size `maintenance_work_mem` and parallel maintenance workers against real available capacity; reserve
headroom for inference, workers and ordinary queries. Measure peak memory, CPU, I/O, WAL, lag and
query/write latency in #10 rather than extrapolating from this fixture. Reference documentation:
[PostgreSQL concurrent index construction](https://www.postgresql.org/docs/18/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY)
and [pgvector HNSW construction](https://github.com/pgvector/pgvector#hnsw).

The global administrative lock is intentionally conservative: a long build delays configuration
activation and causes retention to skip an overlapping pass. Schedule these operations together and
monitor overdue cleanup. Direct external DDL is outside this advisory protocol. Production timeout,
capacity and alert validation belongs to #27. This feature changes index construction; source write
blocking during activation remains tracked in #23.

## Evidence and reproducibility

Three integration scenarios on pinned ParadeDB cover initial-backfill/pending-work behavior,
metadata repair, conflicting operator class/parameters/predicate/object names, writes during
concurrent DDL, competing administrators/cleanup, cancellation with invalid-index recovery and
fatal session loss with fresh-command recovery. The full suite has 41 integration tests; inference
is simulated for this administrative feature. No new real TEI validation is claimed.

[The recorded probe](evaluation/indexes.json) uses 10000 synthetic 64-dimensional vectors, m=16,
ef_construction=64, PostgreSQL 18.3, pg_search 0.22.6 and vector 0.8.1. In one sequential sample per
mode, ordinary construction took about 1039 ms and its write probe timed out at 1000 ms. Concurrent
construction took about 1021 ms; the write committed in about 2.4 ms while CREATE INDEX was still
reported in progress. These timings demonstrate relation-lock behavior for this fixture, not that
concurrent construction is faster. CPU, peak memory and I/O were not measured in this probe.

Use an empty isolated database:

```sh
TEST_DATABASE_URL=postgres://... deno task measure:indexes docs/evaluation/indexes.json
```

The script refuses an existing installation/source fixture and leaves the isolated database for
inspection. It observes CREATE INDEX through PostgreSQL progress views and compares a bounded write
probe; timings depend on host/cache/data and the probe may finish after a fast build. It performs one
sample per mode without TEI or production throughput/recall assertions.
