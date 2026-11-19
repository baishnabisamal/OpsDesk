#!/usr/bin/env bash
# First deploy and every update after it:
#   1. fetch the latest code (skipped with --no-pull),
#   2. build the images,
#   3. start everything; the migrate container applies new migrations first,
#      and Docker replaces only the containers whose image changed.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f deploy/.env ]]; then
  echo "deploy/.env is missing. Run ./deploy/init-env.sh <site-address> first." >&2
  exit 1
fi

if [[ "${1:-}" != "--no-pull" ]]; then
  git pull --ff-only
fi

compose() { docker compose --env-file deploy/.env -f deploy/docker-compose.yml "$@"; }

compose build
compose up -d --remove-orphans --wait
# Old image layers pile up with every build; remove the unused ones.
docker image prune -f >/dev/null

compose ps
echo "Deployed. Check: curl -fsS $(grep '^APP_URL=' deploy/.env | cut -d= -f2-)/readyz"
