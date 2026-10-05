#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
report_path=${1:-docs/evaluation/artifact.json}
resource_path="${report_path%.json}-resources.jsonl"
run_log_dir=$(mktemp -d /tmp/localembed-evaluation.XXXXXX)
database_container=localembed-evaluation-db
inference_container=localembed-evaluation-tei
model_volume=${EVALUATION_MODEL_VOLUME:-localembed_tei-model}
database_created=false
inference_created=false
observer_pid=''
cleanup() {
  if [[ -n "$observer_pid" ]]; then kill "$observer_pid" 2>/dev/null || true; wait "$observer_pid" 2>/dev/null || true; fi
  if $inference_created; then docker rm -fv "$inference_container" >/dev/null; fi
  if $database_created; then docker rm -fv "$database_container" >/dev/null; fi
}
trap cleanup EXIT
for container in "$database_container" "$inference_container"; do
  if docker inspect "$container" >/dev/null 2>&1; then
    echo "Refusing an existing evaluation container: $container" >&2; exit 1
  fi
done
mkdir -p "$(dirname "$report_path")"
docker run -d --name "$database_container" --cpus=2 --memory=2g --shm-size=256m \
  -e POSTGRES_PASSWORD=localembed-evaluation-test -e POSTGRES_DB=localembed -p 127.0.0.1:15432:5432 \
  paradedb/paradedb:0.22.6-pg18@sha256:2359a3628682f2dfc4ee65ed59f6a993d7851ed3d820b0c030c397ff7168b620 >"$run_log_dir/database-id"
database_created=true
export EVALUATION_CACHE_VOLUME_EXISTED
if docker volume inspect "$model_volume" >/dev/null 2>&1; then EVALUATION_CACHE_VOLUME_EXISTED=true; else EVALUATION_CACHE_VOLUME_EXISTED=false; fi
startup_started=$SECONDS
docker run -d --name "$inference_container" --cpus=4 --memory=4g \
  -e API_KEY=localembed-evaluation-key -e LOG_LEVEL=WARN -p 127.0.0.1:18080:80 \
  -v "$model_volume:/data" \
  ghcr.io/huggingface/text-embeddings-inference:cpu-1.8@sha256:8de25e75ce39617f17f2f6c77d60a4f75b65e779ed5005420eb1400072a15c1c \
  --model-id intfloat/multilingual-e5-base --revision 129286372ebbc09af0394786dd03e16427ade171 \
  --max-concurrent-requests 8 >"$run_log_dir/tei-id"
inference_created=true
ready=false
for ((attempt=0; attempt<600; attempt++)); do
  if curl -fsS --max-time 3 http://127.0.0.1:18080/health >/dev/null 2>&1 && \
    docker exec -e PGPASSWORD=localembed-evaluation-test "$database_container" psql -h 127.0.0.1 -U postgres -d localembed -At -c 'SELECT 1' >/dev/null 2>&1; then
    ready=true; break
  fi
  sleep 1
done
if ! $ready; then docker logs "$inference_container" >&2; echo 'Evaluation services did not become ready' >&2; exit 1; fi
startup_seconds=$((SECONDS-startup_started))
export OTEL_DENO=false
export TEST_DATABASE_URL=postgres://postgres:localembed-evaluation-test@127.0.0.1:15432/localembed
export TEST_TEI_ENDPOINT=http://127.0.0.1:18080
export LOCAL_EMBED_TEI_API_KEY=localembed-evaluation-key
export EVALUATION_GIT_DIRTY
if [[ -n "$(git status --porcelain)" ]]; then EVALUATION_GIT_DIRTY=true; else EVALUATION_GIT_DIRTY=false; fi
export EVALUATION_GIT_REVISION
EVALUATION_GIT_REVISION=$(git rev-parse HEAD)
python3 scripts/evaluation/observe.py "$resource_path" "$database_container" "$inference_container" &
observer_pid=$!
deno run --allow-read --allow-write --allow-env --allow-net scripts/evaluation/run.ts "$report_path" >"$run_log_dir/workload.log" 2>&1 || {
  tail -60 "$run_log_dir/workload.log" >&2; exit 1;
}
# Let the current Docker sampling call finish before stopping the observer.
sleep 2
kill "$observer_pid" 2>/dev/null || true
wait "$observer_pid" 2>/dev/null || true
observer_pid=''
python3 scripts/evaluation/finish_report.py "$report_path" "$resource_path" "$startup_seconds" "$database_container" "$inference_container"
printf 'Evaluation report: %s\nRaw resource samples: %s\nLogs: %s\n' "$report_path" "$resource_path" "$run_log_dir"
