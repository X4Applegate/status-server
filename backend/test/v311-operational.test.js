"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("node:fs");
const path   = require("node:path");

const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const adminSource  = fs.readFileSync(path.join(__dirname, "..", "views", "admin.ejs"), "utf8");
const indexSource  = fs.readFileSync(path.join(__dirname, "..", "views", "index.ejs"), "utf8");
const serializerSource = fs.readFileSync(path.join(__dirname, "..", "public-status-serializer.js"), "utf8");

function sourceBetween(startMarker, endMarker) {
  const start = serverSource.indexOf(startMarker);
  const end   = serverSource.indexOf(endMarker, start);
  assert.notEqual(start, -1, `expected start: ${startMarker}`);
  assert.notEqual(end,   -1, `expected end:   ${endMarker}`);
  return serverSource.slice(start, end);
}

// -- Monitoring pause (enabled column) --

test("enabled column is added to status_servers schema", () => {
  assert.match(serverSource, /ALTER TABLE status_servers ADD COLUMN enabled TINYINT\(1\) NOT NULL DEFAULT 1/);
});

test("enabled field is carried from DB rows into serverConfig", () => {
  const configBlock = sourceBetween("serverConfig = rows.map", "serverConfig.forEach");
  assert.match(configBlock, /enabled.*r\.enabled/);
});

test("serverStatus initialisation includes enabled and flapping fields", () => {
  assert.match(serverSource, /flapping:false,\s*enabled:s\.enabled/);
});

test("pollAll skips servers where enabled is false", () => {
  const pollBlock = sourceBetween("async function pollAll", 'app.get("/api/admin/servers"');
  assert.match(pollBlock, /def\.enabled !== false/);
});

test("enabled is included in the server INSERT SQL", () => {
  const route = sourceBetween('app.post("/api/admin/servers"', 'app.put("/api/admin/servers/:id"');
  assert.match(route, /enabled\) VALUES/);
});

test("enabled is included in the server UPDATE SQL", () => {
  const route = sourceBetween('app.put("/api/admin/servers/:id"', 'app.delete("/api/admin/servers/:id"');
  assert.match(route, /enabled=\?/);
});

test("enabled toggle exists in the server edit form", () => {
  assert.match(adminSource, /id="fEnabled"/);
  assert.match(adminSource, /id="fEnabledWrap"/);
  assert.match(adminSource, /fEnabledWrap.*display.*isAdmin\(\)/);
});

test("submitForm sends enabled value", () => {
  const submitBlock = adminSource.slice(adminSource.indexOf("async function submitForm"));
  assert.match(submitBlock, /enabled:.*isAdmin\(\).*fEnabled.*checked/);
});

// -- Bulk server actions --

test("POST /api/admin/servers/bulk exists and requires admin", () => {
  assert.match(serverSource, /app\.post\("\/api\/admin\/servers\/bulk",\s*requireAdmin/);
});

test("bulk endpoint supports enable, disable, delete, and move actions", () => {
  const route = sourceBetween(
    'app.post("/api/admin/servers/bulk"',
    "// -- User Management",
  );
  assert.match(route, /action === "enable"/);
  assert.match(route, /action === "disable"/);
  assert.match(route, /action === "delete"/);
  assert.match(route, /action === "move"/);
});

test("bulk endpoint clamps ids to valid strings before running queries", () => {
  const route = sourceBetween(
    'app.post("/api/admin/servers/bulk"',
    "// -- User Management",
  );
  assert.match(route, /safeIds.*ids\.filter/);
});

test("admin server list has checkbox inputs for bulk selection", () => {
  assert.match(adminSource, /class="srv-select-cb"/);
  assert.match(adminSource, /toggleBulkSelect/);
});

test("bulk action bar is rendered in the admin panel", () => {
  assert.match(adminSource, /id="bulkBar"/);
  assert.match(adminSource, /bulkAction\('enable'\)/);
  assert.match(adminSource, /bulkAction\('disable'\)/);
  assert.match(adminSource, /bulkAction\('delete'\)/);
});

test("clearBulkSelect is called when switching tabs", () => {
  const switchBlock = adminSource.slice(adminSource.indexOf("async function switchTab"));
  assert.match(switchBlock, /clearBulkSelect\(\)/);
});

// -- Flap detection --

test("countFlips helper is defined in server.js", () => {
  assert.match(serverSource, /function countFlips\(history,\s*window\)/);
  assert.match(serverSource, /if \(w\[i\] !== w\[i\s*[-–]\s*1\]\)/);
});

test("flapping is computed in pollAll using countFlips", () => {
  const pollBlock = sourceBetween("async function pollAll", 'app.get("/api/admin/servers"');
  assert.match(pollBlock, /const flapping\s*=.*countFlips/);
  assert.match(pollBlock, /history\.length >= 6/);
});

test("downward alerts are suppressed when a service is flapping", () => {
  const pollBlock = sourceBetween("async function pollAll", 'app.get("/api/admin/servers"');
  assert.match(pollBlock, /else if \(flapping\)/);
  assert.match(pollBlock, /} else if \(isDownward\)/);
});

test("flapping is stored in serverStatus", () => {
  assert.match(serverSource, /serverStatus\[def\.id\].*flapping,/);
});

test("anonymous serializer exposes flapping field", () => {
  assert.match(serializerSource, /flapping:.*source\.flapping/);
});

test("public index.ejs shows Unstable badge for flapping services", () => {
  assert.match(indexSource, /s\.flapping.*Unstable|flapping.*"Unstable"/);
});

// -- Uptime sparklines (90 checks) --

test("pollAll accumulates 90-check uptime history", () => {
  const pollBlock = sourceBetween("async function pollAll", 'app.get("/api/admin/servers"');
  assert.match(pollBlock, /slice\(-90\)/);
  assert.doesNotMatch(pollBlock, /slice\(-20\)/);
});

test("seed query loads 2 days of history (not just 1 hour)", () => {
  const seedBlock = sourceBetween("Seed uptime history", "} catch(err) {");
  assert.match(seedBlock, /INTERVAL 2 DAY/);
  assert.doesNotMatch(seedBlock, /INTERVAL 1 HOUR/);
});

test("public status page calculates uptime dots from 90 checks", () => {
  assert.match(indexSource, /Math\.max\(0,\s*90\s*-\s*hb\.length\)/);
  assert.match(indexSource, /Math\.min\(90,\s*hb\.length\)/);
  assert.match(indexSource, /of 90 probes/);
});
