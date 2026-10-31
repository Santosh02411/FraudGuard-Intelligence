#!/usr/bin/env bash
# Runs the concurrency/realtime suites against a REAL, throw-away PostgreSQL
# (true parallel sessions, row locks, unique-index races) instead of SQLite.
# Needs PostgreSQL server binaries (initdb/pg_ctl). Usage: npm run test:postgres
set -euo pipefail
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -1)}"
PORT="${PGPORT:-54329}"
DIR="$(mktemp -d)"
RUN=""; [ "$(id -u)" = "0" ] && { chown postgres "$DIR"; RUN="runuser -u postgres --"; }
cleanup() { $RUN "$PGBIN/pg_ctl" -D "$DIR/db" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT
$RUN "$PGBIN/initdb" -D "$DIR/db" -A trust >/dev/null
$RUN "$PGBIN/pg_ctl" -D "$DIR/db" -o "-p $PORT -k $DIR -c listen_addresses=127.0.0.1 -c max_connections=100" -l "$DIR/pg.log" -w start >/dev/null
"${PSQL:-psql}" -h 127.0.0.1 -p "$PORT" -U postgres -qc "create database fg_test"
if [ "$#" -eq 0 ]; then set -- tests/concurrency tests/realtime tests/governance; fi
DATABASE_URL="postgres://postgres@127.0.0.1:$PORT/fg_test" npx jest --runInBand --forceExit "$@"
