#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
secrets=deployments/.secrets
if [ -e "$secrets" ]; then echo 'Secrets already exist; refusing to replace credentials' >&2; exit 1; fi
umask 077
mkdir "$secrets"
for role in postgres admin worker poller api snapshot consumer; do
  openssl rand -hex 32 | tr -d '\n' > "$secrets/${role}_password"
  if [ "$role" != postgres ]; then
    password=$(cat "$secrets/${role}_password")
    printf 'postgres://le_%s:%s@database:5432/localembed\n' "$role" "$password" > "$secrets/${role}_url"
  fi
done
openssl rand -hex 32 | tr -d '\n' > "$secrets/tei_key"
openssl rand -hex 32 | tr -d '\n' > "$secrets/service_key"
openssl rand -hex 32 | tr -d '\n' > "$secrets/grafana_password"
# Compose bind-mounted secrets must be readable by PostgreSQL UID 999 and Deno UID 1000.
# The parent directory remains 0700; each container mounts only its own files.
chmod 0444 "$secrets"/*
printf 'Credentials created under %s (ignored by git).\n' "$secrets"
