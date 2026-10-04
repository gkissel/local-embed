#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
# This script keeps volumes and credentials. It never silently falls back to mocked inference.
if [ ! -d deployments/.secrets ]; then scripts/deployment/prepare.sh; fi
scripts/deployment/verify-packaging.sh
docker compose -f deployments/compose.yaml build
docker compose -f deployments/compose.yaml up -d
# up waits for real model readiness and the successful administrative bootstrap.
for attempt in $(seq 1 90); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${LOCAL_EMBED_API_PORT:-8090}/v1/embeddings")" = 405 ]; then break; fi
  if [ "$attempt" = 90 ]; then echo 'API readiness timed out' >&2; exit 1; fi
  sleep 1
done
LOCAL_EMBED_API_ENDPOINT="http://127.0.0.1:${LOCAL_EMBED_API_PORT:-8090}" deno task verify:deployment:tei
# Build indexes is explicit administration and can briefly block destination writes.
docker compose -f deployments/compose.yaml run --rm --no-deps admin
# Trusted demonstration operator; SQL filters are not tenant authentication.
docker compose -f deployments/compose.yaml run --rm --no-deps demo
python3 scripts/deployment/verify-grafana.py
python3 scripts/deployment/verify-collector.py
python3 scripts/deployment/verify-shutdown.py
