#!/bin/bash
set -euo pipefail
# Invoked only by PostgreSQL's fresh-volume initialization path.
for role in admin worker poller api snapshot consumer; do
  password=$(cat "/run/secrets/${role}_password")
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    --set=role="le_${role}" --set=password="$password" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role', :'password') \gexec
SQL
done
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
ALTER DATABASE localembed OWNER TO le_admin;
GRANT CREATE ON SCHEMA public TO le_admin;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_search;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
