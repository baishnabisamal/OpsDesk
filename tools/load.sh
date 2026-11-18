#!/usr/bin/env bash
# Load test: measures read and create latency with k6 (README Phase 6 gate).
#
# Like the contract test, it never touches dev data:
#   1. drop and recreate the database opsdesk_load, migrate it, seed it,
#      and add 200,000 tickets (load/fill.sql) so tables have a real size
#   2. start the ML service on port 8101 (if ml/.venv exists), so create
#      includes a real classify call, as in production
#   3. start the API on port 3300 against that database, with the rate
#      limits raised (the test is one machine pretending to be many users)
#   4. run load/read.js, then load/create.js
#   5. stop everything; summaries are in var/load/
#
# Needs: make up, make setup, k6 (brew install k6). Optional: make ml-setup.
set -euo pipefail
cd "$(dirname "$0")/.."

DB=opsdesk_load
PORT=3300
ML_PORT=8101
BASE="http://127.0.0.1:${PORT}"
set -a; . ./.env; set +a

command -v k6 >/dev/null || { echo "k6 is not installed (brew install k6)" >&2; exit 1; }
for port in $PORT $ML_PORT; do
  if lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port ${port} is already in use (left over from an earlier run?). Stop it first." >&2
    exit 1
  fi
done

echo "== fresh database ${DB}"
docker exec opsdesk-postgres-1 psql -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "DROP DATABASE IF EXISTS ${DB}" -c "CREATE DATABASE ${DB}"
(cd api && POSTGRES_DB=$DB npx tsx --env-file=../.env scripts/migrate.ts >/dev/null)
(cd api && POSTGRES_DB=$DB npx tsx --env-file=../.env scripts/seed.ts >/dev/null)
# Realistic volume (default 200,000 tickets), so queries run over real-sized
# tables and indexes. LOAD_TICKETS=0 skips it.
LOAD_TICKETS="${LOAD_TICKETS:-200000}"
if [ "$LOAD_TICKETS" -gt 0 ]; then
  echo "== adding ${LOAD_TICKETS} tickets (load/fill.sql)"
  docker exec -i opsdesk-postgres-1 psql -q -U "$POSTGRES_USER" -d "$DB" \
    -v rows="$LOAD_TICKETS" -f - <load/fill.sql >/dev/null
fi

mkdir -p var/load && : > var/load/api.log && : > var/load/ml.log
PIDS=()
stop_all() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  # npx/tsx/uvicorn start children; free the ports as well.
  lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
  lsof -tiTCP:"$ML_PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
}
trap stop_all EXIT

ML_NOTE="ML service not running: create used the rule fallback"
# NO_ML=1 leaves the ML service off, to see how much of create time it costs.
if [ -z "${NO_ML:-}" ] && [ -x ml/.venv/bin/python ] && [ -f ml/models/intent.joblib ]; then
  echo "== ML service on port ${ML_PORT}"
  (cd ml && .venv/bin/python -m uvicorn service:app --port "$ML_PORT" >>"../var/load/ml.log" 2>&1) &
  PIDS+=($!)
  for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:${ML_PORT}/healthz" >/dev/null && break; sleep 0.5; done
  curl -sf "http://127.0.0.1:${ML_PORT}/healthz" >/dev/null && ML_NOTE="ML service running: create included a real classify call"
fi

echo "== API on port ${PORT} (log: var/load/api.log)"
# LOG_LEVEL=warn: request logging to a file would be part of what is
# measured; production would ship logs asynchronously.
(cd api && POSTGRES_DB=$DB API_PORT=$PORT LOG_LEVEL=warn ML_URL="http://127.0.0.1:${ML_PORT}" \
  RATE_LIMIT_USER_CAPACITY=1000000 RATE_LIMIT_AGENCY_CAPACITY=1000000 RATE_LIMIT_LOGIN_CAPACITY=1000000 \
  npx tsx --env-file=../.env src/server.ts >>"../var/load/api.log" 2>&1) &
PIDS+=($!)
for _ in $(seq 1 60); do curl -sf "${BASE}/healthz" >/dev/null && break; sleep 0.5; done

# A short warm-up so the first measured requests do not pay for cold caches
# and the database connection pool filling up.
k6 run --quiet --no-summary -e BASE_URL="$BASE" -e DURATION=10s load/read.js >/dev/null 2>&1 || true

# READ_RATE / CREATE_RATE override the rates, to look for the breaking
# point: READ_RATE=400 ./tools/load.sh
READ_RATE="${READ_RATE:-50}"
CREATE_RATE="${CREATE_RATE:-5}"
status=0
echo "== reads: ${READ_RATE} requests per second for 60 s"
k6 run --quiet -e BASE_URL="$BASE" -e RATE="$READ_RATE" load/read.js | tee var/load/read.txt || status=1
echo "== creates: ${CREATE_RATE} per second for 60 s"
k6 run --quiet -e BASE_URL="$BASE" -e RATE="$CREATE_RATE" load/create.js | tee var/load/create.txt || status=1
echo "== ${ML_NOTE}" | tee -a var/load/create.txt
exit $status
