# Applegate Monitor

[![CI](https://github.com/X4Applegate/status-server/actions/workflows/ci.yml/badge.svg)](https://github.com/X4Applegate/status-server/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/X4Applegate/status-server?color=2563eb)](https://github.com/X4Applegate/status-server/releases/latest)
[![Docker pulls](https://img.shields.io/docker/pulls/applegater/status-server?color=2563eb)](https://hub.docker.com/r/applegater/status-server)
[![Node.js](https://img.shields.io/badge/Node.js-22.19%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-source--available-7c3aed)](LICENSE)

A self-hosted status monitoring and incident-communication platform for teams that operate multiple branded status pages from one deployment.

Applegate Monitor combines protocol checks, controller and POS integrations, live observability, incident timelines, planned maintenance, alert delivery, and tenant-aware administration in one Node.js and MariaDB application.

[Product page](https://richardapplegate.io/static/case-studies/applegatemonitor.html) · [Live deployment](https://uptime.richardapplegate.io) · [Docker Hub](https://hub.docker.com/r/applegater/status-server) · [Releases](https://github.com/X4Applegate/status-server/releases)

> [!IMPORTANT]
> Applegate Monitor is **source-available, not open source**. Personal and internal non-commercial use is permitted. Modification, redistribution, derivative works, and commercial use require prior written permission. See [LICENSE](LICENSE).

## Contents

- [Quick start](#quick-start)
- [What it provides](#what-it-provides)
- [Supported checks](#supported-checks)
- [Admin and public experiences](#admin-and-public-experiences)
- [Dashboards and access control](#dashboards-and-access-control)
- [Incidents, maintenance, and alerts](#incidents-maintenance-and-alerts)
- [Deployment and operations](#deployment-and-operations)
- [Configuration](#configuration)
- [APIs and feeds](#apis-and-feeds)
- [Backup and restore](#backup-and-restore)
- [Development](#development)
- [Security and license](#security-and-license)

## Quick start

### Requirements

- Docker Engine with the Docker Compose plugin
- A host that can run `linux/amd64` or `linux/arm64` containers
- An HTTPS reverse proxy for an internet-facing deployment

### 1. Get the Compose file

```bash
git clone https://github.com/X4Applegate/status-server.git
cd status-server
cp docker-compose.example.yml docker-compose.yml
```

The example Compose file includes an optional `servers.json` mount for one-time migration from older releases. For a new installation, remove that volume line or create a valid empty file before starting:

```bash
printf '[]\n' > servers.json
```

### 2. Set production secrets

Generate a session secret:

```bash
openssl rand -hex 32
```

Then edit `docker-compose.yml` and change at least:

- `SESSION_SECRET` to the generated value. Keep it stable across upgrades.
- `DB_PASSWORD` and MariaDB's `MYSQL_PASSWORD` to the same strong password.
- `MYSQL_ROOT_PASSWORD` to a separate strong password.
- `EXTERNAL_URL` to the final HTTPS origin, such as `https://status.example.com`.
- `TZ` to the deployment timezone.

Do not leave the example placeholders unchanged. In production, the application rejects its internal fallback session secret and a missing `DB_PASSWORD`, but it cannot recognize every placeholder value in a copied Compose file.

### 3. Start the stack

The supplied Compose file uses the published image; it does not build locally.

```bash
docker compose config
docker compose pull
docker compose up -d
```

Verify the containers and database-backed health endpoint:

```bash
docker compose ps
curl --fail http://localhost:3000/healthz
```

Applegate Monitor listens on port `3000`. The bundled MariaDB service creates the configured database, and the application initializes or upgrades its own schema at startup.

### 4. Create the first administrator

Open `http://localhost:3000/login`, or the HTTPS domain configured in your reverse proxy. When no users exist, the setup screen creates the first administrator. Later visits use the normal sign-in flow.

## What it provides

| Area | Capabilities |
|---|---|
| Monitoring | Multiple checks per service, per-service polling and failure thresholds, latency tracking, certificate expiry, 90-day check history, and 180-cycle heartbeat history |
| Public status | Branded dashboards, custom domains, light/dark themes, service health, incident and maintenance history, announcements, RSS, email subscriptions, and installable per-dashboard PWAs |
| Operations | Enterprise overview, attention queue, permanent on-page management workspaces, live logs, audit history, maps, private runbooks, import/export, and health endpoints |
| Communication | Automated incidents, operator updates, public/private visibility, impact levels, planned maintenance, global or dashboard-scoped alerts, and weekly email reports |
| Integrations | Omada SDN, UniFi Network, Square POS, Google OAuth, Cloudflare Turnstile, SMTP, Mapbox/MapLibre, generic webhooks, and common chat/push destinations |
| Automation | Read/write API keys, external status pushes, visitor-safe JSON feeds, SSE live state, and embeddable SVG badges |

## Supported checks

A service can run several checks during the same poll cycle.

| Check | What it verifies |
|---|---|
| Ping (ICMP) | Reachability and round-trip latency. Requires the container's `NET_RAW` capability. |
| TCP port | TCP connection to a configured port and connection time. |
| UDP port | UDP reachability for services such as WireGuard. |
| HTTP/HTTPS | Expected status, response time, optional required/forbidden body text, and optional TLS certificate inspection. |
| DNS record | A, AAAA, CNAME, MX, TXT, or NS resolution with optional expected-value matching. |
| TLS certificate | Direct certificate-expiry monitoring with a configurable warning threshold. |
| Omada | Gateway/WAN, LTE/cellular, and AP/switch device health through Open API v6. |
| UniFi | Gateway, AP/switch, WAN subsystem, and minimum client-count health. |
| Square POS | Square location or device availability, with delayed outage confirmation to reduce transient alerts. |
| Script | Administrator-only command check; exit code determines health and the command runs inside the monitor container. |

Checks that report latency feed the 24-hour response-time chart. Each service can also define:

- A polling interval from 10 to 3,600 seconds
- A failure threshold from 1 to 10 consecutive failed cycles
- One or more dashboard assignments
- Categories, subcategories, tags, and geographic location
- A private Markdown runbook visible only to authenticated operators

> [!NOTE]
> Omada and UniFi controller URLs are currently validated as outbound internet destinations. Loopback, private, and link-local addresses—and hostnames resolving to them—are rejected. `OMADA_CONTROLLER_HOST_ALLOWLIST` adds a hostname restriction for both controller types; it does not override the private-address block.

## Admin and public experiences

### Operations workspace

The admin console uses a consistent enterprise layout across desktop, tablet, and mobile:

- **Overview** — environment health, KPIs, attention queue, incident activity, maintenance schedule, quick actions, and operator resources
- **Services** — a permanent searchable directory beside selected-service uptime, checks, heartbeat, latency, and incident detail
- **Incidents** — a searchable/filterable incident list beside impact, visibility, updates, and timeline controls
- **Maintenance** — active, upcoming, and past windows beside the selected service-specific schedule
- **Communication** — searchable status-page, announcement, and alert-channel directories with selected-record details
- **Platform** — on-page Omada, UniFi, Square, users and access, API keys, activity and audit, and settings workspaces

Every Monitoring, Communication, and Platform destination stays in the main admin page. On smaller screens, its directory stacks above the selected record. Focused create/edit tasks continue to use accessible drawers so operators keep their place.

### Public status pages

Each dashboard is available at `/dashboard/<slug>` and can have its own:

- Name, subtitle, logo, accent, background, and default theme
- Custom domain, privacy text, and terms text
- Service inventory and category structure
- Public incident and maintenance history
- Scheduled or global announcements
- RSS feed and email down/recovery subscriptions

Status pages are intentionally visitor-facing. Authenticated viewer grants control which dashboard data a user can manage; they are not a privacy boundary for the public `/dashboard/<slug>` route.

Each dashboard includes an installable web-app manifest. The PWA is deliberately network-only and does not cache live status data for offline use.

## Dashboards and access control

A service can appear on multiple dashboards. Create dashboards first, assign services, and then grant viewer accounts access to the dashboards they operate.

| Capability | Administrator | Viewer |
|---|---|---|
| Browse management data | All dashboards and services | Assigned dashboards and their services |
| Add or edit services | Yes | Yes, within assigned dashboards |
| Delete services | Yes | No |
| Dashboard settings | Create, edit, delete, and assign services | Edit assigned dashboard branding/settings; cannot change service assignments |
| Incidents | Edit, publish updates, resolve, and delete incidents opened automatically by failed checks | Read public incidents for assigned dashboards |
| Maintenance | Manage all service windows | Manage windows for accessible services |
| Alert channels | Global or dashboard-scoped | Assigned-dashboard scope only |
| Omada, UniFi, and Square | Manage all resources | Manage resources scoped to assigned dashboards, without access to global or unrelated mappings |
| Users, API keys, settings, banners, audit, and system logs | Yes | No |
| Script checks, import/export, and history cleanup | Yes | No |

## Incidents, maintenance, and alerts

### Incidents

Probe transitions automatically open and resolve incidents. Administrators can refine customer communication by setting:

- A custom title and minor, major, or critical impact
- Public or private visibility
- Investigating, identified, monitoring, and resolved updates
- Customer-facing timeline messages

Anonymous and viewer-facing feeds omit private incidents and internal infrastructure details.

### Planned maintenance

Maintenance can cover one or several services. The application stores one service-specific window per affected service, groups matching windows on public pages, and suppresses outbound status-change alerts while a service is actively in maintenance. Live checks and history continue to run.

### Alert delivery

Alert channels can be global for administrators or scoped to one dashboard. Selectable payload formats include Generic JSON, Discord, Slack, and email. Automatic URL detection also supports Microsoft Teams, Telegram, Pushover, and ntfy.

Public email subscriptions and weekly reports require SMTP. SMTP, Google OAuth, Cloudflare Turnstile, Mapbox, and weekly-report settings can be managed from the admin Settings page.

## Deployment and operations

### Container behavior

- Published image: `applegater/status-server`
- Platforms: `linux/amd64` and `linux/arm64`
- Application port: `3000`
- Runtime user: non-root `node`
- Docker healthcheck: `/healthz` every 30 seconds
- Primary persistent storage: the MariaDB volume
- ICMP requirement: `cap_add: [NET_RAW]`

For predictable production upgrades, replace `latest` in the Compose file with an explicit release tag from [GitHub Releases](https://github.com/X4Applegate/status-server/releases). Pin an image digest when immutable deployment inputs are required.

### Upgrade

Back up first, then pull and recreate only the application service:

```bash
./backup.sh
docker compose pull status-server
docker compose up -d status-server
curl --fail http://localhost:3000/health
```

Schema additions run automatically during startup. Preserve both the MariaDB volume and `SESSION_SECRET`. Changing the session secret signs users out and invalidates existing API keys because it is also used as the API-key hash pepper.

### Health endpoints

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | Lightweight liveness plus MariaDB connectivity; used by the Docker healthcheck. |
| `GET /health` | Version, process uptime, database state, last poll age, and configured service count. |
| `GET /health?strict=1` | The richer health check, also requiring at least one configured service. |

### Reverse proxy

Caddy is a simple HTTPS front end. For Caddy installed directly on the Docker host:

```caddy
status.example.com {
    reverse_proxy localhost:3000
}
```

Set `EXTERNAL_URL=https://status.example.com` so alerts, subscriptions, reports, and OAuth callbacks use absolute HTTPS links.

For a custom dashboard domain, configure the domain on the dashboard and route that hostname to the same application:

```caddy
status.acme.example {
    reverse_proxy localhost:3000
}
```

If Caddy runs in a container on the same Docker network, use `status-server:3000` instead. The example Compose file does not create that shared proxy network. The application selects the dashboard from the `Host` header; DNS and TLS certificates remain the reverse proxy's responsibility.

## Configuration

### Core environment variables

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | HTTP listen port. |
| `DB_HOST` | `mariadb` | MariaDB/MySQL hostname. |
| `DB_PORT` | `3306` | Database port. |
| `DB_USER` | `root` | Application database user. The example uses `statusadmin`. |
| `DB_PASSWORD` | empty | Required when `NODE_ENV=production`. Must match the configured MariaDB user password. |
| `DB_NAME` | `status_monitor` | Existing database the application initializes and upgrades. |
| `SESSION_SECRET` | insecure built-in value | Required in production. Use at least 32 characters; 48+ random characters are recommended. Keep it unchanged. |
| `EXTERNAL_URL` | empty | Canonical public origin used for alert, subscription, report, and OAuth links. Strongly recommended. |
| `TZ` | `UTC` in most container environments | Container timezone, such as `America/Los_Angeles`. Browser-facing dates use the visitor's locale. |
| `LOG_LEVEL` | `info` | Pino log level, such as `debug`, `info`, `warn`, or `error`. |

### Optional and compatibility variables

| Variable | Default | Notes |
|---|---|---|
| `SMTP_HOST` | empty | Startup fallback for SMTP; saved Settings values take precedence. |
| `SMTP_PORT` | `587` | SMTP port. |
| `SMTP_USER` | empty | SMTP username. |
| `SMTP_PASS` | empty | SMTP password or app password. |
| `SMTP_FROM` | `SMTP_USER` | Sender address. |
| `SMTP_SECURE` | `false` | Set `true` for implicit TLS, commonly on port 465. |
| `GOOGLE_CALLBACK_URL` | `${EXTERNAL_URL}/auth/google/callback` | Override for Google OAuth callback registration. |
| `OMADA_CONTROLLER_HOST_ALLOWLIST` | empty | Comma-separated additional hostname allowlist applied to Omada and UniFi controller requests. |
| `APP_OWNER` | `Richard Applegate` | Owner shown on generated legal pages. |
| `APP_CONTACT_EMAIL` | `admin@richardapplegate.io` | Contact shown on generated legal pages. |
| `APP_HOME_URL` | `/` | Destination of the admin Home action. |
| `CONFIG_PATH` | `/config/servers.json` | One-time legacy JSON import source when the database has no services. |
| `CHECK_INTERVAL` | `30000` | Legacy compatibility/startup-log value. Current scheduling is controlled by each service's polling interval. |

Docker sets `NODE_ENV=production`. Turnstile keys, Google OAuth client credentials, Mapbox token, SMTP settings, and weekly-report settings are normally managed from the web UI and stored in MariaDB.

## APIs and feeds

### Automation API

Administrators create instance-wide read or write keys under **API keys**. Authenticate with either header:

```text
Authorization: Bearer ssk_...
X-API-Key: ssk_...
```

| Method and endpoint | Required scope | Description |
|---|---|---|
| `GET /api/v1/status` | Read | Current state of all services. |
| `GET /api/v1/status/:id` | Read | Current state of one service. |
| `POST /api/v1/servers/:id/push-status` | Write | Push `up`, `down`, or `degraded` state for an existing service. |

Example:

```bash
curl --fail \
  --header "Authorization: Bearer $STATUS_API_KEY" \
  https://status.example.com/api/v1/status

curl --fail --request POST \
  --header "Authorization: Bearer $STATUS_API_KEY" \
  --header "Content-Type: application/json" \
  --data '{"status":"degraded","detail":"Deployment verification in progress"}' \
  https://status.example.com/api/v1/servers/web/push-status
```

API keys are instance-wide, not tenant-scoped. A later scheduled poll can replace externally pushed state on a normally polled service.

### Public status feeds

```text
/dashboard/<slug>/incidents                       Public incident and maintenance history
/dashboard/<slug>/feed.rss                        RSS 2.0 incident and maintenance feed
/api/public/group/<slug>/incidents                Public incident history and updates
/api/public/group/<slug>/maintenance              Active/upcoming maintenance (next 90 days)
/api/public/group/<slug>/maintenance?include=recent  Also include the last 30 days of completed maintenance
```

### SVG badges

Badge endpoints return `image/svg+xml`. A service must belong to at least one dashboard to be anonymously accessible; ungrouped services require an authenticated administrator session.

| Endpoint | Useful parameters |
|---|---|
| `/api/badge/:id/status` | `upLabel`, `downLabel`, `upValue`, `downValue` |
| `/api/badge/:id/uptime` | `duration=24h\|7d\|30d`, `label` |
| `/api/badge/:id/ping` | `label` |
| `/api/badge/:id/cert-exp` | `label`, `warnDays`, `downDays` |

Every badge also accepts `style=flat`, `flat-square`, `plastic`, or `for-the-badge`.

```markdown
![Status](https://status.example.com/api/badge/web/status?style=flat-square)
![Uptime](https://status.example.com/api/badge/web/uptime?duration=30d)
```

The certificate badge currently reads certificate data from an HTTPS check on the service.

## Backup and restore

Service JSON export is useful for moving definitions, but it is **not** a complete backup. MariaDB contains dashboards, users, history, incidents, maintenance, settings, credentials, sessions, and API-key hashes.

### Create a database backup

The bundled script defaults to container `mariadb`, database `status_monitor`, user `statusadmin`, and seven days of local retention:

```bash
printf 'DB_PASS=replace-with-the-database-password\n' > .backup.env
chmod 600 .backup.env
./backup.sh
```

Backups are written as gzip-compressed SQL files under `backups/`. Copy them off-host and protect them as secrets; they can contain controller credentials, OAuth/SMTP/Turnstile settings, Square tokens, sessions, and API-key hashes.

Override `DB_CONTAINER`, `DB_NAME`, `DB_USER`, `BACKUP_DIR`, or `KEEP_DAYS` through the environment or `.backup.env` when needed.

### Restore a backup

Restore drops and recreates the configured database. Stop the application first and use a database account with sufficient `DROP DATABASE` and `CREATE DATABASE` privileges:

```bash
docker compose stop status-server
./restore.sh backups/status_monitor_YYYYMMDD_HHMMSS.sql.gz
docker compose up -d status-server
```

The restore script requires typing `yes` before the destructive database operation.

## Development

The application is server-rendered EJS with vanilla CSS and JavaScript; there is no frontend build step.

Requirements for direct development:

- Node.js `>=22.19.0`
- MariaDB or MySQL
- `iputils`/`ping` when testing ICMP checks

Install and run the quality suite:

```bash
cd backend
npm ci
npm test
npm audit --audit-level=high
node --check server.js
```

Set the database and session environment variables, then start with:

```bash
npm start
```

CI tests the declared Node 22 minimum and the Node 26 Docker runtime, compiles every EJS template, runs the security audit and unit suite, and builds the production image.

Key files:

```text
backend/server.js                      Routes, auth, polling, integrations, SSE, and database logic
backend/public-status.js               Maintenance grouping and RSS helpers
backend/public-status-serializer.js    Visitor-safe public payload allowlist
backend/views/                         Server-rendered UI
backend/public/                        Shared theme assets
backend/test/                          Node test suite
docker-compose.example.yml             Reference deployment
backup.sh / restore.sh                 MariaDB operations
```

See [CHANGELOG.md](CHANGELOG.md) for release history. Before proposing code changes, review [LICENSE](LICENSE) and contact the author for permission; contribution expectations are documented in [CONTRIBUTING.md](CONTRIBUTING.md).

## Security and license

Security controls include bcrypt password hashing, database-backed sessions, secure cookie settings behind HTTPS, endpoint-specific rate limits, security headers, parameterized SQL, per-dashboard grants, audit logs, anonymous response allowlists, dependency scanning, and a non-root container runtime.

Report vulnerabilities privately according to [SECURITY.md](SECURITY.md). Do not open a public issue for a suspected vulnerability.

This repository uses a proprietary source-available license. See [LICENSE](LICENSE) for the complete terms and contact the author before modification, redistribution, derivative work, or commercial use.

## AI assistance

Applegate Monitor is designed, directed, and maintained by **Richard Applegate**. AI coding assistants, including Anthropic Claude and OpenAI Codex, are used to support implementation, testing, review, documentation, and security hardening. Product decisions and release authority remain with the author.
