#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
helm=${HELM:-helm}
chart=deployments/helm/localembed
for file in collector.yaml dashboards.yaml localembed.json prometheus.yaml alerts.yaml; do
  cmp "deployments/telemetry/$file" "$chart/files/$file"
done
cmp deployments/runtime/init-database.sh "$chart/files/init-database.sh"
docker compose -f deployments/compose.yaml config --quiet
"$helm" lint "$chart"
"$helm" template localembed "$chart" >/dev/null
"$helm" template alternate "$chart" --set worker.replicas=3 --set api.replicas=2 \
  --set inference.resources.limits.nvidia\\.com/gpu=1 >/dev/null
# Invalid production configurations must fail rather than deploy the development bundle.
if "$helm" template localembed "$chart" --set production=true >/dev/null 2>&1; then
  echo 'Production guard did not reject development defaults' >&2; exit 1
fi
"$helm" template localembed "$chart" --set production=true \
  --set database.enabled=false --set inference.enabled=false --set dashboard.enabled=false \
  --set inference.endpoint=https://inference.example.com \
  --set telemetry.endpoint=https://collector.example.com --set telemetry.headersSecretKey=otlp_headers >/dev/null
printf 'Compose and Helm packaging verified.\n'
