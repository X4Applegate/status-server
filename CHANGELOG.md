# Applegate Monitor — Changelog

All notable changes to this project are documented here.

> **AI Assistance:** This project was designed, built, and is maintained by **Richard Applegate**. [Claude](https://claude.ai) by Anthropic is used as a coding assistant to help with bug fixes, updates, security improvements, and code modifications. Claude did not create this project — all product decisions, architecture, and direction are made by the author.

---

## [3.4.8] — 2026-04-29 *(PageSpeed: lazy MapLibre + SEO meta)*

### Performance
- **MapLibre CSS lazy-loaded.** Was render-blocking on every dashboard load via `<link href="https://unpkg.com/maplibre-gl@4/.../maplibre-gl.css">` in `<head>` even though the MapLibre JS bundle has been lazy-loaded since the project began. The CSS now loads inside `_loadMapLibre()` only when a viewer actually opens the map view — saves a render-blocking 3rd-party stylesheet request and a TLS handshake to unpkg.com on first paint for every visitor who never clicks the map (which is most of them). Idempotent — only injects once even across multiple map opens.
- **Google Fonts preconnect fixed.** `head.ejs` had a single preconnect to `fonts.googleapis.com` (the CSS host). The actual font files come from `fonts.gstatic.com`, and that origin needs `crossorigin` on its preconnect for the browser to reuse the connection (font requests are CORS). Without it, the preconnect is silently wasted. Standard PageSpeed-recommended pattern now in place.

### SEO (was 82, target 95+)
- **Meta description** — biggest single SEO miss. Default in `head.ejs` now provides a sensible blurb; per-page renders override it with the group's own subtitle / description. Each branded dashboard ranks for its own brand instead of all sharing a generic title.
- **`<meta name="robots" content="index,follow">`** — explicit, beats relying on defaults.
- **404 page** carries its own description so the SEO audit doesn't ding error pages.

### Files
- **`backend/views/partials/head.ejs`** — accepts a new `description` local; outputs `<meta name="description">`, `<meta name="robots">`, and the second `gstatic.com` preconnect with `crossorigin`.
- **`backend/views/index.ejs`** — removed the render-blocking MapLibre stylesheet `<link>` from `<head>`; `_loadMapLibre()` now injects both the JS and the CSS on demand. Updated the `head` partial include to pass the group's `groupSubtitle` (or a fallback derived from `groupName`) as the description.
- **`backend/views/404.ejs`** — passes its own description.

### Expected impact
- **FCP / LCP**: drop by 100–400ms on cold loads since the dashboard no longer waits on a 3rd-party stylesheet from unpkg.com before painting. The font preconnect fix saves another 80–150ms on first-load font requests.
- **Performance score**: typically +3 to +6 from removing the render-blocking 3rd-party CSS alone.
- **SEO score**: typically +8 to +12 from adding a meta description (the biggest single audit hit).

No behavioral or visual changes — the map looks and feels identical when opened, just with a one-time CSS fetch that didn't exist before.

---

## [3.4.7] — 2026-04-29 *(Applegate brand applied app-wide)*

### Followup to 3.4.6
v3.4.6 reskinned the admin chrome but the dashboard side, the auxiliary public pages (login / privacy / terms / 404 / incidents / group-legal), and the various server-side hardcoded fallbacks all still emitted navy-blue-on-dark-blue. Selecting the "Applegate" preset on a group still showed a lot of leftover navy because the per-group preset only overrode a handful of CSS variables, not the chrome.

### Now consistent
Every template's `:root` palette and every hardcoded `rgba()` / hex value across the eight view files now match the Applegate brand:
- **Background**: `#0a0a0a` (was `#060c18` / `#0b0e14`)
- **Surfaces**: `#141414` / `#1a1a1a` / `#202020`
- **Primary accent (`--blue` / `--accent`)**: `#ff8c2a` (was `#2a7fff` or `#6366f1` indigo)
- **Status colors**: `#39d98a` / `#ef4444` / `#f59e0b` (modern set, matches the website)
- **Text**: warm neutral grays `#a0a0a0` / `#6f6f6f` / `#d4d4d4` / `#f5f5f5` (was cool blue-grays)
- **Borders**: neutral `rgba(255,255,255,0.06–0.10)` (was blue-tinted)
- **Primary buttons**: black-on-orange (was white-on-blue / white-on-indigo) — matches the website's `.btn-primary` exactly

### Files touched
- **`backend/server.js`** — `accent_color || "#2a7fff"` fallbacks (5 sites including `DEFAULT_BRANDING`, `groupBranding()` helper, INSERT/UPDATE defaults, and the manifest endpoint) → `"#ff8c2a"`.
- **`backend/views/index.ejs`** — `:root` palette + sweep of `rgba(42,127,255,…)` / `rgba(30,100,200,…)` / `rgba(16,232,138,…)` / `rgba(255,61,90,…)` and hex values `#10e88a` / `#ff3d5a` / `#0d1829` / `#1e2d45` / `#e8eaf0`. SSE map markers' `colorMap` updated to match too.
- **`backend/views/admin.ejs`** — All form picker default values (`gColor`, `gBgColor`, `gUpColor`, `gDownColor`, `gAccentColorLight`) and `showGroupForm` / `applyThemePreset` fallbacks. The "Default" theme preset chip now applies the Applegate baseline. The admin's own SSE map color-map updated to use the website palette.
- **`backend/views/login.ejs`** / **`privacy.ejs`** / **`terms.ejs`** / **`group-legal.ejs`** / **`incidents.ejs`** / **`404.ejs`** — `:root` palettes converted from indigo (`#6366f1`) / navy (`#2a7fff`) to brand orange. Login button is now black-on-orange.

### Group-side behavior
- **Existing groups** with stored values keep them — only groups with `accent_color = NULL` (which is unusual since INSERTs always default-fill) would shift. No DB migration.
- **New groups** default to the brand orange (`#ff8c2a`) on near-black (`#0a0a0a`) instead of blue.
- **The "Default" preset chip** now applies the brand baseline so clicking it = "reset this dashboard to the Applegate look." If you want the original navy-blue look back on a specific dashboard, just paste those hex values into the per-group color pickers manually.

---

## [3.4.6] — 2026-04-29 *(admin panel reskinned to Applegate brand)*

### New
- **Admin panel chrome** (the management UI behind `/admin`) is now permanently themed in the Applegate brand orange-on-near-black to match richardapplegate.io. Affects every admin screen — group list, server form, user form, webhook config, theme editor, log viewer, audit log, response-time chart, and map popups.
- **Per-group dashboard themes are unchanged.** This change is purely the admin chrome — the dashboard side still respects each group's own theme settings (Default / Applegate / Midnight / etc.). The "Default" dashboard preset is still the original navy-blue look.

### How it was done
Reworked **`backend/views/admin.ejs`** `:root` palette only — the existing `--blue` / `--orange` / `--green` / `--red` / `--warn` token names are kept (so the rest of the CSS doesn't have to change), but the values now hold the Applegate palette: `#ff8c2a` accent, `#0a0a0a` background, `#39d98a` / `#ef4444` / `#f59e0b` for status. Hardcoded blue rgba values (`rgba(42,127,255,…)`, `rgba(30,100,200,…)`) and three navy hexes (`#0d1829`, `#1e2d45`, `#e8eaf0`) found in the response-time chart canvas, the maplibre popup styling, and the log-entry highlighting were also swept through.

Also fixed contrast on the primary button: white-on-orange (`#fff` on `#ff8c2a`) had poor contrast — switched to `#0a0a0a` to match the website's `.btn-primary` rule and bumped the weight to 600 so the button reads cleanly.

### Migration
None — pure CSS/template change in `admin.ejs`. Re-rendered on next request.

---

## [3.4.5] — 2026-04-29 *(Applegate brand preset)*

### New
- **"Applegate" theme preset** — one-click chip in admin's Theme & Visual Style section that applies the exact palette from richardapplegate.io: `#ff8c2a` orange accent, `#0a0a0a` near-black background, and the site's own `#39d98a` / `#ef4444` / `#f59e0b` for UP / DOWN / DEGRADED. Card style is `flat` to mirror the website's clean borders-without-shadows feel; corner style stays `rounded`. Sits second in the chip row after the existing "Default" preset.

No schema or backend changes — purely a new entry in the client-side `THEME_PRESETS` array.

---

## [3.4.4] — 2026-04-29 *(PWA splash + theme-color match the active palette)*

### Bug fix
The Web App Manifest (`/dashboard/<slug>/manifest.json`) and the `<meta name="theme-color">` tag both always emitted the dark `bg_color` / `accent_color` values, even when the group's `default_theme` was `light`. Practical effect: a Light-theme installed PWA flashed a dark splash screen on launch, and Android's nav bar tinted with the dark accent until the page finished loading.

Fixed in **`backend/server.js`** (manifest endpoint) and **`backend/views/index.ejs`** (theme-color meta) by mirroring the active-palette logic already used for the dashboard CSS:
- `default_theme === 'light'` + `bg_color_light` set → splash uses `bg_color_light`.
- `default_theme === 'light'` + `bg_color_light` blank → splash uses the same neutral `#f6f8fb` fallback the dashboard uses.
- `default_theme === 'light'` + `accent_color_light` set → OS chrome tints with the light accent.
- Dark groups behave exactly as before (uses `bg_color` / `accent_color`).

### Migration
Pure server-side rendering change. Manifest is cached for 5 minutes (`Cache-Control: public, max-age=300`) — installed PWAs will pick up the new manifest on their next launch / refresh, no reinstall needed.

---

## [3.4.3] — 2026-04-29 *(theme polish + bug fixes for v3.4.2)*

### Bug fixes
- **Light theme rendered with a dark background.** When a group set `default_theme = 'light'` but didn't also set `bg_color_light`, the dashboard fell back to the dark `#060c18` default — text was light-on-light and unreadable. Fixed in **`backend/views/index.ejs`** by hard-defaulting the active background to `#f6f8fb` whenever the active theme is light and no per-group light background is set.
- **`card-style: glass` was invisible in light theme.** The glass effect tinted cards with `rgba(255,255,255,0.04)` — a white wash on a white background. Added an `html[data-theme="light"] body.card-style-glass` override that flips to a `rgba(0,0,0,0.03)` black wash so the cards remain visible regardless of theme.

### UI polish (admin Theme & Visual Style section)
- **Preset chips now show their actual palette.** Instead of one solid swatch + a name, each chip renders a 3-square mini-preview (accent · up · down) so admins can see what each preset's colors look like before clicking. Same chip layout as before; just more useful.
- **Optional-color rows** are now self-contained cards with `:has()`-driven "active" highlighting — when the enable checkbox is on, the row's border tints with the accent so it's obvious which overrides are live. Replaces the inline-style soup with reusable `.theme-color-row` / `.theme-color-grid` classes that follow the same design tokens (`--r-sm`, `--surface`, `--border`) as the rest of the admin form.
- **Light-mode hint** appears below the Light-mode Palette grid only when the group picks Default Theme = Light but hasn't enabled at least one of the light-palette overrides — explains the neutral fallback so admins aren't surprised by a generic light look.
- **Section heading** now matches the style of the existing "Legal Pages" divider (uppercase, letter-spaced label) for consistency with the rest of the form.

### Code cleanup
- Merged `onStatusColorToggle()` and `onLightPaletteToggle()` into a single generic `onOptColorToggle(baseId)` — they did the same thing with different field-name conventions.
- Extracted `setOptColor(baseId, val, defaultHex)` as one shared helper used by both `showGroupForm()` (load from DB) and `applyThemePreset()` (load from preset). Removes three near-identical inline closures.
- Dropped the redundant `swatch` field from `THEME_PRESETS` — the chip swatches are now derived from each preset's actual color values.

### Migration / safety
No schema changes. `index.ejs` and `admin.ejs` template-only — re-rendered on next request, no DB touch. All 30 (card × corner × theme) combinations render-tested.

---

## [3.4.2] — 2026-04-29 *(per-group theme features)*

### New
Five additive theme controls per group, all configurable from the Group edit form in admin (Theme & Visual Style section). All are optional — every existing dashboard renders identically until an admin opts in.

- **Status colors** — override the green / red / orange used everywhere a status is shown (sidebar dots, badges, heartbeat strips, big status pills, SSE map markers). Three columns: `up_color`, `down_color`, `degraded_color`. NULL = built-in default. Soft / glow rgba variants are derived from the hex via the existing `_hexToRgba` helper, so the override cascades to backgrounds, animations, and outlines without manual rgba juggling.
- **Light-mode palette** — `bg_color_light` and `accent_color_light` columns. Used when `default_theme === 'light'`; the existing `bg_color` / `accent_color` stay as the dark-mode pair. Server-side renders a single active palette per request based on `default_theme` (no JS theme toggle yet — the field finally Does Something instead of being a stored-but-unused string).
- **Theme presets** — five one-click chips in admin (Default / Midnight / Forest / Sunset / Mono) that populate every theme field below. Convenience-only; no DB column for the preset name.
- **Card style** — visual treatment of server cards, uptime cards, sidebar rows. Five values: `default` (current), `flat` (no shadows / gradients), `glass` (backdrop-blurred translucent), `glow` (accent halo), `minimal` (transparent + border only). Implemented via `body.card-style-X` + override rules; `default` is a no-op.
- **Corner style** — three values: `rounded` (current — no-op), `sharp` (zero-radius), `pill` (large-radius cards + 999px badges/buttons). Implemented via `body.corner-style-X` + override rules. Excludes intentionally-circular elements (status dots).

### Internals
- New `groupBranding(g, extra)` helper in `server.js` — centralises the five `res.render('index'/'incidents', ...)` call sites that all duplicated the same shape. Adding a sixth theme column now means one edit instead of four.
- New whitelist validators `cleanCardStyle()` / `cleanCornerStyle()` so an invalid value from the API can't wedge a dashboard — falls back to the documented default.
- The previously-stored-but-unused `default_theme` column is now actually read at render time. Existing rows continue to render exactly as before because they're all `'dark'`.

### Migration
Pure additive — seven new columns on `status_groups`, all `DEFAULT NULL` or with sensible defaults (`'default'` / `'rounded'`). Schema migration runs in-place on boot via the existing `ALTER TABLE` + try/catch pattern. Zero data loss, zero downtime.

---

## [3.4.1] — 2026-04-29 *(Omada token re-auth on controller reboot)*

### Bug fix
- **Omada checks stalled for up to ~2 hours after a controller reboot.** The status server caches the Omada Open API access token with the `expiresIn` value the controller hands back (default 7200s), but a controller reboot invalidates server-side tokens immediately. During the window between reboot and natural cache expiry, every check returned `"The access token has expired. Please re-initiate the refreshToken process to obtain the access token"` from Omada and surfaced that message in the dashboard "detail" field.
- Fixed in **`backend/server.js`** — added `isOmadaTokenRejected()` (matches HTTP 401/403, errorCodes -44104/-44109/-44112/-44113, and a token/expired/refreshToken message regex) and refactored the standard + MSP API helpers through a shared `omadaAuthedGet()` that drops the cached token and retries once with a freshly issued one when the controller rejects the previous one. Both standard and MSP modes benefit.

### Why an image rebuild
Required for anyone using the Omada controller integration — without the fix, every Omada controller reboot causes a multi-hour outage in the Omada portion of the dashboard. Non-Omada checks are unaffected.

### Also in this release
- New **`.github/workflows/preview.yml`** — manual `workflow_dispatch` that builds `linux/amd64` only and pushes `applegater/status-server:preview` (plus a `preview-<short-sha>` pin) for Portainer-driven preview deploys ahead of a release.

---

## [3.4.0] — HA / automatic failover feature removed

The high-availability auto-failover work tracked in [issue #13](https://github.com/X4Applegate/status-server/issues/13) has been **fully removed** from the project. The code worked end-to-end — an end-to-end CF-driven failover drill did successfully promote the standby — but the operational complexity (bidirectional MariaDB replication, the promote webhook service, split-brain guard, Cloudflare Load Balancer + Notification policy, the post-failover resync procedure) is genuinely out of proportion to the uptime gains for a self-hosted status monitor.

For most deployments the right model is a **single-server + hourly off-box backup** pattern: one primary running the full stack, plus a cron job somewhere that pulls `mysqldump` snapshots to a second machine (or cloud object storage). Recovery from a hard primary loss becomes "restore the latest dump, swing DNS" — a 15–30 minute manual operation — instead of a 30-second automatic promotion, at roughly 10% of the day-to-day complexity cost.

### Removed
- **`backend/server.js`** — `REPLICA_MODE` / `IS_REPLICA` env flag, the `@@global.read_only` probe in `initDB()`, the `createDatabaseTable`/`clearExpired` gating on `MySQLStore`, and the `if (!IS_REPLICA)` guard around the check loop + scheduled weekly report. The server now unconditionally initialises its schema, runs the check loop, and fires the weekly report — exactly how it behaved before the HA work started.
- **`scripts/promote-replica.sh`** — the promote/failover script.
- **`scripts/promote-webhook.js`**, **`scripts/promote-webhook.service`**, **`scripts/promote-webhook.env.example`** — the standalone host-side HTTP trigger service and its systemd unit + config template.
- **`docs/HIGH_AVAILABILITY.md`** — the full HA operator runbook.
- **`docker-compose.replica.example.yml`** — the replica-mode compose example.
- **`docker-compose.example.yml`** — stripped of the HA-specific commented blocks (replication `command:` flags on the mariadb service, inbound 3306 port exposure, and the "same SESSION_SECRET across both boxes" note).
- **`README.md`** — removed the "Active Development Notice — HA / Automatic Failover Work In Progress" banner.

### What you need to do if you were running the HA pair
- **Standby box** (typically the one with `REPLICA_MODE=1` in its `.env`) — stop `promote-webhook.service`, `systemctl disable --now` it, delete `/etc/systemd/system/promote-webhook.service`, delete `/etc/status-server/promote-webhook.env`. `STOP SLAVE; RESET SLAVE ALL;` on its MariaDB to cut replication. The rest of the box can be powered off, repurposed, or kept as a backup-dump target.
- **Primary box** — remove the replication `command:` flags from the mariadb service in your local compose, remove the `ports:` 3306 exposure if you added it, `RESET MASTER;` on MariaDB if you want the binlogs gone (optional; purely housekeeping).
- **Cloudflare** — delete the Load Balancer(s) and their pools, delete the Notification policy + webhook destination. Point the hostname that was fronting the LB at a plain A/CNAME record pointing to the primary's tunnel. This frees up the LB endpoint quota — if you were on a paid pool you can downgrade.
- **`.env` files** — delete any `REPLICA_MODE=…` line if present. Safe to leave; the code no longer reads it, but tidiness helps.

Interactive single-box operation is identical to pre-HA behaviour. No schema migration, no image rebuild strictly required (the server.js change is purely code-cleanup — the removed flag was opt-in), though a rebuild is recommended so the running image reflects main.

---

## [3.3.5] — 2026-04-18 *(update-checker semver fix)*

### Bug fix
- **`/api/version` was flagging downgrades as "update available."** The check was `latest !== APP_VERSION`, which is true whenever the two differ — including when the running version is *newer* than the latest published GitHub release (e.g. running a just-built 3.3.4 against a repo where the latest tagged release is still 3.3.3). Visible as an "Applegate Monitor v3.3.3 is available — you're running v3.3.4" banner in the admin UI. Replaced with a proper numeric semver comparison (`isNewerVersion(latest, current)` — returns true iff latest is strictly newer). Unit-tested against the 9 obvious edge cases (equal, higher, lower, missing segments, null, pre-release suffix, two-digit minor).

### Why an image rebuild
Pure bug fix to the admin-only version check endpoint. Upgrade whenever convenient — the banner just misleads admins, it doesn't affect monitoring.

---

## [3.3.4] — 2026-04-18 *(HA failover test — scripts/docs/compose fixes)*

Ran a full end-to-end failover + failback drill against the reference deployment and folded everything that misbehaved back into the repo. The app itself didn't need any code changes, but the automation around it surfaced several real sharp edges.

### `scripts/promote-replica.sh` — hardening
- **Auto-comments `--read-only=1` in the mariadb compose file** post-promotion. The runtime `SET GLOBAL read_only = 0` worked, but was silently reverted on the next compose-up because the flag was still in `command:`. Script now auto-detects the mariadb compose file via container labels and edits it in place with a `.pre-promote.bak` backup.
- **Detects separate compose projects.** Most real deployments run mariadb in a different compose project than status-server (shared with Nextcloud, Cloudron, etc.). Script now uses `docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}'` instead of assuming one directory.
- **Detects Portainer-managed `status-server`.** When `$COMPOSE_DIR` has no compose file (because the real one is under `/data/compose/<id>/`), the script prints the detected path and tells you to start the container via Portainer, instead of failing with `no configuration file provided: not found`.
- **Verifies `RESET SLAVE ALL` actually cleared state.** On some MariaDB versions a stale `Master_Host` lingers in `multi-master.info` or `relay-log.info` and causes `error 1236 Could not find first log file` on the next restart. Script re-runs cleanup and removes those files if it sees leftover state.
- **More robust cloudflared unit detection.** Switched from `systemctl list-unit-files | grep` (which misses drop-in and override units on some layouts) to `systemctl cat`.
- **Port auto-detection for `/health` check.** Reads the actual mapped port from `docker port` instead of hard-coding `3000`, so the sanity check works on setups using `127.0.0.1:3200:3000` to avoid Cloudron conflicts.
- **Documents the IDEMPOTENT catch-up dance** in the printed next-steps block — needed when failback hits `Duplicate entry for key 'PRIMARY'` during the bootstrap overlap window.

### `docker-compose.replica.example.yml` — default for Cloudflare Tunnel + Cloudron hosts
- **status-server port defaults to `"127.0.0.1:3200:3000"`** (was `"3000:3000"`). Loopback-only because Cloudflare Tunnel connects outbound and doesn't need external ports. Port 3200 avoids collision with Cloudron (and Grafana, Next.js, Gitea, and others that want 3000). Inline comment explains when to change it back to 3000.
- **Expanded 3306 comments** with the failback scenario — when this box is promoted and the old primary comes back as a replica, that old box needs inbound 3306 on this one. Includes the 3307 alternative for hosts where Cloudron already owns 3306.

### `docs/HIGH_AVAILABILITY.md` — new "Known gotchas" section
Seven real failure modes hit during the drill, each with verbatim error messages and fixes:
1. **Duplicate-key errors during bootstrap catch-up** — the `--flush-logs` + live-writes race. Fix: `slave_exec_mode=IDEMPOTENT` for the overlap window, then back to `STRICT`.
2. **`--read-only=1` not durable.** Runtime `SET GLOBAL` alone silently reverts on compose restart.
3. **DB and app in separate compose projects.** Promote script breaks without the label-based compose detection.
4. **Port 3000 collision with Cloudron.** Use 3200 on loopback.
5. **`RESET SLAVE ALL` leaving stale `.info` files.**
6. **Running destructive SQL on the wrong SSH session** — hostname guards on every destructive command.
7. **Bash history expansion eating passwords with `!` or `#`.** `set +H` + single-quoted env vars.

### Why an image rebuild for a config/docs release
`/health` logic is unchanged, but the `3.3.2` / `3.3.3` images were tagged `:latest` and several deployments are pinning `:latest`. Rebuilding as `3.3.4` refreshes the Alpine base layer (picks up CVE fixes that have landed since 3.3.2 was built) and keeps the version string in `/health` responses aligned with the compose/docs bundle. No runtime behavior change.

---

## [3.3.3] — 2026-04-18 *(HA playbook refinements — docs/compose only)*

Battle-tested the 3.3.2 HA setup against a real second box and folded every sharp edge back into the docs and the replica compose example. **No image changes** — existing `applegater/status-server:3.3.2` and `:latest` are unaffected. Pull the repo if you're following `docs/HIGH_AVAILABILITY.md` to set up your own standby.

### Doc fixes
- **`MASTER_SSL = 0` is now the default** in the `CHANGE MASTER TO` example. Previously the doc had `MASTER_SSL = 1`, which silently fails with a confusing `'bogus data in log event'` 1236 error because the default MariaDB container doesn't ship with SSL certs. Added a sidebar explaining when to actually enable SSL (and recommending WireGuard/Tailscale over MariaDB self-signed TLS).
- **Added `--max_allowed_packet=1G` to Primary's binlog flags** with an explanation of why (binlog events >16 MB crash replication with error 1236). A container restart is required — `SET GLOBAL` at runtime doesn't affect the existing binlog dump thread.
- **Added `--replicate-wild-do-table=status_monitor.%` guidance** for Primaries that host multiple databases on the same MariaDB instance. Without the filter, replica crashes with 1146 on events for tables it doesn't have.
- **Expanded Troubleshooting section** with verbatim error messages and fixes for: 1236/max_allowed_packet, 1236/bogus-data (SSL), 1236/impossible-position (stale coords), duplicate server-id, 1146/missing-table (multi-DB).

### `docker-compose.replica.example.yml`
- Adds `--max_allowed_packet=1G` and `--slave-max-allowed-packet=1G` to match Primary.
- Adds `--log-slave-updates=1` (needed for chained replication / failback scenarios).
- Adds commented-out `--replicate-wild-do-table=status_monitor.%` line with inline guidance on when to uncomment it.
- All command flags now have explanatory inline comments.

### Why no image rebuild
This release is purely configuration/documentation. The runtime code in `backend/` is identical to 3.3.2. If you're not running HA, there's nothing to do.

---

## [3.3.2] — 2026-04-18 *(high-availability support)*

Adds a liveness endpoint and a full active/passive failover playbook so you can run a second box as a hot standby behind a load balancer.

### New
- **`GET /health`** — unauthenticated probe for Cloudflare LB, AWS ALB, or any HTTP uptime monitor. Returns `200` when the DB is reachable and the poll loop ran within the last 2 minutes; `503` otherwise. Body: `{ok, version, uptime_s, db, last_poll_s, servers, reason?}`. Never cached, never rate-limited. Pass `?strict=1` to additionally require `serverConfig.length > 0` — useful for keeping a replica out of rotation until it has finished loading config.
- **HA playbook** — new `docs/HIGH_AVAILABILITY.md` walks through the complete active/passive setup: MariaDB binlog replication, Replica bootstrap with `mariadb-dump --master-data=2`, Cloudflare Load Balancing pool config, promotion, and post-failover rebuild. Covers the "don't split-brain" footguns explicitly.
- **`scripts/promote-replica.sh`** — one-command Replica promotion: `STOP SLAVE; RESET SLAVE ALL; SET GLOBAL read_only=0;` then starts the app container and sanity-checks `/health`. Confirms with a typed `promote` prompt before running.
- **`docker-compose.replica.example.yml`** — reference compose file for the Replica host. MariaDB has `--server-id=2 --read-only=1`; status-server is gated behind a `promoted` profile so it stays stopped until you run the promotion script (prevents write errors against a read-only replica).

### Internal
- `lastPollAt` state variable updated at the end of every `pollAll()` pass; used by `/health` to detect a stalled poll loop
- `startedAt` captured at module load for `uptime_s` reporting

### Why active/passive, not active/active?
Automatic failover with a single-writer DB (MariaDB classic replication) requires fencing to avoid split-brain. For a self-hosted monitor, a 60-second Cloudflare health-probe + a 10-second manual promotion is the right trade-off — much simpler than Galera/Orchestrator and safer than trying to auto-promote on a network blip. See the playbook for the full rationale.

---

## [3.3.1] — 2026-04-17 *(security patch)*

Resolves three CodeQL high-severity alerts surfaced against 3.3.0.

### Security fixes
- **CodeQL #79 — Polynomial regex on uncontrolled data** (`js/polynomial-redos`). `POST /api/public/subscribe` was validating emails with an unbounded-quantifier regex (`^[^\s@]+@[^\s@]+\.[^\s@]+$`), vulnerable to ReDoS via crafted inputs. Now uses the existing `isValidEmail()` helper with bounded quantifiers (local ≤64, domain ≤253, TLD ≤63).
- **CodeQL #78 — Incomplete string escaping** (`js/incomplete-sanitization`). The API Keys table was interpolating `k.name` into an `onclick="askDelApiKey(id,'<name>')"` attribute with only single-quote escaping, missing backslashes and HTML metacharacters. Rewritten to pass only the key id; the name is looked up client-side from `_apiKeyStore`. All name/prefix fields in the table are now HTML-escaped via `_escHtml()`.
- **CodeQL #77 — Insufficient password hash computational effort** (`js/insufficient-password-hash`). API key storage switched from `SHA-256(rawKey)` to `HMAC-SHA256(SESSION_SECRET, rawKey)`. Deterministic lookup is preserved, but a DB dump alone is no longer sufficient to validate keys — the server-side pepper (`SESSION_SECRET`) is also required.

### Breaking (minor)
- **API keys created under 3.3.0 must be regenerated.** The new HMAC scheme produces a different hash; old keys will fail validation with `Invalid API key`. Regenerate in Admin → API Keys. (Keys created ≥3.3.1 are portable across restarts as long as `SESSION_SECRET` is stable.)

---

## [3.3.0] — 2026-04-17 *(stable)*

Major release consolidating the 3.3.0-beta line into stable, plus three new production-ready features.

### Highlights — New in 3.3.0 stable
- **🔍 Keyword / content check (HTTP)** — every HTTP check now accepts optional **Body must contain** and **Body must NOT contain** substrings. Useful for catching soft-failures where a service returns `200 OK` with an error page, a maintenance banner, or a missing marker string. The response body is buffered (up to 1 MB) only when one of the fields is set, so the hot path is unchanged for existing checks.
- **📓 Runbook notes per server** — every server now has a **Runbook** field (markdown) in the admin form. When a server is **down** or **degraded**, the runbook appears at the top of its detail panel with a pulsing "follow these steps" flag. Supports `#/##/###` headings, bullet/numbered lists, **bold**, *italic*, `code`, fenced ``` blocks, and `[links](https://…)`. Runbook content is **logged-in-only** — stripped from anonymous SSE and anonymous group dashboards, since playbooks may contain internal ops detail.
- **📬 Weekly uptime report email** — new admin **Settings → Weekly Uptime Report** section. Enable the toggle, enter recipients, and every **Monday at 09:00 UTC** an HTML summary email is sent: overall uptime %, incident count, total checks run, top-5 worst-uptime servers (with longest outage), and top-5 slowest services by avg response time. Includes a **Send Now** button for ad-hoc sends or testing.

### Consolidated from 3.3.0-beta + 3.4.0-beta
- **📷 Public status pages** — per-group `/status/<slug>` URL with no login required (toggle in Groups tab).
- **📧 Email alert subscriptions** — visitors can subscribe to down/recovery notifications for a group from the 🔔 Alerts button; one-click unsubscribe links in every email.
- **📌 Pin / favourite servers** — star button on every card; pins sync to DB for logged-in users, fall back to `localStorage` for anonymous visitors.
- **🎨 Dashboard UI refresh** — full-width health banner ("All N systems operational"), response-time pill on every card (green/yellow/red tier), card redesign with 2-line name/description clamp.
- **🎨 Badge `?style=` parameter** — `flat`, `flat-square`, `plastic`, `for-the-badge`.
- **🗺️ Map view (MapLibre GL JS)** — 🗺️ Map button switches to a full-width map when any server has coordinates. Dark CARTO style by default; native Mapbox dark-v11 when a Mapbox token is configured. Co-located servers are grouped into one combined marker. Map is **hidden for anonymous visitors** and lat/lng are stripped from their SSE feed.
- **📍 Address geocoding** — free-text address field + **Look up** button. Resolves via Nominatim with Photon fallback; address text is persisted alongside lat/lng.
- **🔑 API key authentication** — Admin → API Keys tab. `read` scope (`GET /api/v1/status`, `GET /api/v1/status/:id`) and `write` scope (`POST /api/v1/servers/:id/push-status` for CI/CD). Keys stored as SHA-256 hashes; shown once at creation.
- **📤 Import / Export** — Servers tab toolbar: **⬇ Export** (JSON snapshot of all servers + checks), **⬆ Import** (bulk-create, with skip-or-overwrite for conflicts).
- **📦 Script check type** — admin-only. Enter any shell command (no shell metacharacters); exit 0 = up, non-zero = down. Uses `spawn`, not `exec`.
- **📅 Maintenance windows** — schedule alert suppression per-server with title + notes. Windows are cached in memory and refreshed every 60s; CRUD writes refresh inline.
- **🧯 Public incident page** — per-incident `/incident/<id>` page with an operator-driven **update timeline** (investigating → identified → monitoring → resolved). Manual "post update" textarea; auto-posts `restored after 2m 14s` on recovery.
- **📢 Dashboard banner system** — admin-scheduled banners render above all dashboards with dismiss + expiry.
- **⚠️ Danger Zone** — Settings → Clear All History behind a two-gate confirmation (browser dialog + typed phrase `DELETE ALL HISTORY`). Wipes history, incidents, and audit log only — servers, users, groups, webhooks, settings are preserved.
- **🌙 Dark theme only** — the light-theme branch was removed. Dark across all views.
- **🛡️ Scout hardening** — Docker image rebuilt for Docker Scout health-score compliance.

### Security & privacy
- Map lat/lng, runbook, and other logged-in-only fields are filtered out of every public/anonymous SSE frame and public group endpoint.
- `/api/public/servers` is now consistent with the SSE payload for the same auth level (fixes prior race where REST would overwrite SSE-populated fields like `lat/lng`).
- Omada controller CRUD rejects private/loopback IPs and non-allowlisted hostnames; TLS fingerprint verified via DNS lookup before each fetch.
- Session auth on sensitive admin surfaces (`/api/admin/api-keys`, runbook CRUD, weekly-report routes) — admin role required.

### Internal
- New columns: `status_servers.runbook TEXT`
- New `status_settings` keys: `weekly_report_enabled`, `weekly_report_recipients`, `weekly_report_last_sent_at`
- New functions: `buildWeeklyReport()`, `sendWeeklyReport()`, `maybeSendScheduledWeeklyReport()` (hourly tick, Monday ≥09:00 UTC guard, once per ISO week)
- New routes: `GET/POST /api/admin/settings/weekly-report`, `POST /api/admin/settings/weekly-report/send`
- `httpCheck()` signature extended with optional `contains` / `notContains` params; bounded 1 MB body buffer only when either is set
- Admin `renderDetail()` gains a runbook section with safe markdown renderer (escape-then-unescape, allow-listed tags, http/https/mailto links only)

---

## [3.4.0-beta.1] — 2026-04-17 *(beta branch)*

### New Features
- **🔑 API key authentication** — generate named API keys in Admin → API Keys tab. Supports `read` scope (`GET /api/v1/status`, `GET /api/v1/status/:id`) and `write` scope (`POST /api/v1/servers/:id/push-status` for CI/CD pipelines). Pass keys via `Authorization: Bearer <key>` or `X-API-Key: <key>`. Keys are stored as SHA-256 hashes; the raw key is shown once at creation only.
- **📤 Import / Export** — two new buttons in the Servers tab toolbar (admin only). **⬇ Export** downloads all servers + checks as a timestamped JSON file. **⬆ Import** uploads a JSON file and bulk-creates servers, with a skip-or-overwrite choice for name conflicts.
- **📦 Script check type** — new check type available to admins: **Script (exit code)**. Enter any shell command (no shell metacharacters allowed); exit 0 = up, non-zero = down. stdout/stderr captured as the check detail. Uses `spawn` (not `exec`) to prevent shell injection.
- **🗺️ MapLibre GL JS** — replaced Leaflet + Mapbox raster-tile workaround with MapLibre GL JS (Mapbox GL–compatible open-source renderer). Mapbox dark-v11 now loads natively when a token is configured; free CARTO dark GL style is the fallback. Both the full map view and the server detail mini-map use the same engine.
- **📍 Address geocoding** — server location field replaced with a free-text address input + **Look up** button. Coordinates are resolved via OpenStreetMap Nominatim and stored automatically on save.
- **🔒 Map privacy** — map view and detail mini-map are hidden for logged-out users.

### Internal
- New DB table `status_api_keys` (`id`, `name`, `key_hash`, `key_prefix`, `scope`, `last_used_at`, `created_by`, `created_at`)
- New API routes: `GET /api/admin/api-keys`, `POST /api/admin/api-keys`, `DELETE /api/admin/api-keys/:id`, `GET /api/v1/status`, `GET /api/v1/status/:id`, `POST /api/v1/servers/:id/push-status`, `GET /api/admin/export`, `POST /api/admin/import`
- `requireApiKey(scope)` middleware factory for machine-to-machine auth
- `scriptCheck(command, timeout)` — uses `child_process.spawn`, validates no shell metacharacters at save time

---

## [3.3.0-beta.2] — 2026-04-16 *(beta branch)*

### New Features
- **📌 Pin servers (DB-backed)** — star button on every server card pins it to a permanent **⭐ Pinned** section at the top. Pins now sync to the database for logged-in users so they persist across devices and browsers. Non-logged-in visitors still use `localStorage`.
- **🎨 Dashboard UI refresh**
  - **Health banner** — full-width status strip below the topbar: green "All N systems operational", orange for degraded, red for down. Animates in real-time as SSE events arrive.
  - **Response time pill** — each server card now shows the latest round-trip time (green < 150 ms, yellow < 400 ms, red ≥ 400 ms) next to the status badge.
- **🎨 Badge styles** — all badge endpoints now accept a `?style=` parameter: `flat` (default), `flat-square`, `plastic`, `for-the-badge`. Example: `/api/badge/my-server/status?style=for-the-badge`
- **🗺️ Map view** — a **🗺️ Map** button appears in the topbar when any server has coordinates set. Clicking it switches from the list view to a full-width Leaflet map (dark CARTO tiles, no API key needed). Servers appear as coloured circle markers (green/orange/red/grey). Clicking a marker shows a popup with name, status, host, and response time. Set **Latitude** and **Longitude** on any server via Admin → Edit Server.

### Internal
- New DB table `status_pinned_servers` (`user_id`, `server_id`)
- New columns `status_servers.lat`, `status_servers.lng` (`DECIMAL(10,7)`)
- New API routes: `GET /api/pinned`, `POST /api/pinned/:serverId`
- Leaflet.js 1.9.4 loaded from CDN (unpkg) — only fetched when map view is opened

---

## [3.3.0-beta.1] — 2026-04-16 *(beta branch)*

### Beta Features
- **📷 Public status page per group** — admins can enable a `/status/<slug>` URL per dashboard that requires no login. Toggle the new **Public Status Page** switch in the Groups tab of the admin panel. When enabled, anyone with the link can view that group's servers without an account.
- **📧 Email alert subscriptions** — visitors on any group dashboard can click the 🔔 Alerts button in the topbar to subscribe their email address to down and/or recovery notifications for that group. Subscriptions are stored in a new `status_email_subscriptions` table; emails are sent via the existing SMTP configuration. An unsubscribe link is included in every alert email.
- **📌 Pin / favourite servers** — a star button on every server card lets users pin critical servers to the top of the sidebar in a permanent **⭐ Pinned** section. Pins are stored per-browser in `localStorage` — no account required.

### Internal
- New DB table: `status_email_subscriptions` (email, group_id, notify_down/recovery, unsubscribe_token)
- New column: `status_groups.public_enabled` (TINYINT, default 0)
- New API routes: `POST /api/public/subscribe`, `GET /api/public/unsubscribe`, `GET /api/public/subscription-status`
- New page route: `GET /status/:slug`
- `fireSubscriberEmails()` fires after every `fireWebhooks()` call to deliver subscription emails

---

## [3.2.1] — 2026-04-16

### Fixed
- **Omada integration restored** — GitHub Copilot's autofix made `sanitizeBaseUrl()` an `async` function but did not update the 4 call sites to use `await`, causing every Omada URL to resolve as `[object Promise]` and break all Omada checks. Added `await` to all call sites. Apologies for the disruption.

### Dependencies
- **undici** bumped from `7.24.8` → `8.1.0` (Dependabot)

---

## [3.2.0] — 2026-04-16

### Security
- **SSRF hardening — all 76 CodeQL alerts resolved** — zero open code scanning alerts on main
- Strengthened `sanitizeBaseUrl()`: protocol picked from fixed allow-list, each DNS label filtered through explicit character whitelist (`[a-zA-Z0-9-]`), port coerced to integer — breaks taint chain CodeQL traces through user-controlled controller URLs
- Sanitized `omadac_id` / `mspId` with `sanitizePathSegment()` before embedding in Omada API URL paths
- Path segments in `omadaApiGet()` and `omadaMspApiGet()` filtered through character whitelist, query string preserved separately
- Added `sanitizeRequestUrl()`, `sanitizePathSegment()`, and `sanitizeHost()` helpers used across all outgoing HTTP requests
- Square POS `locationId` sanitized before embedding in API URL path
- `postWebhook()` URL reconstructed from parsed components before fetch
- `pingCheck()` host validated against DNS/IP character whitelist before shell exec

### Changes
- Admin tab bar now fully visible on desktop with no scrolling required; scrollable on narrow/mobile screens
- Dashboards dropdown hidden from public visitors when not logged in
- Added Code of Conduct, Contributing guide, GitHub issue templates, and pull request template
- Added weekly Friday automated Docker Hub release via GitHub Actions
- Docker Hub image available: `applegater/status-server:v3.2.0`

---

## [3.1.9] — 2026-04-15

### Security
- **SSRF hardening on Omada controller URLs** — replaced URL validation with `sanitizeBaseUrl()` which reconstructs the outbound URL exclusively from parsed components (`protocol`, `hostname`, `port`). No raw user-supplied bytes ever reach the `fetch()` call. Closes 4 CodeQL `js/request-forgery` alerts.
- **ReDoS fix on email validation** — all email regex patterns replaced with `isValidEmail()` using bounded quantifiers (`{1,64}`, `{1,253}`, `{1,63}`), making matching linear regardless of input length. Closes 6 CodeQL `js/polynomial-redos` alerts.
- **General API rate limiter** — `express-rate-limit` now applied to all `/api/*` routes (500 req / 15 min). Closes 48 CodeQL `js/missing-rate-limiting` alerts.
- **Page route rate limiter** — `pageLimiter` (300 req / 15 min) applied to `/healthz`, `/dashboard/:slug`, `/dashboard/:slug/manifest.json`, `/dashboard/:slug/privacy`, and `/dashboard/:slug/terms`.
- **Google OAuth callback rate-limited** — `loginLimiter` now covers `/auth/google/callback` in addition to the login form.
- **Badge SVG injection fix** — `makeBadge()` now escapes `"` in XML attribute values and coerces `label`/`value` to strings, preventing type confusion when `req.query` params are arrays.
- **CI workflow permissions** — `.github/workflows/ci.yml` now declares `permissions: contents: read`, satisfying the `actions/missing-workflow-permissions` rule.
- **admin.ejs string escaping** — all 5 JavaScript string interpolations in the admin template now escape `\` before `'`, preventing incomplete sanitization when names contain backslashes. Closes 5 CodeQL `js/incomplete-sanitization` alerts.
- **Helmet CSP and CSRF alerts** dismissed as false positives: CSP is intentionally disabled pending an inline-script refactor; CSRF is mitigated by Cloudflare Turnstile and `sameSite=lax` session cookies.

---

## [3.1.8] — 2026-04-15

### Added
- **Square account group permissions** — Square accounts can now be assigned to one or more dashboard groups via a new "Allowed Dashboards" multi-checkbox in the Square form (mirrors the Omada group picker). Viewers who have access to any of those groups can see and use that Square account in their server checks. New `status_square_account_groups` many-to-many table with `ON DELETE CASCADE` so mappings clean up automatically when accounts or groups are removed.

### Changed
- **Square account visibility**: admins still see every account; **viewers** now see accounts they created **or** accounts mapped to any of their allowed dashboards (previously only their own).
- **Admin button on custom-domain dashboards** now links to `/admin` on the **same custom domain** (e.g. `status.myanthemcoffee.com/admin`) instead of bouncing visitors to the gateway host. Lets each customer log in and manage on their own branded domain.

---

## [3.1.7] — 2026-04-15

### Added
- **Admin button on group dashboards** — the topbar Admin button now appears on every group dashboard (both custom-domain dashboards like `status.myanthemcoffee.com` and regular `/dashboard/<slug>` routes). Custom-domain dashboards link to the absolute gateway URL (`EXTERNAL_URL/admin`) since the session cookie lives on the gateway, not on the customer's domain.

### Reverted
- Removed the multi-source hostname matching and `/api/admin/whoami-host` diagnostic endpoint introduced in 3.1.6. The real fix for Cloudflare-Tunnel custom domains is adding the domain to Turnstile's Hostname Management allowlist in the Cloudflare dashboard — the app-side hardening wasn't needed.

---

## [3.1.6] — 2026-04-15

### Changed
- **Custom-domain routing hardened** — the middleware that matches a request's hostname against each group's `custom_domain` now checks three sources (`req.hostname`, the `X-Forwarded-Host` header, and the raw `Host` header) and matches on any of them. Makes custom-domain dashboards work reliably behind Cloudflare Tunnel, Caddy, nginx, and other reverse proxies regardless of which header they forward.

### Added
- **`/api/admin/whoami-host` diagnostic endpoint** — admin-only JSON endpoint that echoes the hostname, raw Host header, `X-Forwarded-Host`, Cloudflare (`CF-*`) headers, and the resolved client IP. Useful for debugging why a custom-domain dashboard isn't routing.

### Note
- **Cloudflare Turnstile + custom domains**: if Turnstile is enabled, every custom domain must be added to the widget's **Hostname Management** list in the Cloudflare dashboard. Otherwise Turnstile refuses to render on that domain and the login page breaks.

---

## [3.1.5] — 2026-04-15

### Changed
- **Mobile-style hamburger menu** — at widths ≤ 1100 px all topbar-right buttons (Manage, Profile, Password, Logs, Refresh, Home, Logout, user badge) collapse into a single hamburger icon that opens a floating dropdown panel. Prevents buttons from wrapping onto multiple lines or squeezing awkwardly.
- **Dashboards dropdown menu** — dashboard pills collapse into a single "Dashboards ▾" dropdown at the same 1100 px breakpoint (previously horizontal scroll). Chevron rotates when open; click outside to close.
- **"Manage" renamed to "Admin"** on all group dashboard topbars (the admin panel itself keeps its internal "Manage" drawer title).
- **Removed legacy Manage star pill** from the main dashboard quick-nav — the existing Manage / Admin button next to the theme toggle is the single source of truth.

---

## [3.1.4] — 2026-04-15

### Fixed
- **Viewers can now create Square accounts** — the Square tab's "+ Add Account" button was incorrectly hidden from viewer-role users. Viewers can now add, edit, and delete their own Square accounts; they only see accounts they created while admins see all accounts.
- **Square delete endpoint** — corrected middleware from `requireAdmin` to `requireAuth` so viewers can delete their own accounts as intended.

---

## [3.1.3] — 2026-04-15

### Changed
- **Square POS alert debounce** — Square POS down/degraded alerts are now held for 5 minutes before firing. If the device comes back online within that window the alert is silently cancelled (no Slack ping). If it is still down after 5 minutes the alert fires and a recovery notification is sent when it comes back up. All other check types (ping, HTTP, TCP, DNS, Omada, etc.) continue to alert immediately as before.

---

## [3.1.2] — 2026-04-14

### Added
- **Server descriptions on dashboard cards** — server cards on the main dashboard now show the description (italic, muted) below the name when one is set, matching the admin sidebar display

---

## [3.1.1] — 2026-04-14

### Fixed
- **Server card names no longer truncated** — removed `text-overflow:ellipsis` so full names wrap instead of cutting off with `…`
- **Server cards widened** — minimum card width raised from 160 px to 210 px so long names like "Omada Controller - Puyallup" wrap onto fewer lines

---

## [3.1.0] — 2026-04-14

### Added
- **Square POS accounts tab** — centralized Square account management in the admin panel (mirrors the Omada tab). Store access tokens once; all Square POS checks reference an account by ID. Supports production and sandbox environments. Deletion is blocked while any server check still references the account.
- **Square POS check type** (`square_pos`) — polls the Square Locations and Devices APIs to verify a POS location is `ACTIVE` and at least one registered Terminal/device is online. Reports device count, online ratio, and "needs attention" state. Backwards-compatible with inline tokens if no `account_id` is set.
- **Heartbeat incident modal** — clicking a red (down) heartbeat dot opens a popup showing every matching incident from the server's history. Incidents are matched with a ±90-second tolerance so the exact poll time doesn't have to align perfectly with the incident start/end.

### Changed
- **Dashboard fills full viewport width** — removed the 1440 px cap and the 2-column maximum on the main dashboard columns layout. The grid now uses as many ~640 px columns as the viewport allows (3 on 1920 px, 4+ on ultrawide), filling the screen edge to edge.
- **Sub-section cards span full group width** — named sub-sections (e.g. "ACCESS POINT") now span all columns inside their parent group via `grid-column: 1 / -1`, preventing cards from stacking in a single narrow column.
- **Sub-section titles styled** — section heading rows now have a visible grey card background (`--surface2`), border, and bright uppercase text so they read clearly against the card grid.
- **Admin sidebar server descriptions** — server rows in the admin panel sidebar now show the server's description as a third line (italic, muted) when one is set.
- **Admin sidebar independent scroll** — the admin sidebar uses `position:sticky` with `overflow-y:auto` so it scrolls independently while the main content area scrolls with the page.

---

## [3.0.2] — 2026-04-14

### Changed
- **Collapsible group headers** — clicking a category group header (name, dot, count row) on the main dashboard now collapses or expands the group body with a smooth animation and chevron rotation. State is persisted in localStorage so groups stay collapsed across page reloads.

---

## [2.9.0] — 2026-04-12

### Added
- **Microsoft Teams webhook** — MessageCard format compatible with classic Incoming Webhook connectors; color-coded theme bar, facts table, and "View Dashboard" action button. Auto-detected from `webhook.office.com` URLs.
- **Telegram webhook** — HTML-formatted bot messages with bold labels, `<pre>` alert details, and a dashboard link. URL format: `https://api.telegram.org/bot{TOKEN}/sendMessage?chat_id={CHAT_ID}`. Auto-detected automatically.
- **Pushover webhook** — title + HTML message with priority levels: high (1) for down alerts, normal (0) for degraded/test, low (−1) for recovery. Dashboard link attached when available. URL format: `https://api.pushover.net/1/messages.json?token={APP_TOKEN}&user={USER_KEY}`. Auto-detected automatically.
- **Admin audit log** — new **Audit** tab in the admin panel tracks 17 event types: logins (success + failure), logouts, server create/update/delete, user create/update/delete, group create/update/delete, password changes, and initial admin setup. Filterable by category, paginated, admin-only.
- **CI via GitHub Actions** — runs on every push and pull request; tests Node 18 and Node 20, `npm audit`, syntax check, and Docker build. Green badge on README.
- **Dependabot** — weekly npm, Docker base-image, and monthly GitHub Actions pin updates. Patch/minor bumps grouped into one PR to keep noise low.
- **MariaDB backup script** (`backup.sh`) — timestamped `.sql.gz` dumps via `docker exec mysqldump --single-transaction`. Reads credentials from `.backup.env`, auto-prunes files older than `KEEP_DAYS` (default 7). Cron-ready.
- **Restore script** (`restore.sh`) — confirms before DROP + recreate, then pipes decompressed dump into the MariaDB container.
- **`SECURITY.md`** — responsible disclosure policy, 48h ack / 7-day fix-goal for critical issues, scope, and a summary of existing security controls. Surfaced automatically by GitHub's Security tab.

### Changed
- **Webhook `postWebhook`** migrated from raw `http/https` callbacks to native `fetch` + `AbortSignal.timeout(8000)` — properly aborts the full request on timeout, not just the socket.
- **Webhook format dropdown** updated: auto-detect label now mentions Teams, Telegram, and Pushover; each format shows its own URL placeholder in the form.
- **`buildWebhookPayload`** — removed a dead `lines` variable that was defined but never used.
- **DB ENUM** for webhook format extended to include `teams`, `telegram`, `pushover` (upgrade-safe migration).

### Security
- **Removed unauthenticated `/api/debug/raw-status` endpoint** — exposed full live server status (hosts, response times, cert data) to any caller without authentication.

---

## [2.8.0] — 2026-04-12

### Added
- **Persistent sessions** — sessions are now stored in MariaDB (`sessions` table auto-created on first boot). Container restarts and redeploys no longer log users out. Uses a dedicated small pool (2 connections) separate from the main monitoring pool.
- **Structured logging (pino)** — all app logs are now structured JSON in production, making them trivially ingestible by Loki, Grafana, Datadog, or any log aggregator. In development, pino-pretty outputs colorised human-readable lines automatically. Log level is overridable via `LOG_LEVEL` env var.
- **HTTP request logging (pino-http)** — every request is logged with method, path, status code, and latency. Noisy endpoints (`/healthz`, SSE streams, badge fetches) are filtered out automatically.

### Changed
- **Dropped `node-fetch`** — the app now uses Node's built-in `fetch` (available since Node 18) for all outbound HTTP: Cloudflare Turnstile verification, GitHub release checks, and all Omada Open API calls.
- **Omada TLS** — custom TLS handling for self-signed Omada controller certificates migrated from node-fetch's `agent:` option to native `fetch` with an undici `Agent` dispatcher (built into Node 18+). No functional change; one fewer third-party dependency.
- **Timeouts** — all outbound fetch calls now use `AbortSignal.timeout(8000)` (native Node 17.3+) instead of the deprecated node-fetch `timeout` option.

---

## [2.7.0] — 2026-04-12

### Added
- **PWA support** — per-group dashboards are now installable to iOS/Android home screens with branded icons, theme colors, and standalone display mode; new `/sw.js`, `/api/icon/:slug`, and `/dashboard/:slug/manifest.json` endpoints
- **Dynamic group icons** — `/api/icon/:slug` serves the group's stored logo, or generates a branded SVG from the group's initials + accent color as a fallback
- **`/healthz` endpoint** — lightweight liveness probe with DB ping (`SELECT 1`); returns `{ok, version, uptime, db}` on success, 503 on failure; used by the new Docker `HEALTHCHECK`
- **Security headers (helmet)** — HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, and other baseline headers on every response
- **Rate limiting** — brute-force defense on `/api/login` (10 per 15 min), `/api/setup` (3 per hour), and `/api/change-password` (10 per 15 min), keyed on real client IP via `trust proxy`
- **Graceful shutdown** — `SIGTERM`/`SIGINT` now drains SSE streams and closes the DB pool cleanly before exit; 10-second hard-kill fallback guards against hung drains
- **Boot-time config validation** — refuses to start in `NODE_ENV=production` when `SESSION_SECRET` is still the default or `DB_PASSWORD` is unset; non-prod environments get warnings instead of a crash
- **Global error handler** — catches unhandled errors and returns a generic message (JSON under `/api/*`, plain text otherwise) so stack traces never leak to the browser

### Security
- **nodemailer 6.10.1 → 8.0.5** — closes 4 high-severity advisories: SMTP command injection via `envelope.size`, CRLF injection in transport name (EHLO/HELO), `addressparser` recursive-call DoS, and `addressparser` interpretation conflict that could deliver mail to unintended recipients
- **Session cookies** — `secure: "auto"` (Secure flag now set automatically on HTTPS via `X-Forwarded-Proto`), `sameSite: "lax"` added for CSRF defense
- `npm audit` now reports **0 vulnerabilities**

### Changed
- **Dockerfile hardened**:
  - Copies `package-lock.json` and uses `npm ci --omit=dev` for reproducible, deterministic builds
  - Runs as the non-root `node` user via `USER node`
  - Declares `HEALTHCHECK` polling `/healthz` every 30s
  - Sets `NODE_ENV=production`
  - Installs `wget` for the health probe; keeps `iputils` for ICMP checks
- **`package-lock.json` committed** — `docker compose build` now always installs the exact dependency tree that passed `npm audit`
- **`engines.node >= 18`** declared in `package.json` to make the minimum runtime explicit

---

## [2.6.0] — 2026-04-12

### Added
- **Cloudflare Turnstile login protection** — optional CAPTCHA-alternative that blocks bots and brute-force login attempts without user friction; uses Cloudflare's free Turnstile service (a privacy-friendly alternative to reCAPTCHA)
- **Turnstile settings in admin Settings tab** — enter your Cloudflare Site Key and Secret Key, toggle on/off; live status indicator shows enabled/disabled state
- **`/api/turnstile-config` public endpoint** — login page fetches this on load to know whether to render the widget; only exposes the site key (never the secret)
- **Auto-render Turnstile widget** — login page dynamically loads the Cloudflare script and renders the widget when enabled; skipped automatically during first-time setup (no admin configured yet)
- **Login verification** — `/api/login` verifies the Turnstile token against Cloudflare's siteverify API before checking credentials; failed verifications are logged and return a clear error
- **Widget auto-reset on failed login** — if login fails (bad password or captcha), the Turnstile widget resets so the user can try again without a page reload

### Changed
- **Settings tab header** updated from "SMTP & Email Notifications" to "Settings" to reflect the expanded scope

---

## [2.5.0] — 2026-04-12

### Added
- **First-time signup flow** — fresh installs prompt admin to create an account on `/login`; replaces hardcoded `ADMIN_USERNAME`/`ADMIN_PASSWORD` env vars
- **Email notifications via SMTP** — new "Email" webhook format sends rich HTML alerts (color-coded header, structured table, alert details, dashboard button)
- **Settings tab in admin** — manage SMTP host/port/user/password/from from the web UI; settings stored in DB, env vars work as fallback
- **Per-server Section/Category field** — group servers under named headings on dashboards (e.g. "Omada Network", "DNS Servers"); autocomplete suggests existing categories
- **Interactive response time chart** — hover shows a crosshair, dot snaps to nearest data point, and tooltip displays exact ms + timestamp
- **`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM`/`SMTP_SECURE` env vars** — optional SMTP fallback for first-run

### Changed
- **Topbar grows vertically** when logo or dashboard pills overflow — wraps instead of clipping
- **Omada response time** now measures controller API latency instead of broken LAN ping (private IPs aren't routable from monitoring server)
- **Webhook URL field** accepts email addresses when format is set to Email; auto-detect recognizes email patterns
- **Caddy setup example** in group form — removed TLS cert paths

### Fixed
- **Admin user form** now fetches fresh group list every time so newly-created dashboards show up in the picker
- **Response time chart** filtered out 0ms values as falsy — now treats 0 and `<1ms` as valid data
- **Sub-1ms ping precision** — keeps one decimal (e.g. `0.3ms`) instead of rounding to 0
- **Dead `ADMIN_USERNAME`/`ADMIN_PASSWORD` env vars** removed from server.js, docker-compose example, and README

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
