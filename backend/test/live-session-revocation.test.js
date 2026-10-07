"use strict";
// Live tests for finding E: sessions must follow the user's current DB record.
// Before the fix the role was copied into the session at login and trusted for
// the full 24 h cookie lifetime, so a demoted or deleted admin kept admin API
// access until the session expired.
//   1. Demotion takes effect on the very next request (in-process invalidation)
//   2. Promotion takes effect on the very next request
//   3. Deleting a user logs out their sessions (401, /api/me loggedIn false,
//      page routes redirect to /login)
//   4. An untouched admin keeps access throughout
//   5. A role change made outside this process (direct DB write) is picked up
//      within the cache TTL (5 s)
//   6. An admin password reset revokes the user's sessions; changing your own
//      password keeps the current session but revokes your other sessions
// Skipped unless TEST_DB_HOST is set; see scripts/test-with-db.sh.
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { skip, startApp, client, setupAdmin, query, wait } = require("../test-support/live-app");

// Each login gets its own client IP so the 10-per-15-min login limiter never
// interferes with the number of sessions this suite needs.
let ipSeq = 20;
async function loginAs(app, username, password) {
  const c = client(app, { headers: { "X-Forwarded-For": `198.51.100.${ipSeq++}` } });
  const r = await c.post("/api/login", { username, password });
  if (r.status !== 200) throw new Error(`login as ${username} failed: ${r.status} ${r.text}`);
  return Object.assign(c, { username, password });
}

describe("live: session revocation", { skip }, () => {
  let app, root;
  const users = {};

  async function createUser(username, role) {
    const password = crypto.randomBytes(12).toString("hex");
    const r = await root.post("/api/admin/users", { username, password, role });
    assert.equal(r.status, 200, r.text);
    const list = await root.get("/api/admin/users");
    const row = list.json.find(u => u.username === username);
    assert.ok(row, `created user ${username} not listed`);
    users[username] = { id: row.id, password };
    return loginAs(app, username, password);
  }

  before(async () => {
    app = await startApp();
    root = await setupAdmin(app);
  });
  after(async () => { if (app) await app.destroy(); });

  test("an admin who is demoted to viewer loses admin access on the very next request", async () => {
    const second = await createUser("second", "admin");
    assert.equal((await second.get("/api/admin/users")).status, 200);

    const r = await root.put(`/api/admin/users/${users.second.id}`, { username: "second", role: "viewer" });
    assert.equal(r.status, 200, r.text);

    const after = await second.get("/api/admin/users");
    assert.equal(after.status, 403, after.text);
    const me = await second.get("/api/me");
    assert.equal(me.json.loggedIn, true, "a demoted user stays logged in");
    assert.equal(me.json.role, "viewer");
  });

  test("a viewer who is promoted to admin gains admin access on the very next request", async () => {
    const promo = await createUser("promo", "viewer");
    assert.equal((await promo.get("/api/admin/users")).status, 403);

    const r = await root.put(`/api/admin/users/${users.promo.id}`, { username: "promo", role: "admin" });
    assert.equal(r.status, 200, r.text);

    assert.equal((await promo.get("/api/admin/users")).status, 200);
    assert.equal((await promo.get("/api/me")).json.role, "admin");
  });

  test("a deleted admin is logged out: 401 on the API, loggedIn false, pages redirect to /login", async () => {
    const doomed = await createUser("doomed", "admin");
    assert.equal((await doomed.get("/api/admin/users")).status, 200);

    const r = await root.delete(`/api/admin/users/${users.doomed.id}`);
    assert.equal(r.status, 200, r.text);

    const api = await doomed.get("/api/admin/users");
    assert.equal(api.status, 401, api.text);
    const me = await doomed.get("/api/me");
    assert.equal(me.status, 200);
    assert.equal(me.json.loggedIn, false);
    const page = await doomed.get("/admin");
    assert.equal(page.status, 302);
    assert.match(page.headers.get("location") || "", /\/login/);
    // The client can still log in normally afterwards (as someone else).
    const relog = await doomed.post("/api/login", { username: root.username, password: root.password });
    assert.equal(relog.status, 200, relog.text);
  });

  test("an untouched admin keeps access", async () => {
    const r = await root.get("/api/admin/users");
    assert.equal(r.status, 200, r.text);
    const me = await root.get("/api/me");
    assert.equal(me.json.loggedIn, true);
    assert.equal(me.json.role, "admin");
  });

  test("a role change written directly to the DB is picked up within the cache TTL", async () => {
    const ext = await createUser("external", "admin");
    assert.equal((await ext.get("/api/admin/users")).status, 200);

    await query(app.dbName, "UPDATE status_users SET role='viewer' WHERE id=?", [users.external.id]);
    let status;
    const deadline = Date.now() + 7000;
    do {
      await wait(500);
      status = (await ext.get("/api/admin/users")).status;
    } while (status !== 403 && Date.now() < deadline);
    assert.equal(status, 403, "out-of-process demotion never took effect");
  });

  test("an admin password reset revokes the user's existing sessions", async () => {
    const reset = await createUser("reset", "admin");
    assert.equal((await reset.get("/api/admin/users")).status, 200);

    const newPassword = crypto.randomBytes(12).toString("hex");
    const r = await root.put(`/api/admin/users/${users.reset.id}`, { username: "reset", role: "admin", password: newPassword });
    assert.equal(r.status, 200, r.text);

    assert.equal((await reset.get("/api/admin/users")).status, 401);
    assert.equal((await reset.get("/api/me")).json.loggedIn, false);
    // The new password works and gives a working session.
    const fresh = await loginAs(app, "reset", newPassword);
    assert.equal((await fresh.get("/api/admin/users")).status, 200);
    // Editing a user without changing the password does not log them out.
    const r2 = await root.put(`/api/admin/users/${users.reset.id}`, { username: "reset", role: "admin" });
    assert.equal(r2.status, 200, r2.text);
    assert.equal((await fresh.get("/api/admin/users")).status, 200);
  });

  test("changing your own password keeps this session and revokes your other sessions", async () => {
    const other = await loginAs(app, root.username, root.password);
    assert.equal((await other.get("/api/admin/users")).status, 200);

    const newPassword = crypto.randomBytes(12).toString("hex");
    const r = await root.post("/api/admin/change-password", { currentPassword: root.password, newPassword });
    assert.equal(r.status, 200, r.text);
    root.password = newPassword;

    assert.equal((await root.get("/api/admin/users")).status, 200, "the session that changed the password must survive");
    assert.equal((await other.get("/api/admin/users")).status, 401, "other sessions of the same user must be revoked");
  });
});
