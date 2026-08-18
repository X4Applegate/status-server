"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const serverSource     = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const adminSource      = fs.readFileSync(path.join(__dirname, "..", "views", "admin.ejs"), "utf8");
const serializerSource = fs.readFileSync(path.join(__dirname, "..", "public-status-serializer.js"), "utf8");

function sourceBetween(startMarker, endMarker) {
  const start = serverSource.indexOf(startMarker);
  const end   = serverSource.indexOf(endMarker, start);
  assert.notEqual(start, -1, `expected start: ${startMarker}`);
  assert.notEqual(end,   -1, `expected end:   ${endMarker}`);
  return serverSource.slice(start, end);
}

// -- Response time tracking --

test("response_ms is extracted from checks and stored in serverStatus", () => {
  const pollBlock = sourceBetween("async function pollAll", 'app.get("/api/admin/servers"');
  assert.match(pollBlock, /const response_ms\s*=\s*checks\.find/);
  assert.match(pollBlock, /response_ms != null/);
});

test("serverStatus assignment includes response_ms", () => {
  assert.match(serverSource, /serverStatus\[def\.id\]\s*=\s*\{[^}]*response_ms/);
});

test("admin server API response includes response_ms from serverStatus", () => {
  const adminApiBlock = sourceBetween('app.get("/api/admin/servers"', 'app.post("/api/admin/servers"');
  assert.match(adminApiBlock, /response_ms:\s*serverStatus/);
});

test("public serializer exposes response_ms", () => {
  assert.match(serializerSource, /response_ms:\s*publicLatency\(source\.response_ms\)/);
});

test("admin list renders latency badge from response_ms", () => {
  assert.match(adminSource, /chip-ms/);
  assert.match(adminSource, /s\.response_ms/);
  assert.match(adminSource, /ms-fast.*ms-med.*ms-slow|ms-fast|ms-med|ms-slow/);
});

// -- Incident auto-resolution --

test("autoResolveIncidents helper function is defined", () => {
  assert.match(serverSource, /async function autoResolveIncidents\(serverId/);
});

test("autoResolveIncidents queries open incidents and marks them resolved", () => {
  const fn = sourceBetween("async function autoResolveIncidents", "const _lastPolled");
  assert.match(fn, /status NOT IN.*resolved/);
  assert.match(fn, /INSERT INTO status_incident_updates/);
  assert.match(fn, /UPDATE status_incidents.*SET status='resolved'/);
});

test("autoResolveIncidents is called on service recovery", () => {
  const recoveryBlock = sourceBetween("if (isRecovery && !inMaintenance)", "const response_ms");
  assert.match(recoveryBlock, /autoResolveIncidents\(def\.id/);
});

// -- Alert quiet hours --

test("alertQuietStart and alertQuietEnd variables are declared", () => {
  assert.match(serverSource, /let alertQuietStart\s*=\s*-1/);
  assert.match(serverSource, /let alertQuietEnd\s*=\s*-1/);
});

test("isInQuietHours helper is defined and handles overnight spans", () => {
  const fn = sourceBetween("function isInQuietHours()", "async function loadAlertQuietHoursFromDb");
  assert.match(fn, /alertQuietStart < 0.*return false/);
  assert.match(fn, /alertQuietStart > alertQuietEnd/);
});

test("loadAlertQuietHoursFromDb loads quiet hours from status_settings", () => {
  const fn = sourceBetween("async function loadAlertQuietHoursFromDb", "// -- SMTP config");
  assert.match(fn, /alert_quiet_start.*alert_quiet_end/);
  assert.match(fn, /alertQuietStart\s*=/);
});

test("loadAlertQuietHoursFromDb is called on startup", () => {
  assert.match(serverSource, /await loadAlertQuietHoursFromDb\(\)/);
});

test("fireWebhooks suppresses downward alerts during quiet hours", () => {
  const fn = sourceBetween("async function fireWebhooks(evt)", "let hooks;");
  assert.match(fn, /isInQuietHours\(\)/);
  assert.match(fn, /!evt\.isRecovery/);
});

test("fireSubscriberEmails respects quiet hours for downward alerts", () => {
  const fn = sourceBetween("async function fireSubscriberEmails(evt)", "async function autoResolveIncidents");
  assert.match(fn, /isInQuietHours\(\)/);
  assert.match(fn, /!evt\.isRecovery/);
});

test("GET and POST /api/admin/settings/alert-quiet-hours endpoints exist", () => {
  assert.match(serverSource, /app\.get\("\/api\/admin\/settings\/alert-quiet-hours"/);
  assert.match(serverSource, /app\.post\("\/api\/admin\/settings\/alert-quiet-hours"/);
});

test("quiet hours UI section is rendered in admin settings", () => {
  assert.match(adminSource, /Alert Quiet Hours/);
  assert.match(adminSource, /setQhEnabled/);
  assert.match(adminSource, /setQhStart/);
  assert.match(adminSource, /setQhEnd/);
  assert.match(adminSource, /saveQuietHours\(\)/);
});

// -- Service reorder --

test("POST /api/admin/servers/reorder endpoint exists and requires admin", () => {
  assert.match(serverSource, /app\.post\("\/api\/admin\/servers\/reorder",\s*requireAdmin/);
});

test("reorder endpoint validates direction and swaps sort_order values", () => {
  const route = sourceBetween(
    'app.post("/api/admin/servers/reorder"',
    '// Bulk server actions'
  );
  assert.match(route, /direction.*up.*down|up.*down.*direction/);
  assert.match(route, /sort_order/);
  assert.match(route, /UPDATE status_servers SET sort_order/);
});

test("admin list renders reorder up/down buttons", () => {
  assert.match(adminSource, /reorder-btn/);
  assert.match(adminSource, /reorderServer\(.*'up'\)/);
  assert.match(adminSource, /reorderServer\(.*'down'\)/);
});

test("reorderServer function fetches /api/admin/servers/reorder", () => {
  const fn = adminSource.slice(adminSource.indexOf("async function reorderServer"));
  assert.match(fn, /\/api\/admin\/servers\/reorder/);
  assert.match(fn, /loadServerList\(\)/);
});
