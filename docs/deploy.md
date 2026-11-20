# Deploying OpsDesk

OpsDesk runs on one Linux server with Docker Compose. Every process gets its own container, and Caddy is the only one the internet can reach.

```
internet --443--> web (Caddy: HTTPS, React files)
                    |-- /api, /healthz, /readyz --> api (Node)      --> postgres, redis, ml
                    '-- /socket.io              --> realtime (Node) --> redis
                  worker (Node, no port)                            --> postgres, redis, SMTP
                  migrate (runs once per start, then exits)
```

The files are in [`deploy/`](../deploy):

| File                           | What it does                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| `docker-compose.yml`           | All services, volumes, health checks, start order                                          |
| `api.Dockerfile`               | One image for the API, worker, gateway and migrations (TypeScript compiled to JavaScript)  |
| `web.Dockerfile` + `Caddyfile` | The React build served by Caddy, which also proxies the API and gets the HTTPS certificate |
| `../ml/Dockerfile`             | The ML service; the model is trained while the image is built                              |
| `.env.example`                 | Every setting, with comments                                                               |
| `init-env.sh`                  | Creates `deploy/.env` with random secrets                                                  |
| `update.sh`                    | First deploy and every update                                                              |
| `backup.sh`                    | Daily database dump, keeps 14                                                              |

CI (`.github/workflows/ci.yml`, job `deploy`) builds the same images on every push, starts the stack, and checks `/readyz`, the React app, the WebSocket handshake, a seeded sign-in, and that `/metrics` is not public.

## 1. A server

Any VPS with Ubuntu 24.04, 2 vCPU and 4 GB of memory is enough (for example Hetzner CX22, about EUR 5 a month). Images take about 1.5 GB; leave 10 GB free for builds and data.

Sign in as root once, then make a normal user and a firewall:

```bash
adduser opsdesk && usermod -aG sudo opsdesk
rsync --archive --chown=opsdesk:opsdesk ~/.ssh /home/opsdesk   # copy your SSH key
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable
apt update && apt install -y unattended-upgrades git
```

Install Docker (official script), and let the user run it:

```bash
curl -fsSL https://get.docker.com | sh
usermod -aG docker opsdesk
```

From now on, sign in as `opsdesk`.

## 2. A name for the site

Without a domain, use sslip.io: the server's IP address with dashes resolves to that IP, and Let's Encrypt issues certificates for it. For the IP 203.0.113.10:

```
opsdesk.203-0-113-10.sslip.io
```

With your own domain, add an `A` record pointing at the server and use that name instead.

## 3. Email

Sign-up, password reset and staff invitations send email, so the system needs an SMTP provider. Brevo's free plan (300 emails a day) needs no domain:

1. Create a Brevo account and verify one sender address (Senders, domains and IPs).
2. SMTP and API, then SMTP: copy the login and create an SMTP key.

Without this, everything else works, but new users never receive their confirmation link. The seeded demo accounts can still sign in.

## 4. Settings and first start

```bash
git clone https://github.com/baishnabisamal/OpsDesk.git
cd OpsDesk
./deploy/init-env.sh opsdesk.203-0-113-10.sslip.io
nano deploy/.env        # SMTP_USER, SMTP_PASSWORD, MAIL_FROM (the verified sender)
./deploy/update.sh
```

The first build takes a few minutes. Then:

```bash
curl -fsS https://opsdesk.203-0-113-10.sslip.io/readyz
```

`deploy/.env` holds every secret. It is git-ignored and readable only by its owner. Keep a copy somewhere safe: the database cannot be opened without `POSTGRES_PASSWORD`.

## 5. Demo data (optional)

For a public portfolio demo, load the seed data and show the demo accounts on the login page:

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml run --rm -e ALLOW_DEMO_SEED=true migrate node dist/scripts/seed.js
sed -i 's/^DEMO_LOGINS=.*/DEMO_LOGINS=true/' deploy/.env
./deploy/update.sh --no-pull
```

The seed password (`Password123!`) is public in this repository. Anyone can then sign in as the demo lead, who can invite staff, which sends email from your Brevo account. Only do this on a server that holds nothing but demo data.

## 6. Updates

```bash
cd ~/OpsDesk && ./deploy/update.sh
```

It pulls, rebuilds, applies new migrations (the `migrate` container runs before the Node services start) and replaces only the containers whose image changed. Users see a few seconds of errors while the API container restarts; a single server cannot avoid that.

## 7. Backups

```bash
crontab -e
# add:
15 3 * * * /home/opsdesk/OpsDesk/deploy/backup.sh >> /home/opsdesk/backup.log 2>&1
```

Dumps go to `~/opsdesk-backups`. A backup on the same disk does not survive losing the server, so copy them elsewhere from time to time (`scp`, or object storage). How to restore is written at the top of `backup.sh`.

## Day-to-day commands

```bash
alias dc='docker compose --env-file deploy/.env -f deploy/docker-compose.yml'
dc ps                    # what runs, and health
dc logs -f api worker    # follow logs
dc restart worker
dc exec postgres psql -U opsdesk_owner opsdesk
```

## What changes between a laptop and the server

| Setting       | Laptop                         | Server                          | Why                                                                                           |
| ------------- | ------------------------------ | ------------------------------- | --------------------------------------------------------------------------------------------- |
| `TRUST_PROXY` | 0                              | 1                               | Behind Caddy, the visitor's address comes from `X-Forwarded-For`; per-IP login limits need it |
| `SMTP_*`      | Mailpit, no login              | Brevo, login, STARTTLS required | A real provider; the password and sign-in links never travel unencrypted                      |
| `APP_URL`     | `http://localhost:5173`        | `https://<site>`                | Links in emails                                                                               |
| Node          | `tsx` (TypeScript at run time) | `node dist/...` (compiled)      | Faster start, no compiler in the image                                                        |
| `/metrics`    | open                           | 404 from Caddy                  | Internal only                                                                                 |

## Not covered

- One server is one point of failure. Two servers would need a load balancer, a shared or managed PostgreSQL, and shared archive storage.
- Prometheus and Grafana are not deployed (local only, `make observe`).
- No inbound email: supplier replies need a provider that posts to `/api/v1/inbound/email` with the HMAC signature.
- Images are built on the server. A larger setup would build them in CI, push them to a registry, and have the server pull.
