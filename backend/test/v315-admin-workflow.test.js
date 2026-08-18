"use strict";
const { test } = require("node:test");
const assert   = require("node:assert/strict");
const fs       = require("node:fs");
const path     = require("node:path");

const ROOT         = path.resolve(__dirname, "..");
const serverSource = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const adminSource  = fs.readFileSync(path.join(ROOT, "views", "admin.ejs"), "utf8");

function sourceBetween(start, end) {
  const si = serverSource.indexOf(start);
  if (si === -1) throw new Error(`Start marker not found: ${start}`);
  const ei = serverSource.indexOf(end, si);
  if (ei === -1) throw new Error(`End marker not found after start: ${end}`);
  return serverSource.slice(si, ei);
}

// ── Backend: quick-status PATCH endpoint ──────────────────────────────────────

test("PATCH /api/admin/servers/:id/status endpoint exists", () => {
  assert.match(serverSource, /app\.patch\(["']\/api\/admin\/servers\/:id\/status["']/);
});

test("quick-status endpoint requires manager or admin", () => {
  const route = sourceBetween(
    'app.patch("/api/admin/servers/:id/status"',
    "// -- User Management"
  );
  assert.match(route, /requireManager/);
});

test("quick-status endpoint validates status to up|degraded|down", () => {
  const route = sourceBetween(
    'app.patch("/api/admin/servers/:id/status"',
    "// -- User Management"
  );
  assert.match(route, /\["up","degraded","down"\]\.includes\(status\)/);
});

test("quick-status endpoint updates serverStatus in memory", () => {
  const route = sourceBetween(
    'app.patch("/api/admin/servers/:id/status"',
    "// -- User Management"
  );
  assert.match(route, /serverStatus\[def\.id\]/);
  assert.match(route, /overall.*status/);
});

test("quick-status endpoint broadcasts via SSE", () => {
  const route = sourceBetween(
    'app.patch("/api/admin/servers/:id/status"',
    "// -- User Management"
  );
  assert.match(route, /sseClients/);
});

test("quick-status endpoint records an audit log entry", () => {
  const route = sourceBetween(
    'app.patch("/api/admin/servers/:id/status"',
    "// -- User Management"
  );
  assert.match(route, /addAuditLog/);
  assert.match(route, /server\.status/);
});

// ── Backend: bulk status action ───────────────────────────────────────────────

test("bulk endpoint accepts status action", () => {
  const route = sourceBetween(
    'app.post("/api/admin/servers/bulk"',
    'app.patch("/api/admin/servers/:id/status"'
  );
  assert.match(route, /"status"/);
  assert.match(route, /ACTIONS.*status|status.*ACTIONS/);
});

test("bulk status action validates status value", () => {
  const route = sourceBetween(
    'app.post("/api/admin/servers/bulk"',
    'app.patch("/api/admin/servers/:id/status"'
  );
  assert.match(route, /action === "status"/);
  assert.match(route, /\["up","degraded","down"\]\.includes\(status\)/);
});

test("bulk status action updates serverStatus for each id", () => {
  const route = sourceBetween(
    'app.post("/api/admin/servers/bulk"',
    'app.patch("/api/admin/servers/:id/status"'
  );
  assert.match(route, /serverStatus\[id\]/);
});

// ── Frontend: spotlight / ⌘K search ──────────────────────────────────────────

test("spotlight overlay HTML is present", () => {
  assert.match(adminSource, /id="spotlightOverlay"/);
  assert.match(adminSource, /id="spotlightInput"/);
  assert.match(adminSource, /id="spotlightResults"/);
});

test("openSpotlight function exists", () => {
  assert.match(adminSource, /function openSpotlight\(\)/);
});

test("closeSpotlight function exists", () => {
  assert.match(adminSource, /function closeSpotlight\(\)/);
});

test("renderSpotlight function searches servers and groups", () => {
  assert.match(adminSource, /function renderSpotlight\(\)/);
  assert.match(adminSource, /adminServers/);
  assert.match(adminSource, /adminGroups/);
});

test("Cmd+K / Ctrl+K keyboard shortcut opens spotlight", () => {
  assert.match(adminSource, /metaKey.*ctrlKey.*key.*["']k["']|ctrlKey.*metaKey.*key.*["']k["']/);
  assert.match(adminSource, /openSpotlight\(\)/);
});

test("spotlight search button in topbar", () => {
  assert.match(adminSource, /id="spotlightBtn"/);
  assert.match(adminSource, /onclick="openSpotlight\(\)"/);
});

test("spotlight keyboard navigation functions exist", () => {
  assert.match(adminSource, /function spotlightKey\(/);
  assert.match(adminSource, /ArrowDown/);
  assert.match(adminSource, /ArrowUp/);
});

test("spotlightSelect navigates to server or group", () => {
  assert.match(adminSource, /function spotlightSelect\(/);
  assert.match(adminSource, /showServerForm/);
  assert.match(adminSource, /openManagementTab.*groups/);
});

// ── Frontend: inline status dot popover ──────────────────────────────────────

test("status popover singleton HTML exists", () => {
  assert.match(adminSource, /id="statusPopover"/);
  assert.match(adminSource, /applyQuickStatus\('up'\)/);
  assert.match(adminSource, /applyQuickStatus\('degraded'\)/);
  assert.match(adminSource, /applyQuickStatus\('down'\)/);
});

test("openStatusPopover function exists", () => {
  assert.match(adminSource, /function openStatusPopover\(/);
});

test("applyQuickStatus calls PATCH endpoint", () => {
  assert.match(adminSource, /function applyQuickStatus\(/);
  assert.match(adminSource, /\/api\/admin\/servers\/.*\/status/);
  assert.match(adminSource, /method.*PATCH/);
});

test("server row dot is clickable for managers", () => {
  assert.match(adminSource, /admin-dot clickable/);
  assert.match(adminSource, /openStatusPopover/);
  assert.match(adminSource, /isManager\(\)/);
});

// ── Frontend: bulk status dropdown ────────────────────────────────────────────

test("bulk status submenu HTML exists", () => {
  assert.match(adminSource, /id="bulkStatusMenu"/);
  assert.match(adminSource, /bulkStatusAction\('up'\)/);
  assert.match(adminSource, /bulkStatusAction\('down'\)/);
});

test("toggleBulkStatusMenu function exists", () => {
  assert.match(adminSource, /function toggleBulkStatusMenu\(/);
});

test("bulkStatusAction sends status to bulk endpoint", () => {
  assert.match(adminSource, /function bulkStatusAction\(/);
  assert.match(adminSource, /action.*status.*status|action:.*"status"/);
  assert.match(adminSource, /\/api\/admin\/servers\/bulk/);
});
