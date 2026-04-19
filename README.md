# Applegate Monitor

[![CI](https://github.com/X4Applegate/status-server/actions/workflows/ci.yml/badge.svg)](https://github.com/X4Applegate/status-server/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/X4Applegate/status-server?color=39d98a)](https://github.com/X4Applegate/status-server/releases)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-green)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-source--available-blue)](./LICENSE)

> ## 🚧 Active Development Notice — HA / Automatic Failover Work In Progress
>
> **Expect frequent updates over the next several releases.** Active work is underway on the high-availability backup solution. The goal: if the **primary** goes down (power loss, internet loss, hardware failure), a **Cloudflare-triggered script** automatically promotes the **secondary** — which is normally running a **read-only replica database** — to active status and begins serving traffic with zero manual intervention.
>
> **Current state** (as of the most recent release):
> - ✅ Manual failover works end-to-end (`scripts/promote-replica.sh`)
> - ✅ MariaDB classic replication tuned and tested (primary → read-only replica)
> - ✅ Cloudflare Tunnel multi-connector topology (cold-standby connector on secondary)
> - 🚧 **In progress:** automatic promotion trigger driven by Cloudflare health signals
> - 🚧 **In progress:** automated failback (old primary rejoins as read-only replica when it recovers)
>
> Until the automatic trigger ships, follow the manual runbook in [`docs/HIGH_AVAILABILITY.md`](./docs/HIGH_AVAILABILITY.md). Breaking changes to compose files, env vars, or the promote script may occur — pin to a specific release tag if stability matters for your deployment.

A self-hosted, multi-tenant server and network status monitoring platform built with Node.js, Express, and MariaDB. Designed for operators who need separate branded dashboards for different teams or clients — each with their own login, branding, and server visibility — from a single deployment.

🌐 **Live demo:** [uptime.richardapplegate.io](https://uptime.richardapplegate.io) · 📄 **Landing page:** [applegatemonitor.richardapplegate.io](https://applegatemonitor.richardapplegate.io)

---

## Features

### Multi-Tenant Dashboards
- Each user or team gets their own **branded status page** at `/dashboard/<slug>`
- Per-dashboard **logo, accent color, background color, logo size**, and subtitle
- Viewers can only see servers assigned to their dashboard — other dashboards and their servers are completely invisible
- Admins see a master view of all servers across all groups

### Health Checks
Every server can run one or more checks simultaneously:

| Check Type | Description |
|---|---|
| **Ping (ICMP)** | ICMP echo with round-trip latency |
| **TCP Port** | Raw TCP connection to any port with connection-time measurement |
| **UDP Port** | UDP probe (e.g. WireGuard on 51820) |
| **HTTP / HTTPS** | Full HTTP request with status code validation, SSL certificate tracking, and response time |
| **DNS Record** | Resolves A, AAAA, CNAME, MX, TXT, or NS records with optional expected-value assertion and query time |
| **Omada Gateway** | Live WAN status, link speed, uptime, and WAN IP from TP-Link Omada SDN controllers via Open API v6 |
| **Omada LTE** | Cellular/LTE backup WAN monitoring on Omada-managed gateways; optional direct probe IP ping |

All check types record **response time** per poll. The server detail view shows a 24-hour response time chart (avg / min / max per hour).

### SSL Certificate Tracking
- Automatic TLS certificate expiry detection on any HTTPS check
- Expiry shown on server detail view with days remaining
- Cert data available in the badge API
- Forces a fresh TLS handshake every poll (no session caching) to guarantee cert data is always current

### Status Badge API
Embeddable SVG badges for README files, documentation, or internal dashboards — no third-party service required.

```
/api/badge/:serverId/status              Up / Down / Degraded
/api/badge/:serverId/uptime?duration=24h Uptime % (24h, 7d, 30d)
/api/badge/:serverId/ping               Latest response time
/api/badge/:serverId/cert-exp           SSL certificate expiry
```

Badge URLs are shown directly in the server edit form for easy copying.

**Example:**

```markdown
![Status](https://status.example.com/api/badge/my-server-123/status)
![Uptime](https://status.example.com/api/badge/my-server-123/uptime?duration=30d)
```

### Role-Based Access Control

| Capability | Admin | Viewer |
|---|---|---|
| View all servers (master dashboard) | Yes | No — own groups only |
| Add / edit servers | Yes | Yes — own groups only |
| Delete servers | Yes | No |
| Manage dashboards (groups) | Yes | No |
| Manage users | Yes | No |
| Configure Omada controllers | Yes | No |
| Configure webhooks | Yes | Yes — own groups only |
| View system logs | Yes | No |

### Webhook Alerts
- Fire on status change: **down**, **recovery**, or both
- Configurable per-group or per-server scope
- Payload includes server name, status, host, timestamp, and check details
- Built-in **test webhook** button in the admin panel

### Omada SDN Integration
- Connect one or more **TP-Link Omada Software Controllers** (Open API v6)
- **Omada Gateway** check: live WAN status, link speed, uptime, and WAN IP per site
- **Omada LTE** check: cellular/LTE backup WAN monitoring with graceful fallback when the controller API does not expose cellular details; optional direct probe IP for ICMP pinging the cellular WAN address
- Supports both on-premise controllers and Omada Cloud (MSP accounts)
- Automatic OAuth token refresh

### Real-Time Updates
- Server-Sent Events (SSE) push live status changes to all connected clients
- No polling from the browser — dashboard updates the moment a check changes
- Heartbeat history bar shows the last 90 check results visually

### Uptime History
- 24-hour, 7-day, and 30-day uptime percentages per server
- Response time chart (last 24h bucketed by hour)
- Incident log with timestamp and duration

### Login Protection (Cloudflare Turnstile)
- Optional **Cloudflare Turnstile** CAPTCHA on the login form — blocks bots and brute-force attacks without user friction
- Privacy-friendly alternative to reCAPTCHA — no distorted text puzzles
- Configured from the **Settings tab** in the admin panel (no env vars or redeploy needed)
- Widget only loads when enabled; automatically skipped during first-time admin setup
- Failed verification attempts are logged with the username and reason

### Admin Panel
- Slide-in drawer with tabbed management: Servers, Groups, Omada, Users, Webhooks, Settings
- **Settings tab** — configure SMTP email and Cloudflare Turnstile login protection from the web UI
- Live system log stream with error/info filtering and badge counter
- Per-server edit form accessible directly from the status dashboard via the **Edit Server** button
- Deep-link edit: navigate to `/admin?edit=<serverId>` to open a server's edit form directly

### Appearance
- Dark and light theme toggle (persisted per browser)
- Fully responsive — tested on mobile (iOS / Android) and desktop
- Full-width heartbeat bars that stretch to fill the container
- Clean sidebar with active-row accent, no visual clutter

---

## Stack

- **Runtime:** Node.js 18+
- **Framework:** Express 4
- **Templates:** EJS
- **Database:** MariaDB (or MySQL)
- **Deployment:** Docker + Docker Compose
- **Reverse proxy:** Caddy (recommended) or any HTTPS proxy
- **No build step** — plain HTML/CSS/JS embedded in EJS templates

---

## Quick Start

### 1. Clone

```bash
git clone https://github.com/X4Applegate/status-server.git
cd status-server
```

### 2. Configure

```bash
cp docker-compose.example.yml docker-compose.yml
```

Edit `docker-compose.yml` and set:

| Variable | Description |
|---|---|
| `DB_HOST` | MariaDB hostname or container name |
| `DB_USER` | Database username |
| `DB_PASSWORD` | Database password |
| `DB_NAME` | Database name (created automatically on first run) |
| `SESSION_SECRET` | Random string for session signing — change this |

### 3. Deploy

```bash
docker compose up -d --build
```

The server starts on port `3000`. On first boot it creates all database tables automatically.

### 4. Create your admin account

Navigate to `http://localhost:3000/login` (or your domain). On first visit you'll be prompted to create your admin account — choose a username and password. After that, the login page switches to a normal sign-in form.

---

## Directory Structure

```
status-server/
├── backend/
│   ├── server.js           Main application — routes, polling, SSE, DB logic
│   ├── package.json
│   ├── Dockerfile
│   └── views/
│       ├── index.ejs       Status dashboard (master view + per-group dashboards)
│       ├── admin.ejs       Admin management panel
│       ├── login.ejs       Login page
│       ├── 404.ejs         Not found page
│       └── partials/
│           ├── head.ejs
│           └── topbar-public.ejs
├── docker-compose.example.yml
├── docker-compose.yml      (not committed — contains your secrets)
└── .gitignore
```

---

## Multi-Tenant Setup

### 1. Create a Dashboard (Group)

In the Admin panel → **Groups** tab → **Add Group**:
- Set a **slug** (URL-safe name, e.g. `acme-corp`)
- Set accent color, background color, logo, and branding
- This creates the public dashboard at `/dashboard/acme-corp`

### 2. Assign Servers

When adding or editing a server, pick one or more dashboards from the **Dashboards** picker. A server can appear on multiple dashboards.

### 3. Create a Viewer User

Admin panel → **Users** tab → **Add User**:
- Role: **Viewer**
- Assign them to one or more dashboard groups
- When they log in, they land directly on their dashboard

Viewers only see their assigned servers. They can add and edit servers within their groups but cannot delete servers, manage users, or view other groups.

---

## Badge API Reference

All badge endpoints return `image/svg+xml`. Servers must be assigned to a dashboard to be publicly accessible (ungrouped servers require authentication).

### Status Badge

```
GET /api/badge/:id/status
```

| Parameter | Default | Description |
|---|---|---|
| `upLabel` | `status` | Label text when up |
| `downLabel` | `status` | Label text when down |
| `upValue` | `up` | Value text when up |
| `downValue` | server status | Value text when down |

### Uptime Badge

```
GET /api/badge/:id/uptime?duration=24h
```

| Parameter | Default | Description |
|---|---|---|
| `duration` | `24h` | Time window: `24h`, `7d`, `30d` |
| `label` | `uptime 24h` | Left-side label text |

Color thresholds: green ≥ 99%, yellow ≥ 95%, red < 95%.

### Response Time Badge

```
GET /api/badge/:id/ping
```

Color thresholds: green < 150ms, yellow < 400ms, red ≥ 400ms.

### SSL Certificate Expiry Badge

```
GET /api/badge/:id/cert-exp
```

| Parameter | Default | Description |
|---|---|---|
| `warnDays` | `14` | Days remaining before yellow warning |
| `downDays` | `7` | Days remaining before red alert |

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP port to listen on |
| `DB_HOST` | Yes | — | MariaDB host |
| `DB_PORT` | No | `3306` | MariaDB port |
| `DB_USER` | Yes | — | Database username |
| `DB_PASSWORD` | Yes | — | Database password |
| `DB_NAME` | Yes | — | Database name |
| `SESSION_SECRET` | Yes | — | Secret for session signing |
| `EXTERNAL_URL` | No | — | Fallback base URL for webhook dashboard links |
| `TZ` | No | `UTC` | Container timezone (e.g. `America/Los_Angeles`) |
| `CHECK_INTERVAL` | No | `30000` | Global poll interval in ms |
| `APP_OWNER` | No | `Richard Applegate` | Owner name shown on Privacy Policy and Terms pages |
| `APP_CONTACT_EMAIL` | No | `admin@richardapplegate.io` | Contact email shown on legal pages |
| `APP_HOME_URL` | No | `/` | URL the Home button in the admin panel links to |

---

## Reverse Proxy (Caddy)

```caddy
status.example.com {
    reverse_proxy status-server:3000
}
```

For custom domains per dashboard, set the **Custom Domain** field on a group and add a corresponding Caddyfile block:

```caddy
status.acmecorp.com {
    reverse_proxy status-server:3000
}
```

The server detects the `Host` header and serves the correct branded dashboard automatically.

---

## License

Proprietary — see [LICENSE](LICENSE). Source is available for personal and non-commercial reference use only. Modification, commercial use, distribution, and resale are prohibited without prior written permission from the author.

---

## AI Assistance

This project was designed, built, and is maintained by **Richard Applegate**. [Claude](https://claude.ai) by Anthropic is used as a coding assistant to help with bug fixes, feature improvements, security hardening, and code modifications. Claude did not create this project — all product decisions, architecture, and direction are made by the author.
