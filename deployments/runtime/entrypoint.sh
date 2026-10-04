#!/bin/sh
set -eu
# Resource identity must exist before Deno initializes native OpenTelemetry.
export OTEL_RESOURCE_ATTRIBUTES="service.instance.id=${HOSTNAME},${OTEL_RESOURCE_ATTRIBUTES:-deployment.environment.name=reference}"
for name in DATABASE_URL LOCAL_EMBED_TEI_API_KEY LOCAL_EMBED_SERVICE_KEY; do
  eval "secret_file=\${${name}_FILE:-}"
  if [ -n "$secret_file" ]; then
    value=$(cat "$secret_file")
    export "$name=$value"
  fi
done
role=${1:?Specify worker, api, poller, telemetry, admin, bootstrap, probe or demo}
shift
case "$role" in
  worker|api|poller|telemetry) module="services/$role/main.ts" ;;
  admin) module=services/admin/main.ts ;;
  bootstrap|probe) module="deployments/runtime/$role.ts" ;;
  demo) export DEMO_DATABASE_URL="$DATABASE_URL"; module=examples/hybrid-search/main.ts ;;
  *) echo 'Unknown LocalEmbed role' >&2; exit 1 ;;
esac
exec deno run --cached-only --allow-read=/run/secrets,/app/deployments --allow-env --allow-net "$module" "$@"
