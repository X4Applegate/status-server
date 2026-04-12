# Applegate Monitor — Changelog

All notable changes to this project are documented here.

---

## [2.1.0] — 2026-04-11

### Added
- **Home button** in admin panel topbar — links to your status dashboard (configurable via `APP_HOME_URL` env var)
- **GitHub link** in the footer of every page — dashboard, admin, login, privacy, terms, and group legal pages
- **Per-group Privacy Policy and Terms of Service** — admins can paste custom legal text per dashboard group; shown in the group's footer; falls back to global pages when blank
- **Sign In / Sign Out button** on public dashboards — appears in the topbar next to the theme toggle; all protected features (host, IP, Edit button) reveal instantly on login without a page reload
- **Version update notification banner** in admin panel — checks GitHub releases once per hour and shows a dismissible banner when a newer version is available
- **Omada controllers: multi-group support** — controllers can now be assigned to multiple dashboard groups via a checkbox picker; replaces the old single `group_id` column with a many-to-many map table; existing data auto-migrated on boot
- **Self-hosting env vars**: `APP_OWNER`, `APP_CONTACT_EMAIL`, `APP_HOME_URL` — configure owner name, contact email on legal pages, and home button URL without code changes
- **Proprietary license** — source available for reference; modification, commercial use, distribution, and resale prohibited

### Changed
- **"Admin" renamed to "Manage"** everywhere — topbar button, nav pills, admin page title
- **Rebranded to Applegate Monitor** — all page titles, brand marks, and documentation updated
- **Manage pill** on group dashboards now correctly links to `/admin` (management panel) instead of `/` (master dashboard)
- Admin page footer updated from old "Status.Monitor" text to "Applegate Monitor"

### Fixed
- **Response time chart now works for all check types** — HTTP/HTTPS, TCP, and DNS checks were not recording `response_ms`; all now capture wall-clock timing
- **IP addresses hidden from public dashboard** — host/IP redacted on server list cards, detail view, check chip details (including Omada `WAN x.x.x.x`), and incident cause log for logged-out visitors
- **Privacy/terms infinite redirect loop on custom domains** — when a group had no custom legal text, `/privacy` on a custom domain re-entered the middleware and looped; now renders the global page directly
- **Privacy and terms pages bypassed by custom domain middleware** — `/privacy` and `/terms` routes were being intercepted and served as dashboards on custom domains

---

## [2.0.0] — 2026-04-11 (Initial Release)

### Added
- **Omada LTE / Cellular backup WAN check type** (`omada_lte`) — monitors the cellular/LTE backup WAN on Omada-managed gateways. Tries multiple Omada API endpoints to retrieve cellular link status; falls back gracefully to reporting gateway health when the controller API does not expose cellular details. Optional **LTE probe IP** field allows direct ICMP pinging of the cellular WAN address as an additional liveness signal.
- Admin form auto-inherits controller + site from an existing `omada_gateway` check on the same server when switching to `omada_lte`.
- `"Omada LTE"` chip label on the public dashboard detail view.

### Fixed
- Omada gateway uptime showing `NaNm` — the Omada API returns uptime as a string like `"11day(s) 21h 57m 13s"` rather than a numeric value. Added `parseOmadaUptime()` helper to parse this format correctly.
- Omada gateway WAN IP and uptime now appear in the chip detail string (e.g., `ER7206 connected · up 64d 11h · WAN 50.214.51.93`).
- Omada gateway check now pings the gateway's LAN IP after the API check to populate response time history.

---

## [2026-04-10]

### Added
- **Response time history chart** — 24-hour bucketed average/min/max response time chart in the server detail view. Data comes from `response_ms` stored per poll.
- `response_ms` now returned explicitly from `pingCheck()` (previously embedded only in the detail string).
- **SVG badge API** — four embeddable badge endpoints with no third-party dependency:
  - `/api/badge/:id/status` — Up / Down / Degraded
  - `/api/badge/:id/uptime?duration=24h|7d|30d` — uptime percentage
  - `/api/badge/:id/ping` — latest response time
  - `/api/badge/:id/cert-exp` — SSL certificate expiry countdown
- Badge URLs shown in the server edit form with live preview and one-click copy.
- **Edit Server button** on the public dashboard detail view (visible only when logged in).
- Full-width heartbeat bars (flex stretch instead of fixed-width dots).

### Fixed
- Mobile: health check form "+ Add Check" button and check rows no longer overflow off-screen. Fixed with CSS Grid `minmax(0, 1fr)` and `flex-wrap: wrap` / `min-width: 0` on check row inputs.
- TLS session caching prevented `getPeerCertificate()` from returning cert data on repeat polls. Fixed with a dedicated `httpsNoCacheAgent` (`maxCachedSessions: 0, keepAlive: false`).
- Admin drawer save button unreachable when the check list was long. Fixed `.admin-section` layout from `height: 100%` to `flex: 1; min-height: 0`.

---

## [2026-04-09]

### Added
- **Omada Gateway check type** (`omada_gateway`) — live WAN status, link speed, and uptime from TP-Link Omada SDN controllers via Open API v6. Supports on-premise controllers and Omada Cloud MSP accounts with automatic OAuth token refresh.
- Per-site and per-controller configuration in the admin panel (Omada tab).
- Graceful API degradation — if the Omada controller is unreachable the check reports down rather than crashing the poll loop.

---

## [2026-04-08] — Initial Release

### Added
- Multi-tenant status monitoring with per-group branded dashboards at `/dashboard/<slug>`
- Six check types: Ping, TCP, UDP, HTTP/HTTPS, DNS, Omada Gateway
- SSL certificate expiry tracking and warning (< 14 days)
- Role-based access control: Admin and Viewer roles
- Viewer per-group server CRUD permissions (add/edit within assigned groups, no delete)
- Server-Sent Events (SSE) for real-time push updates — no browser polling
- 90-entry heartbeat history bar per server
- Uptime percentages: 24h, 7d, 30d
- Incident log with timestamps and duration
- Webhook alerts (down / recovery) with configurable scope
- Dark / light theme toggle persisted per browser
- Slide-in admin drawer with Servers, Groups, Omada, Users, Webhooks tabs
- Live system log stream with error/info filtering and badge counter
- Deep-link server edit: `/admin?edit=<serverId>`
- Custom domain support per dashboard group (Caddy `Host` header detection)
- Docker + Docker Compose deployment with MariaDB
- Auto-creates database schema and initial admin user on first boot
