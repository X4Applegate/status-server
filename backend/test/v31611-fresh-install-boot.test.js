"use strict";
// Fresh-install boot regression tests.
//   1. initDB creates every table before any FOREIGN KEY references it
//      (status_square_account_groups referenced status_groups before it existed,
//      so a brand-new database failed with errno 150 and the app never listened)
//   2. A failed boot exits non-zero so the container restart policy retries it
//   3. The image runs tini as PID 1 so signals work during boot and orphans are reaped
const { test } = require("node:test");
const assert   = require("node:assert/strict");
const fs       = require("node:fs");
const path     = require("node:path");

const ROOT         = path.resolve(__dirname, "..");
const serverSource = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

// -- 1. FK targets exist before they are referenced ---------------------------
test("initDB creates each table before any foreign key references it", () => {
  const created = new Set();
  const forwardRefs = [];
  // Each CREATE TABLE lives in its own template literal, so the body runs to the next backtick.
  for (const [, table, body] of serverSource.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)([^`]*)`/g)) {
    for (const [, target] of body.matchAll(/REFERENCES\s+(\w+)/g)) {
      if (target !== table && !created.has(target)) forwardRefs.push(`${table} -> ${target}`);
    }
    created.add(table);
  }
  assert.ok(created.has("status_square_account_groups"), "expected to find the Square group mapping table");
  assert.deepEqual(forwardRefs, [], "tables reference other tables before they are created");
});

// -- 2. A failed boot exits so Docker can restart it --------------------------
test("startup failure logs fatal and exits 1 instead of lingering without a port", () => {
  const boot = serverSource.slice(serverSource.indexOf("await initDB();"));
  assert.match(boot, /\}\)\(\)\.catch\(\(err\) => \{[\s\S]*?logger\.fatal\([\s\S]*?process\.exit\(1\);/);
});

// -- 3. tini is PID 1 ------------------------------------------------------------
test("Dockerfile installs tini and runs node under it", () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
  assert.match(dockerfile, /apk add --no-cache [^\n]*\btini\b/);
  assert.match(dockerfile, /^ENTRYPOINT \["\/sbin\/tini", "--"\]$/m);
  assert.match(dockerfile, /^CMD \["node", "server\.js"\]$/m);
});
