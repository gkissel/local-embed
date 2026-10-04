#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
namespace=${1:-localembed}
release=${2:-localembed}
# Never print secret values or place them in command arguments.
task_secret_dir=$(mktemp -d)
trap 'rm -rf "$task_secret_dir"' EXIT HUP INT TERM
chmod 700 "$task_secret_dir"
for role in admin worker poller api snapshot consumer; do
  sed "s/@database:5432/@${release}-database:5432/" "deployments/.secrets/${role}_url" > "$task_secret_dir/${role}_url"
done
for key in tei_key service_key grafana_password; do
  tr -d '\n' < "deployments/.secrets/$key" > "$task_secret_dir/$key"
done
kubectl create namespace "$namespace" --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic localembed-runtime -n "$namespace" \
  --from-file="worker_url=$task_secret_dir/worker_url" \
  --from-file="poller_url=$task_secret_dir/poller_url" \
  --from-file="api_url=$task_secret_dir/api_url" \
  --from-file="snapshot_url=$task_secret_dir/snapshot_url" \
  --from-file="consumer_url=$task_secret_dir/consumer_url" \
  --from-file="tei_key=$task_secret_dir/tei_key" \
  --from-file="service_key=$task_secret_dir/service_key" \
  --from-file="grafana_password=$task_secret_dir/grafana_password" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic localembed-admin -n "$namespace" \
  --from-file="admin_url=$task_secret_dir/admin_url" \
  --from-file=postgres_password=deployments/.secrets/postgres_password \
  --from-file=admin_password=deployments/.secrets/admin_password \
  --from-file=worker_password=deployments/.secrets/worker_password \
  --from-file=poller_password=deployments/.secrets/poller_password \
  --from-file=api_password=deployments/.secrets/api_password \
  --from-file=snapshot_password=deployments/.secrets/snapshot_password \
  --from-file=consumer_password=deployments/.secrets/consumer_password \
  --from-file="tei_key=$task_secret_dir/tei_key" \
  --dry-run=client -o yaml | kubectl apply -f -
