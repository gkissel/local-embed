# Reference deployment

Issue #9 packages one LocalEmbed image for worker, query API, poller, the read-only snapshot
exporter and explicit administration. Compose and Helm use identical default runtime, ParadeDB, TEI
and LGTM images. PostgreSQL 18.3, `pg_search` 0.22.6 and `vector` 0.8.1 were verified in the pinned
ParadeDB 0.22.6 image. BM25 continues to use `USING bm25`; do not substitute the newer `paradedb`
access method without a separately verified version migration.

## Compose

From the repository root:

```sh
scripts/deployment/prepare.sh
docker compose -f deployments/compose.yaml up -d --build
docker compose -f deployments/compose.yaml ps
# After the worker finishes its initial eight tasks:
docker compose -f deployments/compose.yaml run --rm --no-deps admin
docker compose -f deployments/compose.yaml run --rm --no-deps demo keyboard
```

The fresh database installs the two extensions, creates distinct database credentials and hands
ownership to `le_admin`. The one-shot bootstrap creates the #8 demonstration source, its BM25 index,
applies the immutable configuration through the real provider preflight, grants runtime privileges
and requests backfill. Runtime roles do no DDL. The configuration uses `http://tei:80` inside the
network, rather than a host loopback address. Every role references this applied database
configuration, not its own mutable copy.

The API is at `127.0.0.1:8090` and Grafana at `127.0.0.1:3000`. Use Grafana username `admin` and the
password in `deployments/.secrets/grafana_password`. Database, TEI, OTLP and internal backends have
no published host ports. Set `LOCAL_EMBED_API_PORT` / `LOCAL_EMBED_GRAFANA_PORT` if needed and keep
these values consistent for subsequent Compose commands. There are no fixed container names;
`--scale worker=2 --scale api=2` needs removing the API host-port mapping or placing a gateway in
front of its replicas. The snapshot exporter must remain one replica per database.

Credentials are random, ignored by git, and excluded from Docker build context. Their parent
directory is mode 0700. Files are readable inside bind-mounted secrets because PostgreSQL and Deno
use different UIDs; each service receives only the files it needs. Compose secrets are local files,
not an encrypted secret manager. Preserve these files alongside the persistent volumes: regenerating
credentials does not change passwords in an existing database. `prepare.sh` refuses to replace them.

The consumer has SELECT on source, applied configuration metadata and the active destination. It
receives no provider key, task access or write grants. API credentials are separate from provider
credentials. The current API key still grants all applied entities; per-consumer/per-entity
permissions and quotas are #15. `DEMO_TENANT` belongs to a trusted operator/authorization context,
not a tenant value supplied by an untrusted caller. SQL publication/tenant filters do not
authenticate.

`docker compose ... down` preserves database, model cache and telemetry volumes. Bootstrap reruns
restore reference grants without re-enqueueing existing data. An interrupted setup with an existing
source but missing applied configuration fails explicitly; repair it administratively. Resetting
volumes is a destructive operator action, never a startup behavior.

## Your own configuration and administrative operation

Use the schema in `contracts/schema/localembed.v1.schema.json`. Create/own the source tables and any
BM25 indexes as an administrator, set provider endpoint/model/dimensions, then mount a config file
in an administrative run:

```sh
docker compose -f deployments/compose.yaml run --rm --no-deps \
  -v "$PWD/my-config.json:/app/deployments/operator.json:ro" \
  admin admin migrate /app/deployments/operator.json
```

Compose overrides `command` here, so the first `admin` is the service and the second is the image
role. Use `LOCAL_EMBED_TEI_API_KEY` as `secret_env` for the packaged provider secret, or add a
separate secret mapping for another provider. No credential belongs in JSON. The reference bootstrap
grants only the demonstration objects; custom sources, dependencies and destinations need their own
explicit grants. Follow [queue coordination](queue-coordination.md),
[polling](polling-dependencies.md), [revisions and retries](resilience.md) and
[telemetry](telemetry.md).

Grant worker SELECT on source/dependencies and configuration metadata; SELECT/UPDATE on tasks;
SELECT/INSERT/UPDATE/DELETE on destinations; EXECUTE on the fixed `revision_eligible` and generated
source/dependency locking helpers. Poller needs source/destination SELECT, queue/cursor/counter DML,
task sequence USAGE and enqueue/revision functions. API only reads applied configuration metadata.
Snapshot reads tasks, entity revisions, polling state and enqueue counters, never source or provider
configuration. Source writers using invoker triggers need enqueue/counter DML, task sequence USAGE
and enqueue/revision functions in addition to their source grants. Do not grant broad default
privileges across all future LocalEmbed tables.

`stage config.json`, backfill, `build-indexes` and `activate revision` remain explicit
administrative steps. Grant consumers access to the candidate destination before activation. Keep
source writers paused during the current activation validation; it takes source locks. For a new
revision, update its destination and helper grants before starting runtimes. Rollback currently
prepares a fresh revision. Preserve old destinations for active reader snapshots; enable cleanup only after adopting the
[reader protection and retention policy](retention.md).

Workers renew a 60-second lease every 20 seconds and have a 300-second execution deadline. Renewals
fence late writes; retries can still repeat inference. Query retries follow the applied
`operations.retries` policy within the existing 30-second request deadline. TEI concurrency is 32
per inference replica; it is a provider admission limit, not a per-consumer quota nor a shared
cluster-wide limit. Configure Helm `inference.concurrency` or the corresponding Compose router
argument (`LOCAL_EMBED_TEI_CONCURRENCY`). CPU limits and memory are configurable through
`LOCAL_EMBED_TEI_CPUS` / `LOCAL_EMBED_TEI_MEMORY`. Bounded queue cleanup and an optional Helm CronJob are available; see [retention](retention.md)
for migration, dry-run, scheduling and reader acknowledgement. Use `build-indexes --concurrently`
for live destinations; see [online index operation](online-indexes.md).
Query token/prefix preparation (#14) and scoped permissions/quotas (#15) remain pending.
Default ordinary HNSW construction can block destination writes.

## Kubernetes / Helm

Build and distribute the same Docker image to a registry reachable by the cluster; use an immutable
tag/digest in `values.image`. For local Kind, `kind load docker-image localembed:0.1.0 --name NAME`
avoids a registry. Helm itself does not build or publish images.

```sh
scripts/deployment/kubernetes-secrets.sh localembed localembed
helm install localembed deployments/helm/localembed -n localembed
kubectl wait -n localembed --for=condition=complete job/localembed-bootstrap --timeout=20m
kubectl get pods -n localembed
kubectl port-forward -n localembed svc/localembed-api 8090:8090
```

The helper prepares two separately named Kubernetes Secrets. Runtime Pods mount only their own
credential keys; the administrative secret is mounted only by the initialization Job and database
initialization. The helper derives internal database URLs for the specified release name and removes
line endings from keys used as environment variables. For production/external databases provision
these secrets through your secret manager, with the database URLs and grants already prepared. Do
not reuse a local demonstration credential set across environments.

Values configure replica counts, resources, provider/model endpoint, model revision, storage class,
termination grace, telemetry, secrets and inference node selectors/tolerations. Snapshot uses one
replica and a Recreate rollout. All runtime Deployments wait for applied metadata/grants before
starting; readiness checks use bounded SQL, and API readiness also checks its HTTP listener without
model inference. Liveness tests process existence and avoids restarting every Pod during a shared DB
outage; stalled work is detected through queue/execution/freshness telemetry instead. Stateful
components retain PVCs on uninstall; restarting initialization never resets them.

The default inference image is CPU. GPU allocation can be expressed through
`inference.resources.limits.nvidia.com/gpu` plus scheduling values, but requires a compatible,
explicitly pinned TEI GPU image and a device plugin. Requesting GPU on the CPU image does not turn
it into a GPU backend. This hardware-specific provider-image choice does not change any LocalEmbed
role image. Compose can select the same provider image with `LOCAL_EMBED_TEI_IMAGE` and a device
reservation override. GPU execution was not tested on the reference host.

For an explicit administrative Job, render only `templates/admin-job.yaml` with
`administration.enabled=true` and `administration.args`, then `kubectl apply -f`. Configuration
files can come from `administration.configurationConfigMap`, mounted under
`/app/deployments/operator`. It is not an automatic Helm migration hook. Before upgrades that change
the bootstrap Job template, delete its completed Job explicitly or set `bootstrap.enabled=false`
after initial setup. Delete a completed Job before submitting another command, since Job templates
are immutable. For custom/managed databases set `bootstrap.enabled=false` and perform
migrations/grants before runtime readiness.

Production mode rejects the bundled database/dashboard, unprotected OTLP and disabled network
isolation. Set `production=true`, `database.enabled=false`, `dashboard.enabled=false`, external TLS
database URLs, an HTTPS OTLP endpoint and `telemetry.headersSecretKey` naming a runtime-secret key
containing the OTLP authorization headers. Configure `networkPolicy.externalEgress` to your managed
service CIDRs/ports, and `networkPolicy.apiClients` for a trusted gateway that terminates TLS and
implements actual consumer authorization. No public Ingress is created. Network policies require a
CNI that enforces them; Kind's default kindnet does not validate enforcement. Reference TEI gets
HTTPS egress for Hugging Face/CDN downloads; offline production deployments should preload models
and narrow that rule. External collector/backends require their own TLS/auth, persistent queues,
retention, alert routing and measured sizing.

## Telemetry durability, shutdown and limits

All roles set `service.instance.id` from their container/Pod hostname before Deno initializes
telemetry. The Collector keeps the instrumentation-scope and safe JSON-event log filters before
export. Native HTTP spans may contain request URLs, so do not remove these filters. The packaged TEI
uses `LOG_LEVEL=WARN`; its pinned router otherwise logs startup arguments including its API key. Do
not enable verbose provider diagnostics around credentials or source/query data.

The Collector has persistent sending queues backed by file storage under `/data/collector-queue`,
with fsync, 256 requests per signal and a 64 MiB maximum per storage database. This is bbolt-backed
file storage, not an application outbox. Three queues share the telemetry volume with the backends;
filesystem/backend retention and free-space monitoring are still required. Transient backend retries
have no elapsed-time expiry, but queues/disk are bounded and nonretryable failures can be dropped.
Batching also keeps a short in-memory window before the queue. Persistence protects telemetry
already written to queue storage, not every request acknowledged by the receiver or event created by
the application.
[Collector file storage](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.161.0/extension/storage/filestorage/README.md)
and
[queue semantics](https://github.com/open-telemetry/opentelemetry-collector/blob/v0.161.0/exporter/exporterhelper/README.md)
describe these boundaries.

Exports run every 15 seconds, traces are sampled at 10% with parent-based sampling, Collector memory
is limited and every service has CPU/memory limits. Application logging remains one safe event per
instrumented lifecycle action; trace sampling does not sample logs/counters. #26 tracks configurable
counter/snapshot cost; #10 measures volume/overhead before choosing production sizing or separated/
managed backends. The single LGTM bundle is a development demonstrator, not a production HA stack.

Applications receive 45 seconds to stop, finish/abort work and perform native Deno final export;
database shutdown gets 60 seconds. Native final export was observed with SIGTERM; SIGKILL skips
finalization and can lose application-buffered telemetry. Collector/backend outages can also exceed
a shutdown deadline, so graceful termination is a mitigation, not guaranteed delivery. Existing
transactional administrative actions and enqueue counters are the durable operational evidence.

Prometheus loads eight rules for snapshot age/missing snapshots, each runtime's export freshness,
Collector health, queue pressure and rejected enqueue. Rules are provisioned and visible locally;
external alert delivery requires an Alertmanager/managed route. Backend disk/capacity alerts belong
to the operator's production storage monitoring.

## Verification

```sh
deno task check
deno task test
HELM=helm scripts/deployment/verify-packaging.sh
# Mandatory real provider path, not skipped when the model is absent:
scripts/deployment/verify-reference.sh
```

The manual GitHub Actions `Reference deployment (real TEI)` workflow performs the same pre-release
check; it does not publish images or releases. Initial downloads need internet and approximately 1.1
GiB model cache; model loading/warmup consumes more memory than just storing weights. The reference
host observed approximately 1.36 GiB TEI RSS and 555 MiB LGTM RSS after warmup; these are one idle
observation, not production sizing results.

`verify-collector.py` uses the real pinned Collector with an unavailable test backend, kills and
restarts it with the same storage, verifies filtered logs, and exercises queue saturation,
configured storage limits and a full dedicated tmpfs filesystem. Overflow probes remove only
asynchronous batching to expose receiver rejection synchronously. `verify-shutdown.py` verifies a
final native Deno log after SIGTERM and its absence after SIGKILL; actual worker/API/poller/snapshot
shutdown was also checked. The real-TEI API smoke checks 768 finite/nonzero dimensions,
model/revision metadata, unauthorized/unknown entity requests and a sanitized model token-overflow
failure. Negative proxy fault scenarios and a broader real-provider suite remain #17.

A local Kind installation additionally exercised real chart bootstrap, PVC-backed ParadeDB/TEI/LGTM,
runtime readiness, replicated API/worker roles and real API inference. Policy enforcement and GPU
execution require appropriate infrastructure and were not validated on Kind.
