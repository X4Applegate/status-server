"use strict";
// Live boot tests: the real server against an empty MariaDB database.
//   1. initDB succeeds on an empty schema and /healthz reports healthy
//      (fresh installs could not boot from v3.1.8 until 3.16.11)
//   2. First-run setup creates the admin once; login checks the password
//   3. SIGTERM shuts the server down promptly with exit code 0
// Skipped unless TEST_DB_HOST is set; see scripts/test-with-db.sh.
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { skip, startApp, client, setupAdmin, login } = require("../test-support/live-app");

describe("live: fresh install", { skip }, () => {
  let app, admin;
  before(async () => { app = await startApp(); });
  after(async () => { if (app) await app.destroy(); });

  test("boots on an empty database and reports healthy", async () => {
    const r = await client(app).get("/healthz");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true);
  });

  test("first-run setup creates an admin and logs it in, and only works once", async () => {
    admin = await setupAdmin(app);
    const me = await admin.get("/api/me");
    assert.equal(me.json.loggedIn, true);
    assert.equal(me.json.role, "admin");

    const again = await client(app).post("/api/setup", { username: "intruder", password: "intruder-pw-123" });
    assert.equal(again.status, 403);
  });

  test("login accepts the admin password and rejects a wrong one", async () => {
    const ok = await login(app, admin.username, admin.password);
    assert.equal((await ok.get("/api/me")).json.loggedIn, true);

    const bad = await client(app).post("/api/login", { username: admin.username, password: "not-the-password" });
    assert.notEqual(bad.status, 200);
  });

  test("SIGTERM shuts down promptly with exit code 0", async () => {
    const started = Date.now();
    const { code } = await app.stop();
    assert.equal(code, 0, app.output().slice(-2000));
    assert.ok(Date.now() - started < 10000, `took ${Date.now() - started} ms`);
  });
});
