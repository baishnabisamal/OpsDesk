#!/usr/bin/env bash
# Contract test: Schemathesis reads the API's OpenAPI document and sends it
# thousands of generated requests, valid and invalid, checking every answer.
# The rule that matters most: the API never answers 500.
#
# It runs against a THROWAWAY database (opsdesk_contract) in the local
# Postgres container, never against your dev data:
#   1. drop and recreate opsdesk_contract, migrate it, seed it
#   2. start the API on port 3200 pointed at it
#   3. log in as the seeded lead to get a token
#   4. run Schemathesis
#   5. stop the API
#
# Needs: make up (Postgres, Redis), make setup, and tools/.venv with
# Schemathesis installed (python3 -m venv tools/.venv && tools/.venv/bin/pip install schemathesis).
set -euo pipefail
cd "$(dirname "$0")/.."

DB=opsdesk_contract
PORT=3200
BASE="http://127.0.0.1:${PORT}"
EXAMPLES="${EXAMPLES:-50}" # generated requests per operation and phase
set -a; . ./.env; set +a

echo "== fresh database ${DB}"
docker exec opsdesk-postgres-1 psql -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "DROP DATABASE IF EXISTS ${DB}" -c "CREATE DATABASE ${DB}"
# Values already in the environment win over --env-file, so POSTGRES_DB here
# points migrate and seed at the throwaway database.
(cd api && POSTGRES_DB=$DB npx tsx --env-file=../.env scripts/migrate.ts >/dev/null)
(cd api && POSTGRES_DB=$DB npx tsx --env-file=../.env scripts/seed.ts >/dev/null)

if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port ${PORT} is already in use (an API left over from an earlier run?). Stop it first." >&2
  exit 1
fi

echo "== API on port ${PORT} (log: var/contract/api.log)"
mkdir -p var/contract && : > var/contract/api.log
(cd api && POSTGRES_DB=$DB API_PORT=$PORT LOG_LEVEL=error \
  RATE_LIMIT_USER_CAPACITY=1000000 RATE_LIMIT_AGENCY_CAPACITY=1000000 RATE_LIMIT_LOGIN_CAPACITY=1000000 \
  npx tsx --env-file=../.env src/server.ts >>"../var/contract/api.log" 2>&1) &
API_PID=$!
# npx and tsx each start a child process, so killing $API_PID alone can leave
# the real server running (that happened once, and later runs then tested old
# code). On exit, stop whatever is listening on the port as well.
stop_api() {
  kill "$API_PID" 2>/dev/null || true
  lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
}
trap stop_api EXIT
for _ in $(seq 1 60); do curl -sf "${BASE}/healthz" >/dev/null && break; sleep 0.5; done

TOKEN=$(curl -sf "${BASE}/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"lead.eu@opsdesk.test","password":"Password123!"}' |
  python3 -c 'import sys, json; print(json.load(sys.stdin)["access_token"])')

run_schemathesis() { # $1 = label, $2 = token, then extra options
  local label=$1 token=$2; shift 2
  echo "== Schemathesis: ${label} (${EXAMPLES} examples per operation)"
  tools/.venv/bin/schemathesis "$@" run "${BASE}/openapi.json" \
    --url "${BASE}" \
    --header "Authorization: Bearer ${token}" \
    --checks not_a_server_error \
    --max-examples "$EXAMPLES" \
    --seed 1 \
    --report junit,vcr --report-dir "var/contract/${label}"
}

login() {
  curl -sf "${BASE}/api/v1/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"Password123!\"}" |
    python3 -c 'import sys, json; print(json.load(sys.stdin)["access_token"])'
}
REQUESTER_TOKEN=$(login user1@skyline-travels.test)

# Pass 1: everything generated, ids included (mostly 404s, but every input
# shape is tried).
run_schemathesis generated-ids "$TOKEN"

# Real ids for passes 2 and 3: two of the requester's own tickets, the case
# of the first, and a supplier thread started on it by the lead.
read -r CT_TICKET CT_CASE CT_OTHER_TICKET < <(docker exec opsdesk-postgres-1 psql -At -F ' ' \
  -U "$POSTGRES_USER" -d "$DB" -c "
    SELECT a.id, a.case_id, b.id
      FROM tickets a JOIN tickets b ON b.agency_id = a.agency_id AND b.id <> a.id
      JOIN users u ON u.id = a.requester_id
     WHERE u.email = 'user1@skyline-travels.test' AND a.status <> 'closed'
     LIMIT 1")
CT_SIDE=$(curl -sf "${BASE}/api/v1/tickets/${CT_TICKET}/side-conversations" \
  -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' \
  -d '{"subject":"Contract test","participants":[{"email":"desk@hotel.example"}],"body":"Hello"}' |
  python3 -c 'import sys, json; print(json.load(sys.stdin)["id"])')
export CT_TICKET CT_CASE CT_OTHER_TICKET CT_SIDE

# Pass 2: real ids, as a lead (staff: may edit, assign, escalate, export).
run_schemathesis lead-real-ids "$TOKEN" --config-file tools/schemathesis.toml
# Pass 3: real ids, as the requester who owns them (may create, reply, close).
run_schemathesis requester-real-ids "$REQUESTER_TOKEN" --config-file tools/schemathesis.toml
