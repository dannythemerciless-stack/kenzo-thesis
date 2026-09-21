#!/usr/bin/env bash
#
# Apply the migrations to a throwaway Postgres in Docker and run the invariant
# tests. Never touches your Supabase project.
#
#   pnpm test:db
#
set -euo pipefail

CONTAINER=gp-pg
DB=exp_test
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if ! docker info >/dev/null 2>&1; then
  echo "✖ Docker is not running. Start Docker Desktop and retry." >&2
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "▸ Starting throwaway Postgres…"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" \
    -e POSTGRES_PASSWORD=pw -e POSTGRES_DB="$DB" \
    -p 55432:5432 postgres:17-alpine >/dev/null
  for _ in $(seq 1 30); do
    docker exec "$CONTAINER" pg_isready -U postgres -d "$DB" >/dev/null 2>&1 && break
    sleep 1
  done
fi

psql_run() { docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q "$@"; }

echo "▸ Recreating schema…"
# Supabase-specific roles that do not exist in vanilla Postgres. The migration
# tolerates their absence, but creating them lets the grant tests run for real.
psql_run <<'SQL' >/dev/null
drop schema if exists exp cascade;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
SQL

for f in "$HERE"/supabase/migrations/*.sql; do
  echo "  applying $(basename "$f")"
  psql_run < "$f" >/dev/null
done

echo "▸ Running invariant tests…"
set +e
OUT=$(psql_run < "$HERE/supabase/tests/schema_test.sql" 2>&1)
CODE=$?
set -e

echo "$OUT" | grep -E 'PASS|FAIL|ERROR' | sed 's/^NOTICE:  //'

if [ $CODE -ne 0 ]; then
  echo ""
  echo "✖ SCHEMA TESTS FAILED"
  exit 1
fi

echo ""
echo "✔ $(echo "$OUT" | grep -c PASS) schema invariants verified"
