# Immutable revisions, bounded retries and administrative recovery

Issue #6 adds explicit revision activation, durable retry timing and reprocessing. Normal worker,
API and poller startup performs no DDL.

## Upgrade an existing installation

Stop old workers, pollers and API processes. With the administrative DATABASE_URL, run:

```sh
deno task localembed prepare-worker
```

The migration preserves task state and legacy failure diagnostics, normalizes legacy JSONB
configuration encoding, creates retry/revision metadata, and imports each entity's latest legacy
declaration as active. Repeating preparation preserves active reservations and the original capture
namespace. After granting the new runtime permissions, restart all processes with this version. Do
not run old binaries during this migration: they lack revision fencing and the new retry/activation
semantics.

All runtime roles need only their existing source/destination permissions plus the following:

- Workers: SELECT on `localembed.entity_revisions` and EXECUTE on
  `localembed.revision_eligible(bigint, text)`.
- Pollers: EXECUTE on the same eligibility function. SELECT on revision metadata is useful for
  inspection but is not required for their eligibility call.
- API: SELECT on both `localembed.configurations` and `localembed.entity_revisions`.
- Trigger source/dependency writers: EXECUTE on the eligibility function, in addition to their
  existing queue/sequence/enqueue privileges. No UPDATE on revision metadata is needed.

```sql
GRANT SELECT ON localembed.entity_revisions TO localembed_worker, localembed_api;
GRANT EXECUTE ON FUNCTION localembed.revision_eligible(bigint, text)
  TO localembed_worker, localembed_poller, consumer_writer;
```

The eligibility function is a fixed SECURITY DEFINER locking read with a `pg_catalog` search path;
PUBLIC execution is revoked. It keeps the revision row locked through the transaction, allowing
runtime roles to coordinate activation without UPDATE privileges on administrative state. Grant it
only to trusted runtime roles. The pre-existing source and dependency locking helpers retain their
permissions when replaced.

## Failure policy

The worker and query API share classification. Retryable HTTP responses are 408, 425, 429, 500, 502,
503 and 504. SDK transport failures, timeouts and recoverable PostgreSQL lock or serialization
errors are also classified as transient. Authentication/configuration errors, other HTTP statuses,
invalid vectors/dimensions and unknown ordinary errors are terminal. Provider messages, URLs,
query/source contents and response bodies are not stored or logged; only a known error category and
optional numeric HTTP status are retained.

The classifier uses the installed AI SDK's `statusCode`, `responseHeaders` and `isRetryable` error
properties. See the
[primary SDK error reference](https://ai-sdk.dev/docs/reference/ai-sdk-errors/ai-api-call-error).

Configure the applied retry policy:

```json
{
  "operations": {
    "retries": {
      "max_attempts": 5,
      "base_delay_ms": 1000,
      "max_delay_ms": 60000
    }
  }
}
```

`max_attempts` includes the initial execution; 0 and 1 both disable automatic retries. Backoff grows
exponentially and is capped by `max_delay_ms`, with jitter between 50% and 100% of that backoff.
Valid Retry-After seconds or HTTP dates are a lower bound on the delay, including when longer than
the local backoff cap. Retry-After exceeding seven days becomes `retry_after_exceeds_limit` and
requires administrative handling instead of retrying early or storing an impractical schedule.
Malformed/past values fall back to normal backoff.

Workers persist `next_attempt_at`; other identifiers can run while a task waits. Restarting a worker
does not reset that delay or attempt count. New changes reset a pending generation's budget; changes
during processing survive through the existing generation check. A task already failed remains
failed, with its diagnostics preserved even if newer content arrives, until explicit reprocessing.
Repeated interrupted/recovered claims also consume the budget; a claim beyond the configured limit
fails before another inference. SDK-internal retries remain disabled, so retries do not multiply
across layers.

The query API performs bounded retries synchronously, outside the task queue, under a single
30-second request deadline. Cancellation stops retry waits. If Retry-After or backoff cannot fit
within the remaining deadline, the API returns sanitized 503 without retrying earlier than
requested. Query text and retry state are not persisted. Inference may still be repeated after
transport errors or crashes; the guarantee is not exactly-once provider computation.

Worker lifecycle events include error category/status, configuration ID and attempted generation.
The pending/failed queue and `next_attempt_at` are inspectable; Grafana dashboards and cumulative
metrics remain #7.

## Explicit reprocessing

After correcting credentials, provider behavior, privileges or configuration, run with
administrative credentials:

```sh
# Revision and entity, optionally a source identifier:
deno task localembed reprocess 1 article
deno task localembed reprocess 1 article 123
```

Only failed tasks in an active or staged entity revision are eligible. The command processes up to
100 rows per transaction, skips rows locked by another administrator, resets the attempt budget and
schedules the latest requested generation immediately. It leaves pending, processing and completed
work untouched. Repeating the command is safe; retired revisions cannot be revived. A skipped locked
failure can be picked up by a subsequent command.

Each reprocessed task creates an `admin_actions` record with database principal, task/generation,
prior attempts and sanitized diagnostics before reset. Activation/cancellation also create audit
records. Audit/destination retention is separate work in #12.

## Prepare and activate a replacement

`migrate` provisions new entities as active. Existing entity updates use `stage` with a new managed
destination. This applies even when only template or retry parameters change, keeping the previous
destination available until the replacement is ready.

```sh
# Edit the configuration to use a fresh destination, e.g. localembed.article_embeddings_v2:
deno task localembed stage replacement.json
# The command prints its numeric revision ID, for example 2.
# Grant the worker access to the new destination before processing:
```

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON localembed.article_embeddings_v2 TO localembed_worker;
GRANT SELECT ON localembed.article_embeddings_v2 TO localembed_poller;
```

```sh
deno task localembed backfill
# Workers and pollers continue running with their runtime credentials.
# With administrative credentials, after candidate tasks finish:
deno task localembed build-indexes
deno task localembed activate 2
```

Applied configuration JSON is immutable: UPDATE changing it is rejected. At most one active and one
staged revision exist per entity. During preparation, both revisions can capture/process changes
into independent destinations. The API selects only the active revision; its generation
`config_version` identifies both contract and revision, e.g. `localembed/v1@2`. Consumers should
resolve their search destination from active revision metadata rather than assume its old name. An
API request uses the configuration snapshot it loaded; activation during inference may yield an
old-revision response, identifiable through this metadata.

Existing entities retain source table/key and dependency identities/order. Models, dimensions,
templates, declared fields, retry settings and detection settings can change. Source/relation
identity changes must use a new entity; they are rejected rather than silently replacing locking
helpers used by in-flight work. A fresh destination avoids in-place dimension changes and implicit
destructive DDL. Additional source-writer privileges may be necessary if trigger detection is added.

Activation is an administrative maintenance operation. It blocks writes to the configured source and
dependency tables, requires completed backfill and staged tasks, checks a valid HNSW matching the
configured metric, and verifies every current source fingerprint plus absence of orphans.
Verification uses batches but holds the administrative transaction/locks for the whole operation;
large datasets can therefore pause writes for a significant time. Continuous incoming traffic may
require a maintenance window to drain and validate the candidate. The current index build is still
regular/transacted; online HNSW remains #13. No online, zero-downtime activation is promised.

Revision locking protects worker final writes and poller/enqueue transactions. Activation retires
the previous entity revision, removes its capture triggers, marks unfinished old tasks superseded,
and invalidates their execution tokens in the same transaction. Old responses cannot update a
destination after activation commits. Existing old destinations and completed task history remain.
Underlying provider computation may continue until cancellation or its own timeout.

PostgreSQL's lock compatibility underlies this coordination; see the
[primary locking documentation](https://www.postgresql.org/docs/18/explicit-locking.html).

To abandon a candidate before activation:

```sh
deno task localembed cancel 2
```

Cancellation preserves the active revision and destinations, removes candidate capture, invalidates
its active task tokens and freezes its polling progress. An interrupted stage/build/activation can
be retried; failed activation rolls back atomically and leaves the candidate available for repair.
Activation of an already fully active revision is a no-op. Rollback after activation requires
staging the previous generation parameters into another fresh destination, backfilling and
activating it; old snapshots are retained but cannot safely be reactivated without catch-up.

Inspect state using administrative or explicitly granted read credentials:

```sql
SELECT configuration_id, entity, state FROM localembed.entity_revisions;
SELECT entity, source_id, status, attempts, generation, retry_generation,
       next_attempt_at, error_code, provider_status FROM localembed.tasks;
SELECT action, actor, details, created_at FROM localembed.admin_actions ORDER BY id;
```

## Verification and limits

The integration scenarios exercise durable retries/restart, attempt exhaustion, terminal errors,
invalid dimensions, generation budget reset, audited reprocessing, immutability,
dimension-replacement backfill/index/activation, stale old-worker results, active query
configuration, staged polling cancellation and rejection of outdated candidates. A real SDK HTTP
scenario returns 429, then 503, then a vector and verifies exactly three HTTP calls with no nested
retries. Unit tests cover error classification, Retry-After forms, jitter/cap, cancellation and the
query deadline.

Tests use the pinned ParadeDB reference database and simulated inference/HTTP providers. Real-model
API verification remains #17. These checks demonstrate functional safety and recovery, not
production latency, throughput, retrieval quality or the cost of maintenance locks.

## Telemetry migration follow-up (#7)

`prepare-worker` also adds execution start timestamps, sharded enqueue counters and the
five-argument enqueue function with explicit origin. Stop older runtimes before preparing and grant
SELECT/INSERT/UPDATE on `localembed.enqueue_metrics` and EXECUTE on
`localembed.enqueue_task(bigint, text, text, text, text)` to source/dependency writers and pollers
before restart. The four-argument compatibility function remains available for manual enqueue.
Workers and API roles need no counter writes. See [telemetry.md](telemetry.md).
