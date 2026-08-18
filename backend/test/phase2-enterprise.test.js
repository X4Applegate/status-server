"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const adminSource = fs.readFileSync(path.join(__dirname, "..", "views", "admin.ejs"), "utf8");
const indexSource = fs.readFileSync(path.join(__dirname, "..", "views", "index.ejs"), "utf8");

function sourceBetween(startMarker, endMarker) {
  const start = serverSource.indexOf(startMarker);
  const end = serverSource.indexOf(endMarker, start);
  assert.notEqual(start, -1, `expected start marker: ${startMarker}`);
  assert.notEqual(end, -1, `expected end marker: ${endMarker}`);
  return serverSource.slice(start, end);
}

// -- SLA Target --

test("sla_target is included in the server INSERT SQL", () => {
  const route = sourceBetween(
    'app.post("/api/admin/servers"',
    'app.put("/api/admin/servers/:id"',
  );
  assert.match(route, /sla_target.*\) VALUES|sla_target, enabled\) VALUES/);
  assert.match(route, /slaTarget/);
});

test("sla_target is included in the server UPDATE SQL", () => {
  const route = sourceBetween(
    'app.put("/api/admin/servers/:id"',
    'app.delete("/api/admin/servers/:id"',
  );
  assert.match(route, /sla_target=\?/);
  assert.match(route, /slaTarget/);
});

test("sla_target input is clamped to 0–100 on both POST and PUT", () => {
  const clampPattern = /Math\.max\(0,\s*Math\.min\(100,\s*parseFloat\(/;
  const postRoute = sourceBetween(
    'app.post("/api/admin/servers"',
    'app.put("/api/admin/servers/:id"',
  );
  const putRoute = sourceBetween(
    'app.put("/api/admin/servers/:id"',
    'app.delete("/api/admin/servers/:id"',
  );
  assert.match(postRoute, clampPattern, "POST must clamp sla_target to 0–100");
  assert.match(putRoute, clampPattern, "PUT must clamp sla_target to 0–100");
});

// -- SLA Dashboard endpoint --

test("GET /api/admin/sla exists and requires admin authentication", () => {
  assert.match(serverSource, /app\.get\("\/api\/admin\/sla",\s*requireAdmin/);
});

test("SLA endpoint uses conditional aggregation for 24h/7d/30d windows", () => {
  const route = sourceBetween(
    'app.get("/api/admin/sla"',
    'app.get("/api/admin/api-keys"',
  );
  assert.match(route, /CASE WHEN h\.checked_at >= DATE_SUB\(NOW\(\), INTERVAL 24 HOUR\)/);
  assert.match(route, /CASE WHEN h\.checked_at >= DATE_SUB\(NOW\(\), INTERVAL 7\s+DAY\)/);
  assert.match(route, /LEFT JOIN status_history/);
  assert.match(route, /GROUP BY s\.id/);
});

// -- Per-group Custom CSS --

test("custom_css sanitizes closing style tags before storage", () => {
  const postRoute = sourceBetween(
    'app.post("/api/admin/groups"',
    'app.put("/api/admin/groups/:id"',
  );
  const putRoute = sourceBetween(
    'app.put("/api/admin/groups/:id"',
    'app.delete("/api/admin/groups/:id"',
  );
  const sanitizePattern = /replace\(\/<\\\/style>/;
  assert.match(postRoute, sanitizePattern, "POST must strip </style> from custom_css");
  assert.match(putRoute, sanitizePattern, "PUT must strip </style> from custom_css");
});

test("custom_css is included in the group INSERT SQL", () => {
  const route = sourceBetween(
    'app.post("/api/admin/groups"',
    'app.put("/api/admin/groups/:id"',
  );
  assert.match(route, /custom_css\) VALUES/);
  assert.match(route, /cleanCustomCss\]/);
});

test("custom_css is included in the group UPDATE SQL", () => {
  const route = sourceBetween(
    'app.put("/api/admin/groups/:id"',
    'app.delete("/api/admin/groups/:id"',
  );
  assert.match(route, /custom_css=\?/);
  assert.match(route, /cleanCustomCss/);
});

test("customCss is passed to all public status page renders", () => {
  const count = (serverSource.match(/customCss:\s*g\.custom_css/g) || []).length;
  assert.ok(count >= 3, `expected at least 3 public render calls to pass customCss, found ${count}`);
});

// -- Public page injection --

test("public index.ejs injects custom CSS inside a conditional style block", () => {
  assert.match(indexSource, /group-custom-css/);
  assert.match(indexSource, /typeof customCss !== 'undefined' && customCss/);
  assert.match(indexSource, /<%- customCss %>/);
});

// -- Delete from edit form --

test("server form has a delete button that calls askDelFromForm", () => {
  assert.match(adminSource, /id="fDeleteBtn"/);
  assert.match(adminSource, /class="btn btn-danger"[^>]*id="fDeleteBtn"|id="fDeleteBtn"[^>]*class="btn btn-danger"/);
  assert.match(adminSource, /onclick="askDelFromForm\(\)"/);
});

test("askDelFromForm reads the form ID and delegates to askDel", () => {
  assert.match(adminSource, /function askDelFromForm\(\)/);
  assert.match(adminSource, /document\.getElementById\("fId"\)\.value/);
  assert.match(adminSource, /askDel\(/);
});

test("doDelete navigates back to the server list using showList", () => {
  const deleteStart = adminSource.indexOf("async function doDelete()");
  assert.notEqual(deleteStart, -1, "doDelete must exist");
  const deleteEnd = adminSource.indexOf("\n}", deleteStart);
  const deleteBody = adminSource.slice(deleteStart, deleteEnd);
  assert.match(deleteBody, /await showList\(\)/, "doDelete must call showList() not loadServerList()");
  assert.doesNotMatch(deleteBody, /loadServerList\(\)/, "doDelete must not call loadServerList() — it leaves the form open");
});

// -- Content Security Policy --

test("helmet CSP is enabled with object-src none and frame-ancestors none", () => {
  assert.doesNotMatch(serverSource, /contentSecurityPolicy:\s*false/, "CSP must not be disabled");
  assert.match(serverSource, /objectSrc:\s*\["'none'"\]/, "objectSrc must be 'none' to block plugin execution");
  assert.match(serverSource, /frameAncestors:\s*\["'none'"\]/, "frameAncestors must be 'none' to prevent clickjacking");
});

test("CSP allowlists all known external script and style origins", () => {
  const cspSection = sourceBetween("app.use(helmet({", "// Rate limiters");
  assert.match(cspSection, /challenges\.cloudflare\.com/);
  assert.match(cspSection, /fonts\.googleapis\.com/);
  assert.match(cspSection, /fonts\.gstatic\.com/);
  assert.match(cspSection, /unpkg\.com/);
});
