# Operational telemetry (#7)

LocalEmbed exports OpenTelemetry metrics, sanitized lifecycle logs and traces from worker, query API
and poller. The reference Grafana dashboard is provisioned with Prometheus, Loki and Tempo in a
pinned `grafana/otel-lgtm` development image. This is a local reference stack; production backend
sizing, authentication, TLS, retention and Helm packaging belong to deployment work #9.

## Prepare and grant

Stop existing runtimes before running `deno task localembed prepare-worker`. New migrations include
the same telemetry objects. No runtime performs DDL at startup.

Source/dependency writers and pollers require their existing task/sequence/eligibility permissions
plus the following (substitute your role names):

```sql
GRANT SELECT, INSERT, UPDATE ON localembed.enqueue_metrics
  TO consumer_writer, localembed_poller;
GRANT EXECUTE ON FUNCTION localembed.enqueue_task(bigint, text, text, text, text)
  TO consumer_writer, localembed_poller;

CREATE ROLE localembed_telemetry LOGIN;
-- Set its password through your normal secret provisioning process.
GRANT USAGE ON SCHEMA localembed TO localembed_telemetry;
GRANT SELECT ON localembed.tasks, localembed.entity_revisions,
  localembed.enqueue_metrics, localembed.polling_state TO localembed_telemetry;
```

The snapshot service needs no access to source tables, embeddings, configuration secrets or
administrative writes. Worker/API roles need no counter writes. The four-argument enqueue function
remains a compatibility wrapper with `manual` origin; new captures/backfill/polling use the
five-argument function to distinguish origins. Counters start at migration, not deployment history.

## Start the reference dashboard

```sh
export GRAFANA_ADMIN_PASSWORD='<your-local-password>'
docker compose -f deployments/telemetry.compose.yaml up -d
```

Open `http://127.0.0.1:3000`, login as `admin` with that password and select **LocalEmbed
operations**. The Compose file publishes Grafana and OTLP/HTTP only on loopback. Ports can be
changed through `LOCAL_EMBED_GRAFANA_PORT` and `LOCAL_EMBED_OTLP_PORT`. A named volume preserves
backend data; ordinary `down` keeps it. `down -v` deliberately removes reference telemetry history.

Enable export separately for each process, with a distinct instance ID:

```sh
OTEL_DENO=true OTEL_SERVICE_NAME=localembed-worker \
  OTEL_RESOURCE_ATTRIBUTES=service.instance.id=worker-1 \
  OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
  OTEL_METRIC_EXPORT_INTERVAL=15000 deno task worker
```

Use service names `localembed-query-api`, `localembed-poller` and `localembed-telemetry` for their
respective tasks. Each worker/API/poller replica needs a unique `service.instance.id` to prevent
counter series from colliding. Deno's native exporter initializes before the script runs, so set
these variables before launching it. Optional trace sampling uses `OTEL_TRACES_SAMPLER=traceidratio`
and `OTEL_TRACES_SAMPLER_ARG=0.1`; metrics are not sampled with traces.

Launch exactly one database snapshot service per installation:

```sh
DATABASE_URL='<read-only telemetry database URL>' \
  OTEL_DENO=true OTEL_SERVICE_NAME=localembed-telemetry \
  OTEL_RESOURCE_ATTRIBUTES=service.instance.id=telemetry-1 \
  OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
  OTEL_METRIC_EXPORT_INTERVAL=15000 deno task telemetry
```

`LOCAL_EMBED_SNAPSHOT_INTERVAL_MS` defaults to 15000 and must be at least 1000. Each refresh uses a
read-only transaction with a five-second statement timeout. Failed refreshes retain the last
snapshot and emit `snapshot_failed`; rising `localembed_snapshot_age_seconds` indicates stale
values. No snapshot-age data also requires checking process/exporter health. Snapshot queue/lag ages
describe refresh time, not an authoritative clock while the database is unavailable.

## Signal semantics

| Signal                             | Meaning                                                                                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `localembed_queue_depth`           | Current task rows by entity/status; zero states are emitted after completion/removal. One row represents a source identifier in one revision, not each update.                                                           |
| `localembed_queue_age_seconds`     | Age of the oldest requested work in pending/processing state. Later changes/retries can reset requested time.                                                                                                            |
| `localembed_execution_age_seconds` | Age of the oldest currently processing execution, using its claim timestamp.                                                                                                                                             |
| `localembed_enqueued_total`        | Transactionally committed enqueue requests across trigger, polling, backfill and manual origins.                                                                                                                         |
| `localembed_captured_total`        | Trigger-origin affected-root requests, including dependency fan-out and simultaneous staged capture; not a count of distinct parent changes.                                                                             |
| `localembed_coalesced_total`       | Enqueue requests merged into already outstanding work. Reusing a fully completed task is not a coalesced request.                                                                                                        |
| `localembed_events_total`          | Process-local observed provider calls, task outcomes, retries, leases, interruptions, API responses and polling observations.                                                                                            |
| `localembed_duration_seconds`      | Histogram of tick/request/provider latency, with explicit second-scale buckets. Empty worker ticks are also included in tick latency.                                                                                    |
| `localembed_poll_*`                | Cursor/window lag, reconciliation overdue, source/delete phase and persisted-cursor progress. Infinite initial cursors are omitted from lag; these are not guaranteed synchronization latency or completion percentages. |
| `localembed_process_memory_bytes`  | RSS and used JavaScript heap by process.                                                                                                                                                                                 |
| `localembed_process_cpu_seconds`   | Accumulated user/system CPU time; rate estimates core consumption.                                                                                                                                                       |

The durable enqueue counters use 16 shards per entity/origin to spread updates and are independent
of task cleanup. They add one write per accepted enqueue and still introduce contention; no
throughput benefit has been measured. Retention of these aggregate counters must be separate from
task/revision cleanup (#12). Do not derive lifecycle history from reused task rows.

Process counters reset on restart; Prometheus preserves exported time series across task cleanup and
handles ordinary counter resets. Events occurring between exports may be lost on a crash or backend
outage. This is operational telemetry, not a durable audit log; explicit operator actions remain in
`admin_actions`. Polling scan/change/orphan/completion events describe observed batch attempts and
can include a subsequently rolled-back transaction. Committed enqueue counters are transactional.
Reconciliation progress is represented by phase, persisted-cursor flags and scan rates rather than a
percentage over changing tables.

The API labels authenticated calls as consumer `service-key`, since the current key is shared.
Unknown entities and unauthorized credentials are not accepted as arbitrary entity/consumer metric
labels. Quota/concurrency rejection events arrive with #15; cache hit/miss/coalescing/eviction
signals arrive with #16. They are not reported as implemented features or inferred from worker
outcomes.

## Privacy and traces

Application events have an explicit context allowlist: service, configured entity, configuration
revision, task/generation, consumer identity, sanitized error/status and bounded lifecycle fields.
Task IDs and revisions stay in logs/traces; they are not per-task metric labels. Source identifiers,
source/query content, fingerprints, vectors, raw exception objects, provider bodies, endpoints and
credentials are excluded. The service entry points log safe failure categories on runtime errors.

Deno also automatically emits HTTP spans with URLs and console logs. The provided Collector filters
out every non-`localembed` trace/metric instrumentation scope and logs without the application's
JSON event prefix **before** exporting to the backends. The smoke test injects private raw logs and
an unsafe span to verify rejection. Use these filters when exporting through your own collector;
pointing directly at another backend does not apply them. Runtime stdout may still contain native
Deno/third-party diagnostics, so treat it separately. Do not put secrets in OTEL resource
attributes. The receiver is for trusted local services, not arbitrary external OTLP clients.

Worker ticks and provider calls, API requests/provider calls, and polling ticks create spans.
Lifecycle logs include `trace_id`/`span_id` when tracing is enabled. Grafana Explore can query Tempo
by service or fetch a trace directly by its log ID; indexed search may lag ingestion. PostgreSQL
capture is transactional aggregate telemetry rather than a distributed trace of consumer writes.
Provider span context is process-local; this delivery does not require TEI to propagate trace IDs.

## Reproduce verification

Run ordinary tests and integration tests against a disposable pinned ParadeDB instance:

```sh
deno task check
deno task test
TEST_DATABASE_URL='<disposable database URL>' deno task test:integration
```

For a full export smoke test, start the dashboard above and use an **empty disposable** database:

```sh
OTEL_DENO=true OTEL_SERVICE_NAME=localembed-smoke \
  OTEL_RESOURCE_ATTRIBUTES=service.instance.id=smoke-1 \
  OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
  OTEL_METRIC_EXPORT_INTERVAL=1000 \
  TEST_DATABASE_URL='<empty disposable database URL>' deno task verify:telemetry
```

The script refuses an existing LocalEmbed installation/source fixture, creates temporary objects,
processes trigger/coalesced and polling work with simulated inference, calls the API, emits
snapshots and cleans its test objects. In Grafana, verify enqueue=2, captured=2, coalesced=1, queue
pending=0/done=1, finite process resource metrics, lifecycle logs and the worker trace identified in
its output. `PRIVATE_SMOKE_*` must be absent from Loki/Tempo/Prometheus despite the intentionally
injected unsafe log/span. This verifies telemetry plumbing and privacy filters, not real-model
quality (#17/#10).

Validated locally with Deno 2.9.7, pinned ParadeDB 0.22.6-pg18 and LGTM 0.35.0 (digest in Compose).
The provisioned 16 panels, metric queries, Loki events and direct Tempo trace retrieval were
checked.

References: [Deno OpenTelemetry](https://docs.deno.com/runtime/fundamentals/open_telemetry/),
[Grafana provisioning](https://grafana.com/docs/grafana/latest/administration/provisioning/),
[reference LGTM image](https://github.com/grafana/docker-otel-lgtm).
