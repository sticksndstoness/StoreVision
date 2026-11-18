#!/usr/bin/env bash
# Runs the database tests against a throwaway local PostgreSQL (no Supabase account needed).
# Usage: bash tests/db/run.sh        (needs PostgreSQL server binaries, e.g. `apt install postgresql`)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../.."

PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
if [ -z "$PGBIN" ] || [ ! -x "$PGBIN/initdb" ]; then echo "PostgreSQL server binaries not found (install the 'postgresql' package)"; exit 2; fi

# the throwaway cluster lives inside the repo (git-ignored) so the unprivileged postgres user can reach it; removed on exit
work="$(mktemp -d "$root/.pgtest.XXXXXX")"; work="$(cd "$work" && pwd)"
port=$((54000 + RANDOM % 900))
RUN=()
if [ "$(id -u)" = 0 ]; then chown postgres "$work"; RUN=(runuser -u postgres --); fi   # initdb refuses to run as root

cleanup() { "${RUN[@]}" "$PGBIN/pg_ctl" -D "$work/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT

"${RUN[@]}" "$PGBIN/initdb" -D "$work/data" -A trust -U postgres >/dev/null
"${RUN[@]}" "$PGBIN/pg_ctl" -D "$work/data" -o "-p $port -k $work -c listen_addresses=''" -l "$work/pg.log" -w start >/dev/null

sql() { psql -h "$work" -p "$port" -U postgres -d storevision_test -v ON_ERROR_STOP=1 -q "$@"; }
psql -h "$work" -p "$port" -U postgres -d postgres -v ON_ERROR_STOP=1 -q -c "create database storevision_test" >/dev/null

sql -f "$here/shim.sql" >/dev/null
for f in "$root"/supabase/migrations/*.sql; do sql -f "$f" >/dev/null; done
sql -f "$here/foundation.test.sql" 2>&1 | sed -E 's/^psql:[^ ]+: //' | tee "$work/out.txt"

if grep -q "FAIL" "$work/out.txt"; then echo "DB TESTS FAILED"; exit 1; fi
echo "$(grep -c '^NOTICE:  PASS' "$work/out.txt") database checks passed"
