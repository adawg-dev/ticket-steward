#!/usr/bin/env bash
# Resets the local Postgres and TimescaleDB to the schema on the job's checkout.
#
# Runs as the first workspace.setup command, so cwd is the job's worktree with the
# overlay already laid down. Both schema files drop and recreate every object, so
# each job starts from an empty database with the current schema. Seeding is left
# to the steward-user-app-verify skill (`pnpm --filter @concentrate/user-portal-e2e dev:seed`).
#
# Credentials come from e2e/user/.env, the file the seed script reads, so the reset
# and the seed always hit the same databases. Nothing here prints them.
set -euo pipefail

ENV_FILE="e2e/user/.env"
PG_SCHEMA="sql/production/schema.sql"
TG_SCHEMA="sql/production/timescale_schema.sql"
# Fail fast if a local service or open session holds a lock, instead of hanging until the setup timeout.
export PGOPTIONS="-c lock_timeout=30s -c client_min_messages=warning"

[[ -f "$ENV_FILE" ]] || { echo "reset-dbs: $ENV_FILE not found (is the overlay in place?)" >&2; exit 1; }

# Reads KEY=value from the env file without sourcing it; strips surrounding quotes.
env_value() {
  local line value
  line="$(grep -E "^$1=" "$ENV_FILE" | tail -n 1 || true)"
  [[ -n "$line" ]] || { echo "reset-dbs: $1 missing from $ENV_FILE" >&2; exit 1; }
  value="${line#*=}"
  value="${value%\"}"; value="${value#\"}"
  value="${value%\'}"; value="${value#\'}"
  printf '%s' "$value"
}

run_schema() {
  local label="$1" file="$2"; shift 2
  [[ -f "$file" ]] || { echo "reset-dbs: $file not found in this checkout" >&2; exit 1; }
  echo "reset-dbs: applying $file to $label"
  psql "$@" -X -q -v ON_ERROR_STOP=1 -f "$file" >/dev/null
}

# Plain assignments, so a missing key stops the script under `set -e`.
db_host="$(env_value DB_HOST)"
db_port="$(env_value DB_PORT)"
db_name="$(env_value DB_NAME)"
db_user="$(env_value DB_USER)"
db_password="$(env_value DB_PASSWORD)"
tg_url="$(env_value TG_WRITE_CONN_STR)"

(
  export PGHOST="$db_host" PGPORT="$db_port" PGDATABASE="$db_name" PGUSER="$db_user" PGPASSWORD="$db_password"
  run_schema "postgres ($db_name)" "$PG_SCHEMA"
)

# The URL carries its own credentials; keep the Postgres ones out of this psql.
(
  unset PGPASSWORD
  run_schema "timescale" "$TG_SCHEMA" "$tg_url"
)

echo "reset-dbs: done"
