# Applegate Monitor — Changelog

All notable changes to this project are documented here.

---

## [2.4.0] — 2026-04-12

### Added
- **Mini heartbeat bars on server cards** — last 20 checks shown as colored dots under each card; persists across container restarts by seeding from database
- **Welcome popup on fresh install** — admin is redirected to `/admin?welcome=1` with a guided onboarding popup to add their first server
- **Omada gateway WAN IP display** — gateway detail shows the public/WAN IP alongside model and uptime

### Changed
- **Heartbeat bar reduced to 180 checks** — fits on mobile screens without wrapping (~90 minutes at 30s intervals)
- **Omada gateway ping uses LAN IP** — WAN IPs often block ICMP; LAN IP is reachable over VPN/local network for accurate response time

### Fixed
- **Heartbeat not rendering on detail view** — added `requestAnimationFrame` delay so the DOM is painted before chart/heartbeat renders
- **Mini heartbeat bars reset on container restart** — now seeded from `status_history` table on startup
- **Omada false down alerts** — reverted WAN IP ping that caused false "unreachable" alerts when routers block ICMP
- **Removed TLS cert paths** from Caddy setup example in group form

---

## [2.3.0] — 2026-04-12

### Added
- **Full-screen server grid layout** — server list now displays as a responsive card grid instead of a narrow sidebar; cards show status dot, name, host, badge, and a mini heartbeat bar
- **Mini heartbeat bar on each card** — last 20 checks shown as colored dots under every server card (green = up, red = down, gray = pending); updates in real-time
- **Detail view with back button** — clicking a server opens a full-width detail view; "← All Servers" button returns to the grid
- **Welcome popup on admin page** — fresh installs redirect admin to `/admin?welcome=1` with a popup and auto-opened management drawer
- **Caddy example cleaned up** — removed TLS cert paths from the custom domain setup instructions

### Changed
- **Layout redesign** — replaced sidebar + main split with full-screen grid → detail toggle; mobile-friendly single-column on small screens
- **Server cards are clickable panels** — rounded corners, hover elevation, status badge, and heartbeat mini-bar

---

## [2.2.0] — 2026-04-12

### Added
- **Viewers can edit their own dashboards** — viewers assigned to a group can now modify its appearance (name, logo, colors, theme, custom domain, legal text) without admin access; server assignments remain admin-only
- **Rich Slack webhook notifications** — Block Kit layout with structured fields (Service, Status, Target, Time), alert details in code blocks, dashboard link, and footer showing webhook name
- **Rich Discord webhook notifications** — embed with inline fields, alert details code block, clickable dashboard link, and footer
- **Dashboard links in webhook alerts** — uses the group's custom domain when set (e.g. `https://status.myanthemcoffee.com`), falls back to `EXTERNAL_URL/dashboard/{slug}`
- **Custom domain links on topbar pills** — dashboard nav buttons now link to the custom domain when configured instead of the local `/dashboard/{slug}` path
- **Custom heartbeat tooltip** — hovering over heartbeat dots shows a large styled popup with full date/time in 12-hour AM/PM format and status
- **`EXTERNAL_URL` env var** — fallback base URL for webhook dashboard links when no custom domain is set
- **`TZ` env var** — container timezone support for correct timestamp display

### Changed
- **Heartbeat bar expanded to 360 checks** — covers ~3 hours of history (up from 90); dots use `flex:1` to fill the full width on any screen without wrapping
- **Brighter dark mode text** — `--text`, `--text-2`, and `--text-hi` CSS variables brightened for better readability on all labels, section headers, and legends
- **Brighter response time chart** — Y-axis labels, grid lines, and chart line all more visible
- **Omada devices poll every 10 seconds** — faster detection of router reboots and outages (down from 30s); minimum poll interval lowered to 5s
- **Incident dots always red** — resolved incidents show dimmed red instead of green to avoid confusion
- **Heartbeat start time hidden** — left-side timestamp only appears once the bar has a full 360 checks of data

### Fixed
- **Heartbeat bar only half full** — servers with multiple check types (ping + tcp + http) were inserting multiple rows per poll; heartbeat query now groups by `checked_at` so each poll = one dot
- **Duplicate "Manage" button** — legacy `topbarManageBtn` div removed; only the dashboard pills Manage button remains
- **Webhook test showed fake DOWN alert** — test webhooks now show `🧪 Test Alert` with blue color and "no actual issue detected" instead of misleading `🔴 is DOWN`
- **Database timezone mismatch** — added `timezone: "local"` to MySQL connection pool so timestamps match the container's `TZ` setting
- **Groups tab hidden from viewers** — viewers can now access the Groups tab (Users tab remains admin-only); Add/Remove buttons hidden for viewers

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
