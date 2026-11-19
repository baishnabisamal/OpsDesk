#!/usr/bin/env bash
# Creates deploy/.env from deploy/.env.example with fresh random secrets.
#
#   ./deploy/init-env.sh opsdesk.203-0-113-10.sslip.io
#
# Refuses to overwrite an existing deploy/.env: new secrets would lock the
# app out of a database that was created with the old passwords.
set -euo pipefail
cd "$(dirname "$0")"

site="${1:-}"
if [[ -z "$site" ]]; then
  echo "usage: $0 <site-address>   (for example opsdesk.203-0-113-10.sslip.io)" >&2
  exit 1
fi
if [[ -e .env ]]; then
  echo "deploy/.env already exists; edit it by hand instead." >&2
  exit 1
fi

secret() { openssl rand -hex 32; }

sed \
  -e "s|^SITE_ADDRESS=.*|SITE_ADDRESS=${site}|" \
  -e "s|^APP_URL=.*|APP_URL=https://${site}|" \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(secret)|" \
  -e "s|^APP_DB_PASSWORD=.*|APP_DB_PASSWORD=$(secret)|" \
  -e "s|^JWT_SECRET=.*|JWT_SECRET=$(secret)|" \
  -e "s|^ML_SHARED_SECRET=.*|ML_SHARED_SECRET=$(secret)|" \
  -e "s|^INBOUND_WEBHOOK_SECRET=.*|INBOUND_WEBHOOK_SECRET=$(secret)|" \
  .env.example > .env
chmod 600 .env

echo "Wrote deploy/.env for https://${site}"
echo "Now fill in SMTP_USER, SMTP_PASSWORD and MAIL_FROM, then run ./deploy/update.sh"
