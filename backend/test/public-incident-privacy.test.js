"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

function extractFunction(name) {
  const match = serverSource.match(new RegExp(`function ${name}\\(req\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(match, `expected server.js to define ${name}`);
  return vm.runInNewContext(`(${match[0]})`);
}

test("private incidents are visible only to authenticated administrators", () => {
  const canViewPrivateIncidents = extractFunction("canViewPrivateIncidents");

  assert.equal(canViewPrivateIncidents({}), false);
  assert.equal(canViewPrivateIncidents({ session: { role: "admin" } }), false);
  assert.equal(canViewPrivateIncidents({ session: { userId: 7, role: "viewer" } }), false);
  assert.equal(canViewPrivateIncidents({ session: { userId: 7, role: "admin" } }), true);
});

test("the per-server public incident query enforces the visibility decision", () => {
  const routeStart = serverSource.indexOf('app.get("/api/public/incidents/:id"');
  const routeEnd = serverSource.indexOf("\nasync function getPublicIncidentFeed", routeStart);

  assert.notEqual(routeStart, -1, "expected the public incident route");
  assert.notEqual(routeEnd, -1, "expected the public incident route boundary");

  const route = serverSource.slice(routeStart, routeEnd);
  assert.match(route, /const includePrivate = canViewPrivateIncidents\(req\)/);
  assert.match(route, /WHERE server_id=\? AND \(public=1 OR \?=1\)/);
  assert.match(route, /\[req\.params\.id, includePrivate \? 1 : 0\]/);
  assert.match(route, /const ids = rows\.map\(r => r\.id\)/, "updates must be queried only for visible incidents");
});

test("the authenticated admin incident feed hides private incidents from viewers", () => {
  const routeStart = serverSource.indexOf('app.get("/api/admin/incidents"');
  const routeEnd = serverSource.indexOf('app.put("/api/admin/incidents/:id"', routeStart);
  assert.notEqual(routeStart, -1, "expected the admin incident feed");
  assert.notEqual(routeEnd, -1, "expected the admin incident mutation route");
  const route = serverSource.slice(routeStart, routeEnd);
  assert.match(route, /if \(req\.session\.role !== "admin"\)/);
  assert.match(route, /WHERE i\.public=1 AND m\.group_id IN \(\?\)/);
  assert.match(route, /updatesByIncident\[r\.id\] \|\| \[\]/, "updates must be attached only after incidents are filtered");
});

test("uptime counts poll cycles and marks a cycle down when any check fails", () => {
  const routeStart = serverSource.indexOf('app.get("/api/public/uptime/:id"');
  const routeEnd = serverSource.indexOf('app.get("/api/public/response/:id"', routeStart);

  assert.notEqual(routeStart, -1, "expected the public uptime route");
  assert.notEqual(routeEnd, -1, "expected the next public route boundary");

  const route = serverSource.slice(routeStart, routeEnd);
  assert.match(route, /SELECT COUNT\(\*\) AS total, COALESCE\(SUM\(cycle_ok\), 0\) AS up_count/);
  assert.match(route, /SELECT MIN\(ok\) AS cycle_ok/);
  assert.match(route, /GROUP BY checked_at/);
  assert.match(route, /FROM status_history/);
  assert.match(route, /\[id, hours\]/);
});

test("anonymous heartbeat responses omit internal probe details", () => {
  const canViewInternalProbeDetails = extractFunction("canViewInternalProbeDetails");
  assert.equal(canViewInternalProbeDetails({}), false);
  assert.equal(canViewInternalProbeDetails({ session: { role: "viewer" } }), false);
  assert.equal(canViewInternalProbeDetails({ session: { userId: 7, role: "viewer" } }), true);
  assert.equal(canViewInternalProbeDetails({ session: { userId: 7, role: "admin" } }), true);

  const routeStart = serverSource.indexOf('app.get("/api/public/heartbeat/:id"');
  const routeEnd = serverSource.indexOf('app.get("/api/public/incidents/:id"', routeStart);
  const route = serverSource.slice(routeStart, routeEnd);
  assert.match(route, /const includeDetails = canViewInternalProbeDetails\(req\)/);
  assert.match(route, /if \(includeDetails\) heartbeat\.detail = r\.detail/);
  assert.doesNotMatch(route, /detail:\s*r\.detail/);
});
