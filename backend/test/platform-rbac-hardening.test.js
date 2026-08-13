"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

function sourceBetween(startMarker, endMarker) {
  const start = serverSource.indexOf(startMarker);
  const end = serverSource.indexOf(endMarker, start);
  assert.notEqual(start, -1, `expected ${startMarker}`);
  assert.notEqual(end, -1, `expected boundary ${endMarker}`);
  return serverSource.slice(start, end);
}

const reconcileSource = sourceBetween(
  "function reconcileViewerManagedGroupIds(",
  "\nfunction viewerHasInaccessibleGroupMappings(",
);
const reconcileViewerManagedGroupIds = vm.runInNewContext(`(${reconcileSource.trim()})`);

const inaccessibleSource = sourceBetween(
  "function viewerHasInaccessibleGroupMappings(",
  "\nfunction scopeGroupMappingsForViewer(",
);
const viewerHasInaccessibleGroupMappings = vm.runInNewContext(`(${inaccessibleSource.trim()})`);

const scopeSource = sourceBetween(
  "function scopeGroupMappingsForViewer(",
  "\n\n// -- Settings",
);
const scopeGroupMappingsForViewer = vm.runInNewContext(`(${scopeSource.trim()})`);

test("viewer group reconciliation preserves mappings outside the viewer scope", () => {
  const result = reconcileViewerManagedGroupIds([1, 2], [1, 3], [1, 3], true);

  assert.equal(result.ok, true);
  assert.deepEqual([...result.groupIds], [1, 3, 2]);
});

test("viewer group reconciliation rejects inaccessible and malformed submissions", () => {
  const inaccessible = reconcileViewerManagedGroupIds([1, 2], [1, 2], [1], true);
  assert.equal(inaccessible.ok, false);
  assert.equal(inaccessible.status, 403);

  const malformed = reconcileViewerManagedGroupIds([1], ["not-a-group"], [1], true);
  assert.equal(malformed.ok, false);
  assert.equal(malformed.status, 400);

  const empty = reconcileViewerManagedGroupIds([1, 2], [], [1], true);
  assert.equal(empty.ok, false);
  assert.equal(empty.status, 400);
});

test("omitted viewer group assignments remain unchanged", () => {
  const result = reconcileViewerManagedGroupIds([1, 2], undefined, [1], true);
  assert.equal(result.ok, true);
  assert.deepEqual([...result.groupIds], [1, 2]);
});

test("shared-resource deletion detects mappings outside viewer scope", () => {
  assert.equal(viewerHasInaccessibleGroupMappings([1, 2], [1]), true);
  assert.equal(viewerHasInaccessibleGroupMappings([1, 3], [1, 3]), false);
  assert.equal(viewerHasInaccessibleGroupMappings([], [1]), false);
});

test("viewer list scoping exposes only accessible mappings and a shared marker", () => {
  const shared = scopeGroupMappingsForViewer([1, 2, 3], [1, 3]);
  assert.deepEqual([...shared.groupIds], [1, 3]);
  assert.equal(shared.sharedOutsideScope, true);

  const privateToViewer = scopeGroupMappingsForViewer([7, 8], [1, 2]);
  assert.deepEqual([...privateToViewer.groupIds], []);
  assert.equal(privateToViewer.sharedOutsideScope, true);

  const fullyVisible = scopeGroupMappingsForViewer([1, 3], [1, 3]);
  assert.deepEqual([...fullyVisible.groupIds], [1, 3]);
  assert.equal(fullyVisible.sharedOutsideScope, false);
});

test("viewer UniFi listing excludes ungrouped controllers", () => {
  const route = sourceBetween(
    'app.get("/api/admin/unifi-controllers"',
    'app.post("/api/admin/unifi-controllers"',
  );
  assert.match(route, /filter\(r => r\.group_ids\.some\(/);
  assert.doesNotMatch(route, /!r\.group_ids\.length/);
  assert.match(route, /delete viewerSafe\.group_id/, "legacy group_id must not leak an out-of-scope mapping");
});

test("integration mutations preserve inaccessible mappings and constrain deletion", () => {
  for (const [kind, putStart, deleteStart, nextRoute] of [
    ["Omada", 'app.put("/api/admin/omada-controllers/:id"', 'app.delete("/api/admin/omada-controllers/:id"', 'app.get("/api/admin/omada-controllers/:id/sites"'],
    ["UniFi", 'app.put("/api/admin/unifi-controllers/:id"', 'app.delete("/api/admin/unifi-controllers/:id"', 'app.get("/api/admin/unifi-controllers/:id/sites"'],
    ["Square", 'app.put("/api/admin/square-accounts/:id"', 'app.delete("/api/admin/square-accounts/:id"', "// ── Maintenance Windows"],
  ]) {
    const putRoute = sourceBetween(putStart, deleteStart);
    const deleteRoute = sourceBetween(deleteStart, nextRoute);
    assert.match(putRoute, /reconcileViewerManagedGroupIds\(/, `${kind} PUT must reconcile viewer mappings`);
    assert.match(putRoute, /viewerHasInaccessibleGroupMappings\(/, `${kind} PUT must block edits to shared out-of-scope resources`);
    assert.ok(
      putRoute.indexOf("viewerHasInaccessibleGroupMappings(") < putRoute.indexOf("UPDATE status_"),
      `${kind} PUT must reject the viewer before mutating shared configuration`,
    );
    assert.match(deleteRoute, /viewerHasInaccessibleGroupMappings\(/, `${kind} DELETE must protect inaccessible mappings`);
  }
});

test("viewer integration listings redact mappings outside viewer scope", () => {
  for (const [kind, getStart, nextRoute] of [
    ["Omada", 'app.get("/api/admin/omada-controllers"', 'app.post("/api/admin/omada-controllers"'],
    ["UniFi", 'app.get("/api/admin/unifi-controllers"', 'app.post("/api/admin/unifi-controllers"'],
    ["Square", 'app.get("/api/admin/square-accounts"', 'app.post("/api/admin/square-accounts"'],
  ]) {
    const getRoute = sourceBetween(getStart, nextRoute);
    assert.match(getRoute, /scopeGroupMappingsForViewer\(/, `${kind} GET must scope viewer mappings`);
    assert.match(getRoute, /shared_outside_scope/, `${kind} GET must mark resources shared outside viewer scope`);
  }
});

test("new status pages persist their public-enabled setting", () => {
  const route = sourceBetween(
    'app.post("/api/admin/groups"',
    'app.put("/api/admin/groups/:id"',
  );
  assert.match(route, /const public_enabled = req\.body\.public_enabled \? 1 : 0/);
  assert.match(route, /terms_text, public_enabled\) VALUES/);
  assert.match(route, /terms_text \|\| null, public_enabled\]/);
});

test("webhook API accepts every format supported by the delivery pipeline", () => {
  const whitelist = '["auto","generic","discord","slack","email","teams","telegram","pushover","ntfy"]';
  assert.equal(serverSource.split(whitelist).length - 1, 2, "POST and PUT must share the complete format whitelist");

  const requiredFormats = ["teams", "telegram", "pushover", "ntfy"];
  for (const format of requiredFormats) {
    assert.match(serverSource, new RegExp(`if \\(format === "${format}"\\)`), `${format} must have a payload builder`);
  }

  const testRoute = sourceBetween(
    'app.post("/api/admin/webhooks/:id/test"',
    "// -- Groups (Dashboards) admin",
  );
  assert.match(testRoute, /hookUrl: h\.url/);
});
