"use strict";
const { test } = require("node:test");
const assert   = require("node:assert/strict");
const fs       = require("node:fs");
const path     = require("node:path");

const ROOT         = path.resolve(__dirname, "..");
const serverSource = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const adminSource  = fs.readFileSync(path.join(ROOT, "views", "admin.ejs"), "utf8");
const indexSource  = fs.readFileSync(path.join(ROOT, "views", "index.ejs"), "utf8");

function sourceBetween(src, start, end) {
  const si = src.indexOf(start);
  if (si === -1) throw new Error(`Start marker not found: ${start}`);
  const ei = src.indexOf(end, si);
  if (ei === -1) throw new Error(`End marker not found after start: ${end}`);
  return src.slice(si, ei);
}

// ── Backend: uptime_30d on GET /api/admin/servers ─────────────────────────────

test("GET /api/admin/servers includes 30-day uptime batch query", () => {
  assert.match(serverSource, /DATE_SUB\(NOW\(\),\s*INTERVAL 30 DAY\)/);
  assert.match(serverSource, /up_count.*status_history|status_history.*up_count/s);
});

test("GET /api/admin/servers response map includes uptime_30d field", () => {
  assert.match(serverSource, /uptime_30d/);
  assert.match(serverSource, /uptimeMap/);
});

// ── Backend: POST /api/admin/incidents ───────────────────────────────────────

test("POST /api/admin/incidents endpoint exists", () => {
  assert.match(serverSource, /app\.post\(["']\/api\/admin\/incidents["']/);
});

test("POST /api/admin/incidents requires admin", () => {
  const route = sourceBetween(serverSource,
    'app.post("/api/admin/incidents",',
    'app.post("/api/admin/incidents/resolve-all"'
  );
  assert.match(route, /requireAdmin/);
});

test("POST /api/admin/incidents validates server_id presence", () => {
  const route = sourceBetween(serverSource,
    'app.post("/api/admin/incidents",',
    'app.post("/api/admin/incidents/resolve-all"'
  );
  assert.match(route, /server_id.*required|server_id required/);
});

test("POST /api/admin/incidents validates status enum", () => {
  const route = sourceBetween(serverSource,
    'app.post("/api/admin/incidents",',
    'app.post("/api/admin/incidents/resolve-all"'
  );
  assert.match(route, /investigating.*identified.*monitoring/);
});

test("POST /api/admin/incidents inserts into status_incidents", () => {
  const route = sourceBetween(serverSource,
    'app.post("/api/admin/incidents",',
    'app.post("/api/admin/incidents/resolve-all"'
  );
  assert.match(route, /INSERT INTO status_incidents/);
});

test("POST /api/admin/incidents inserts initial update", () => {
  const route = sourceBetween(serverSource,
    'app.post("/api/admin/incidents",',
    'app.post("/api/admin/incidents/resolve-all"'
  );
  assert.match(route, /INSERT INTO status_incident_updates/);
});

test("POST /api/admin/incidents records audit log", () => {
  const route = sourceBetween(serverSource,
    'app.post("/api/admin/incidents",',
    'app.post("/api/admin/incidents/resolve-all"'
  );
  assert.match(route, /addAuditLog/);
  assert.match(route, /incident\.create/);
});

// ── Backend: POST /api/admin/incidents/resolve-all ───────────────────────────

test("POST /api/admin/incidents/resolve-all endpoint exists", () => {
  assert.match(serverSource, /app\.post\(["']\/api\/admin\/incidents\/resolve-all["']/);
});

test("resolve-all requires admin", () => {
  const route = sourceBetween(serverSource,
    'app.post("/api/admin/incidents/resolve-all"',
    'app.get("/api/admin/incidents"'
  );
  assert.match(route, /requireAdmin/);
});

test("resolve-all sets ended_at and status=resolved on open incidents", () => {
  const route = sourceBetween(serverSource,
    'app.post("/api/admin/incidents/resolve-all"',
    'app.get("/api/admin/incidents"'
  );
  assert.match(route, /UPDATE status_incidents.*ended_at.*status.*resolved/s);
});

test("resolve-all returns resolved count", () => {
  const route = sourceBetween(serverSource,
    'app.post("/api/admin/incidents/resolve-all"',
    'app.get("/api/admin/incidents"'
  );
  assert.match(route, /resolved.*open\.length|resolved: open\.length/);
});

test("resolve-all records audit log with bulk action", () => {
  const route = sourceBetween(serverSource,
    'app.post("/api/admin/incidents/resolve-all"',
    'app.get("/api/admin/incidents"'
  );
  assert.match(route, /addAuditLog/);
  assert.match(route, /resolve-all/);
});

// ── Admin CSS: tag filter bar ─────────────────────────────────────────────────

test("tag-filter-bar CSS is present", () => {
  assert.match(adminSource, /\.tag-filter-bar/);
});

test("tag-pill CSS is present", () => {
  assert.match(adminSource, /\.tag-pill/);
  assert.match(adminSource, /\.tag-pill\.active/);
});

// ── Admin CSS: KPI 5 columns ──────────────────────────────────────────────────

test("admin-kpi-grid override to 5 columns is present", () => {
  assert.match(adminSource, /admin-kpi-grid.*repeat\(5,/);
});

// ── Admin HTML: tag filter bar ────────────────────────────────────────────────

test("tag filter bar HTML is injected into sidebar", () => {
  assert.match(adminSource, /id="tagFilterBar"/);
  assert.match(adminSource, /class="tag-filter-bar"/);
});

// ── Admin HTML: open incidents KPI tile ──────────────────────────────────────

test("5th KPI tile for open incidents is present", () => {
  assert.match(adminSource, /id="adminMetricOpenIncidents"/);
  assert.match(adminSource, /Open incidents/);
});

// ── Admin HTML: incident toolbar buttons ─────────────────────────────────────

test("New incident button is in incident toolbar", () => {
  assert.match(adminSource, /openNewIncidentModal\(\)/);
  assert.match(adminSource, /New incident/);
});

test("Resolve all button is in incident toolbar", () => {
  assert.match(adminSource, /resolveAllIncidents\(\)/);
  assert.match(adminSource, /Resolve all/);
});

// ── Admin HTML: new incident modal ────────────────────────────────────────────

test("new incident modal overlay exists", () => {
  assert.match(adminSource, /id="newIncidentOverlay"/);
  assert.match(adminSource, /closeNewIncidentModal\(\)/);
});

test("new incident modal has service selector", () => {
  assert.match(adminSource, /id="niServerId"/);
});

test("new incident modal has title, status, impact fields", () => {
  assert.match(adminSource, /id="niTitle"/);
  assert.match(adminSource, /id="niStatus"/);
  assert.match(adminSource, /id="niImpact"/);
});

test("new incident modal has public toggle", () => {
  assert.match(adminSource, /id="niPublic"/);
});

test("new incident modal has submit button calling submitNewIncident", () => {
  assert.match(adminSource, /submitNewIncident\(\)/);
});

// ── Admin JS: tag filter functions ────────────────────────────────────────────

test("buildTagFilterBar function exists", () => {
  assert.match(adminSource, /function buildTagFilterBar\(\)/);
});

test("filterTagToggle function exists", () => {
  assert.match(adminSource, /function filterTagToggle\(/);
});

test("renderSidebarList applies tag filter", () => {
  assert.match(adminSource, /_activeTagFilter/);
  assert.match(adminSource, /\.includes\(_activeTagFilter\)/);
});

test("renderSidebarList shows uptime_30d badge", () => {
  assert.match(adminSource, /uptime_30d/);
  assert.match(adminSource, /srv-uptime/);
});

// ── Admin JS: incident functions ──────────────────────────────────────────────

test("openNewIncidentModal function exists", () => {
  assert.match(adminSource, /function openNewIncidentModal\(\)/);
});

test("closeNewIncidentModal function exists", () => {
  assert.match(adminSource, /function closeNewIncidentModal\(\)/);
});

test("submitNewIncident POSTs to /api/admin/incidents", () => {
  assert.match(adminSource, /function submitNewIncident\(\)/);
  assert.match(adminSource, /\/api\/admin\/incidents/);
  assert.match(adminSource, /method.*POST/);
});

test("resolveAllIncidents POSTs to /api/admin/incidents/resolve-all", () => {
  assert.match(adminSource, /function resolveAllIncidents\(\)/);
  assert.match(adminSource, /\/api\/admin\/incidents\/resolve-all/);
});

// ── Admin JS: open incidents KPI update ──────────────────────────────────────

test("adminMetricOpenIncidents is updated from incident list", () => {
  assert.match(adminSource, /adminMetricOpenIncidents/);
  assert.match(adminSource, /openCount/);
});

// ── Public page: animations ───────────────────────────────────────────────────

test("all-up banner glow animation keyframe exists", () => {
  assert.match(indexSource, /allUpGlow/);
});

test("overview-live-dot pulsing animation added", () => {
  assert.match(indexSource, /liveDotPulse/);
  assert.match(indexSource, /\.overview-live-dot.*animation/);
});

test("status-overview.all-up::before uses allUpGlow animation", () => {
  assert.match(indexSource, /all-up.*before.*allUpGlow|allUpGlow.*all-up/);
});

test("service card colored left border by status exists", () => {
  assert.match(indexSource, /data-status.*down.*border-left-color.*red|data-status="down".*border-left/);
  assert.match(indexSource, /data-status.*degraded.*border-left|data-status="degraded".*border-left/);
});
