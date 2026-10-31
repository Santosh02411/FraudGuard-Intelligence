#!/usr/bin/env bash
# Full-stack E2E: starts the REAL ML service and the REAL backend (fresh SQLite file), runs
# tests/e2e-fullstack against them over HTTP, then tears everything down. Usage: npm run test:e2e:fullstack
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(cd .. && pwd)"
WORK="$(mktemp -d)"
ML_PORT="${E2E_ML_PORT:-18001}"; API_PORT="${E2E_API_PORT:-15000}"
ML_KEY="e2e-service-key-$RANDOM$RANDOM$RANDOM$RANDOM$RANDOM"; ML_ADMIN_KEY="e2e-admin-key-$RANDOM$RANDOM$RANDOM$RANDOM$RANDOM"; ADMIN_PW="E2e!Admin-$RANDOM$RANDOM"
PIDS=()
cleanup() { rc=$?; if [ "$rc" != 0 ]; then echo "---- ml.log"; tail -25 "$WORK/ml.log" 2>/dev/null; echo "---- api.log"; tail -25 "$WORK/api.log" 2>/dev/null; fi; for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; rm -rf "$WORK"; }
trap cleanup EXIT

( cd "$ROOT/ml_service" && exec env ML_SERVICE_API_KEY="$ML_KEY" ML_ADMIN_API_KEY="$ML_ADMIN_KEY" MONITOR_DB_PATH="$WORK/monitor.db" python3 -m uvicorn app:app --host 127.0.0.1 --port "$ML_PORT" >"$WORK/ml.log" 2>&1 ) &
PIDS+=($!)
for i in $(seq 1 90); do curl -sf "http://127.0.0.1:$ML_PORT/health" >/dev/null && break; sleep 1; [ "$i" = 90 ] && { echo "ML service did not start"; tail -30 "$WORK/ml.log"; exit 1; }; done

( exec env NODE_ENV=development PORT="$API_PORT" SQLITE_PATH="$WORK/e2e.db" JWT_SECRET="e2e-secret-$RANDOM$RANDOM$RANDOM$RANDOM" ADMIN_PASSWORD="$ADMIN_PW" \
  ML_SERVICE_URL="http://127.0.0.1:$ML_PORT" ML_SERVICE_API_KEY="$ML_KEY" ML_SERVICE_TIMEOUT_MS=5000 \
  RATE_LIMIT_AUTH_MAX=1000 RATE_LIMIT_TRANSACTIONS_MAX=1000 LOG_LEVEL=error ALERT_ESCALATION_INTERVAL_MS=0 \
  node server.js >"$WORK/api.log" 2>&1 ) &
PIDS+=($!)
for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$API_PORT/api/v1/health" >/dev/null && break; sleep 1; [ "$i" = 60 ] && { echo "backend did not start"; tail -30 "$WORK/api.log"; exit 1; }; done

E2E_BASE_URL="http://127.0.0.1:$API_PORT" E2E_ADMIN_PASSWORD="$ADMIN_PW" npx jest --runInBand --testMatch '**/tests/e2e-fullstack/*.e2e.js' --testTimeout 60000 "$@"
