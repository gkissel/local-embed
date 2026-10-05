# Reproducible artifact baseline (#10)

This baseline runs the current LocalEmbed implementation against **real pinned TEI** and ParadeDB,
using synthetic records and a committed public USGS earthquake catalog snapshot. It verifies
functional convergence and records small operational workloads. Extended comparative experiments
are tracked in #31; implementing a baseline does not implement the future mitigations it measures.

## Run

Requirements: Linux (or WSL2), Deno 2.9.7, Python 3, Bash, curl and Docker with sufficient capacity for the reference
CPU model. Ports 15432 and 18080 must be free. Run from the repository:

```sh
deno task evaluate                         # writes the committed baseline paths
# Keep a separate experiment instead of overwriting the reference:
deno task evaluate /tmp/localembed-report.json
# Scale synthetic input; public snapshot and four polling rows remain fixed:
EVALUATION_SYNTHETIC_ROWS=128 deno task evaluate /tmp/larger-report.json
```

The driver creates only `localembed-evaluation-db` and `localembed-evaluation-tei`, bound to localhost.
Existing containers with these names cause refusal; the driver never adopts or deletes them.
It removes the containers and their disposable database storage after success/failure. The model
cache named `localembed_tei-model` is retained/reused; override `EVALUATION_MODEL_VOLUME` to select
another cache. Test credentials are deliberately public fixture values, not deployment credentials.
Logs remain in the printed temporary directory. A failed run exits nonzero; an older report already
on disk is not evidence that the failed run succeeded.

Pinned images/model:

- ParadeDB 0.22.6-pg18, digest `2359a3628682f2dfc4ee65ed59f6a993d7851ed3d820b0c030c397ff7168b620`.
- TEI cpu-1.8, digest `8de25e75ce39617f17f2f6c77d60a4f75b65e779ed5005420eb1400072a15c1c`.
- `intfloat/multilingual-e5-base`, revision `129286372ebbc09af0394786dd03e16427ade171`, 768 dimensions.

Database limits: 2 CPUs, 2 GiB RAM, 256 MiB shared memory. TEI: 4 CPUs, 4 GiB RAM, router concurrency
8. These are experiment settings, not recommendations for production. Host/cgroup limits and actual
image identifiers/digests are attached to the report. Container readiness, which may include model
download, is recorded separately; an existing cache volume does not prove all model files are cached.
Warmup request and configuration preflight are separate from scenario timings.

For an externally managed test stack, run `scripts/evaluation/run.ts` with `TEST_DATABASE_URL`,
`TEST_TEI_ENDPOINT` and `LOCAL_EMBED_TEI_API_KEY`. The database must be empty: it refuses an existing
LocalEmbed schema or source fixture. This lower-level path leaves objects for inspection and does
not attach Docker/host observations automatically. Normal production databases must not be used.

## Workload and assertions

The default workload has 16 deterministic synthetic sources, 12 public USGS records and four
polling rows. [The committed snapshot](evaluation/data/usgs-2020-01.json) contains event identifiers,
titles, magnitude/place/time descriptions, the catalog query URL and original response hash.
Reports record the exact fixture SHA256. Evaluation uses this archive, never a changing live feed.
See the [official USGS API](https://earthquake.usgs.gov/fdsnws/event/1/) for query parameter semantics.
Public records exercise real data ingestion; they do not establish retrieval relevance or represent
an application workload.

Two worker instances share the driver process. Backfill and polling batches are eight. For the
lease scenario, workers use a deliberately short 1-second lease renewed every 100 ms, with a
30-second execution deadline. Retry base/max delay is 10/50 ms, max three attempts; the production
reference policy remains unchanged. Reconciliation is configured at 60 seconds and explicitly made
due for the functional polling probe, rather than waiting for a real scheduled interval.

| Scenario | Verified behavior |
| --- | --- |
| Initial backfill | Synthetic/public records produce real 768D embeddings. |
| Unrelated/unchanged updates | Ten of each generate no captures/inference. |
| Burst coalescing | Twenty sequential updates are followed by drain; latest requested state converges. |
| Dependency fan-out | One parent change synchronizes its trigger-mode roots. |
| Transient retry | One explicitly injected 503 is retried and then uses real inference. |
| Terminal failure/reprocess | One injected terminal error is retained, then explicitly reprocessed. |
| Lease renewal | An injected 400 ms delay lets the probe observe lease extension. |
| Polling/reconciliation | A changed row and physical deletion converge via the real bounded poller. |
| Retention | Batches of eight delete completed tasks without changing capture history. |

The driver verifies every remaining embedding fingerprint/dimension against current source and
related content before indexing. It builds real HNSW indexes concurrently, makes six query API
requests through the actual handler/SQL/provider (in-process HTTP objects, not a network server),
and measures ten read-only snapshots. It records queue depth, captured/coalesced totals, index/table
sizes, PostgreSQL settings, cumulative WAL observations and an actual EXPLAIN (ANALYZE, BUFFERS)
retention plan. API consumers still supply `query:`; query caching is explicitly absent.

## Read the report correctly

[artifact.json](evaluation/artifact.json) records configurations, versions, host limits, harness
hashes, source revision/dirty-worktree status, individual provider calls and phase summaries.
[artifact-resources.jsonl](evaluation/artifact-resources.jsonl) preserves raw Docker samples.

- Synchronization samples are `completed_at - requested_at` for the latest completed task generations
  requested during a phase. They include queue and injected delay, exclude pre-capture detection,
  and do not count coalesced intermediate source versions as completed samples. Nearest-rank
  p50/p95/p99 always include sample counts; zero samples produce null, not a fabricated latency.
- Completed-row throughput includes successful deletion tasks. It is not embedding inference
  throughput, source-write throughput or a capacity ceiling. Attempts/second and call counts are
  recorded separately; injected failures are distinguished from natural provider failures.
- Inference-call timings include the wrapper and its deliberately injected 400 ms lease delay;
  they are client-side attempt timings, not server-side TEI execution measurements.
- WAL statistics are asynchronous cumulative cluster counters. Deltas include background work and
  can flush across phase boundaries; they do not provide exact statement/phase WAL attribution.
- Docker CPU percentages are core-relative (400% can consume four cores), not a fraction of total
  host capacity. Memory peaks are sampled/rounded, not exact maxima. I/O/network counters are
  cumulative container values. The short run produces few Docker samples.
- Admin, workers, poller, API and snapshot share one Deno process here. Its RSS/CPU are recorded
  collectively; role-isolated runtime costs require the extended experiments. Model readiness and
  warmup are separate, with no claim of a controlled cold-model download benchmark.

The baseline runs with structured operational logs but no OTLP exporter or LGTM, so it cannot
measure export loss, backend sizing or enabled/disabled telemetry overhead. Earlier focused
[deployment](evaluation/deployment.json), [storage](evaluation/hybrid-storage.json),
[index](evaluation/indexes.json) and [retention](evaluation/retention.json) probes remain separately
versioned evidence. Their datasets/methods differ; they are not pooled into these latency samples.

## Mitigations and remaining experiments

[Primary-source research](research/index-operation-mitigations.md) supports resource budgets,
progress/long-reader monitoring and scoped administrative ownership. PostgreSQL backend capacity
must be budgeted directly; limiting the admin container is insufficient. HNSW memory/parallelism
and recall parameters require controlled measurements before tuning. Timeouts must distinguish
active queries from idle transactions, and cancellation must preserve invalid-index recovery.
Activation needs a durable delta and a short final fence that accounts for late commits.

#23 handles activation's remaining source-write blocking; #27 validates operational timeouts and
resource/alert policies. #30 defines safe administrative ownership by resource, preserving physical
session fencing and selection-versus-DROP races. #31 retains the expanded comparative measurements
previously collected in #10, including future cache/quota/token/polling/dependency/rollback/telemetry
features. Native dependencies gate those feature comparisons. This baseline does not claim
production sizing, mitigation speedups, GPU validation, retrieval quality or zero downtime.
