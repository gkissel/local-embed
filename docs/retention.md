# Administrative retention (#12)

Retention is a separate persisted operational policy, not an embedding configuration revision.
New installations receive conservative defaults: completed tasks 7 days, batches of 100, retired
revisions 30 days and at least the newest two retired revisions per entity, reader grace 1 hour.
Destination deletion is disabled and audit history has no automatic expiry.

## Upgrade and run

Run with the administrator database credential, after backing up the installation:

```sh
deno task localembed prepare-worker
deno task localembed configure-retention deployments/retention.reference.json
deno task localembed cleanup                 # dry-run; does not delete
deno task localembed cleanup --apply         # one bounded transactional pass
```

`prepare-worker` installs the new metadata/indexes. Existing successful tasks and retired revisions
without timestamps start their retention clock at migration, rather than inventing an earlier age.
Refresh the snapshot role grant (`SELECT ON localembed.cleanup_totals`); the deployment bootstrap
includes it. Migration DDL can require locks: schedule the administrative upgrade accordingly.

For Compose, use `docker compose -f deployments/compose.yaml run --rm admin cleanup --apply`
after preparing/configuring the database. Schedule this command externally with the administrator
credential. For Helm, `--set retention.enabled=true` enables the hourly CronJob; configure the
persisted policy first. It forbids overlapping Jobs, mounts only the admin URL secret and performs
one pass. More frequent passes or larger batches increase throughput and database work. Failure or
skipped reservations can be retried on the next pass; monitor Job failures and remaining backlog.
The SQL statement timeout is 30 seconds and lock timeout is 1 second.

## Eligibility and concurrency

Completed task deletion requires `done`, matching requested/processed generations, an old
`completed_at` and no live reservation. `FOR UPDATE SKIP LOCKED` limits each batch and rechecks
eligibility while holding the row lock. Pending, processing and failed work is preserved. An enqueue
concurrent with deletion waits on the unique key and recreates pending synchronization state after
commit; UUID lease fencing still protects stale execution writes. The completion index adds write
and maintenance cost in exchange for efficient candidate selection.

A retired destination requires both age/grace expiry and the revision count window; captured
execution deadlines must also have expired. Active/staged source, dependency and destination tables
are protected. Shared retired destinations are conservatively retained. Dropping uses `RESTRICT`
and a nonblocking exclusive relation lock; dependent objects or readers cause a skip. Successful
retirement marks the revision cleaned and removes its polling/backfill state. Superseded tasks
formerly pending/processing, without diagnostics/reservations, are deleted in separate bounded
batches, including subsequent passes. Superseded failures remain, even without an error message.
Configurations, revision records and shared locking helpers are retained as forensic metadata.

### Reader protocol before enabling destination deletion

Every consumer must use a physical session and acquire `pg_advisory_lock_shared(78129413)` **before**
opening its repeatable-read transaction and resolving the active pointer. Hold it through ranking
and commit/rollback; release it in `finally`, then return the connection. The hybrid example implements
this protocol and retains three bounded revision/missing-table attempts. Inference happens before
acquiring the guard. Cleanup takes the matching exclusive transaction advisory lock without waiting.
This closes the pointer-resolution/table-access gap, including snapshots opened before activation.

Only after all consumers implement this protocol set `drop_retired_destinations: true` and
`readers_use_lock_protocol: true`. The latter is an operator acknowledgement, not automatic discovery
of external clients. Grace alone cannot protect an arbitrarily long snapshot. Legacy readers that
already hold a relation lock are protected by PostgreSQL, but an unregistered pre-access reader is
not. The global guard conservatively delays all retired drops while any cooperative reader runs.

The policy fields are in [retention.reference.json](../deployments/retention.reference.json).
`batch_size` is 1–10000; numeric durations are nonnegative seconds. `audit_seconds: null` preserves
history indefinitely; a numeric value explicitly opts into bounded audit pruning. Dry-run reports
per-pass candidates, destination sizes/actions and policy; eligible counts are not total backlog
counts. A transaction rollback also rolls back deletes, counters and audit changes.

## Durable history and monitoring

`enqueue_metrics` is cumulative capture history independent of task/configuration lifetime. There is
no automatic reset: any deliberate operator reset starts a new counter epoch and should be exported
and documented first. `cleanup_totals` persists per-kind deletion totals even after audit pruning;
snapshot exports `localembed_cleanup_deleted{kind=...}` with five bounded kinds. Enqueue aggregates,
current task state/diagnostics and transactional `admin_actions` cover synchronization recovery,
configuration activation and cleanup auditing. Operational logs/provider spans remain best effort;
SIGTERM/export deadlines help but forced kill and exhausted buffers can lose them. This feature does
not add a per-log outbox. A future requirement to durably audit every inference/consumer request needs
an explicit outbox, acknowledgement, idempotent replay and retention policy in that feature's scope.

Monitor remaining done backlog/oldest completion, failed/superseded diagnostics, cleanup totals,
`pg_stat_user_tables.n_dead_tup`, `last_autovacuum`, `pg_total_relation_size`, filesystem/PVC free
bytes, WAL and replication lag. Retaining actionable failures/forensic metadata means growth is not
universally bounded; alert and investigate it rather than silently discarding failures. Tune autovacuum
from measurements. Consider partitioning only when #10 demonstrates that this strategy is insufficient.

Deleted task rows create reusable space; they do not promise immediate OS disk recovery. Ordinary
VACUUM supports reuse; VACUUM FULL rewrites and requires an exclusive lock and spare space, so it
needs planned maintenance. Destination drops report object count/observed bytes separately from
actual volume savings. See [PostgreSQL routine vacuuming](https://www.postgresql.org/docs/18/routine-vacuuming.html)
and [VACUUM](https://www.postgresql.org/docs/18/sql-vacuum.html).

The pinned local LGTM reference now explicitly retains Prometheus for 7 days or 1 GB (whichever
expires first), Loki for 168 hours with its persistent compactor directory, and Tempo blocks for
168 hours through backend scheduler/worker flags. Backend deletion is asynchronous; WAL, indexes,
compaction scratch space and exporter queues still need headroom. These are reference defaults,
not production sizing. Monitor disk/PVC usage and export rejection; do not use `down -v` as routine
retention. Production backends, access controls and capacity validation remain #27. Tempo's flags
match the binary in LGTM 0.35.0; newer architecture uses backend scheduler/worker rather than a
`compactor` section ([Tempo compaction](https://grafana.com/docs/tempo/latest/operations/compaction/)).

## Evidence and limits

Four integration scenarios exercise cutoff/batches/migration, concurrent administrative ownership,
locked tasks, activation with long reader snapshots/execution deadlines, legacy relation locks,
preserved failures, resumable superseded deletion, concurrent enqueue and counters after audit
pruning. The full integration suite runs on real ParadeDB; inference is simulated for this SQL feature.
The restricted snapshot role and actual hybrid BM25/vector consumer are included in the suite.

[retention.json](evaluation/retention.json) records a single paired SQL plan probe: 10000 synthetic
task rows, 200 aged candidates, limit 100, PostgreSQL 18.3, pg_search 0.22.6, vector 0.8.1. The indexed
plan took 0.090 ms/104 shared buffer hits versus 1.043 ms/273 without the partial index in that run.
This is a warm-cache plan sample, not throughput, percentile, production or TEI evidence. Reproduce
with `TEST_DATABASE_URL` pointing at an empty isolated database and
`deno task measure:retention docs/evaluation/retention.json`. The script refuses an existing fixture;
it leaves its isolated database for inspection.
