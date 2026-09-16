"use strict";
// v3.16.6 — auth/session hardening regression tests.
//   1. establishSession() regenerates the session id before attaching identity
//   2. login / setup / OAuth route through establishSession (no raw fixation)
//   3. Google OAuth requires email_verified + optional domain allowlist
//   4. Shutdown ends SSE/log streams before httpServer.close() (so the drain completes)
const { test } = require("node:test");
const assert   = require("node:assert/strict");
const fs       = require("node:fs");
const path     = require("node:path");

const ROOT         = path.resolve(__dirname, "..");
const serverSource = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

function sourceBetween(start, end) {
  const si = serverSource.indexOf(start);
  if (si === -1) throw new Error(`Start marker not found: ${start}`);
  const ei = serverSource.indexOf(end, si);
  if (ei === -1) throw new Error(`End marker not found after start: ${end}`);
  return serverSource.slice(si, ei);
}

// -- 1. establishSession regenerates first, then attaches identity --------------
function loadEstablishSession() {
  const body = sourceBetween("function establishSession", 'app.post("/api/login"');
  return new Function(`${body}; return establishSession;`)();
}

test("establishSession regenerates the session id, then attaches identity, then saves", async () => {
  const establishSession = loadEstablishSession();
  const order = [];
  const req = { session: {
    userId: "ATTACKER-PLANTED",
    regenerate(cb) { order.push("regenerate"); delete this.userId; cb(); },
    save(cb)       { order.push("save"); cb(); },
  }};
  await establishSession(req, { userId: 7, username: "alice", role: "admin" });
  assert.deepEqual(order, ["regenerate", "save"], "must regenerate before saving");
  assert.equal(req.session.userId, 7);
  assert.equal(req.session.username, "alice");
  assert.equal(req.session.role, "admin");
});

test("establishSession rejects (does not log the user in) if regenerate fails", async () => {
  const establishSession = loadEstablishSession();
  const req = { session: { regenerate(cb) { cb(new Error("store down")); }, save(cb) { cb(); } } };
  await assert.rejects(
    establishSession(req, { userId: 1, username: "a", role: "viewer" }),
    /store down/
  );
});

// -- 2. Auth routes go through establishSession (no raw session-id reuse) --------
test("login, setup, and OAuth all authenticate via establishSession", () => {
  assert.match(serverSource, /await establishSession\(req, \{ userId: rows\[0\]\.id/);      // login
  assert.match(serverSource, /await establishSession\(req, \{ userId: result\.insertId/);   // setup
  assert.match(serverSource, /await establishSession\(req, \{ userId: user\.id/);           // oauth
  // Regression: the raw "attach identity to the existing session" pattern is gone.
  assert.doesNotMatch(serverSource, /req\.session\.userId\s*=\s*rows\[0\]\.id/);
  assert.doesNotMatch(serverSource, /req\.session\.userId\s*=\s*user\.id/);
});

// -- 3. Google OAuth verified-email + domain allowlist --------------------------
test("OAuth links/creates accounts only for a Google-verified email", () => {
  const cb = sourceBetween('app.get("/auth/google/callback"', 'app.post("/api/logout"');
  assert.match(cb, /const emailVerified = payload\.email_verified === true/);
  // Email-based linking is gated on emailVerified.
  assert.match(cb, /if \(!rows\.length && email && emailVerified\)/);
  // Auto-provisioning refuses an unverified email.
  assert.match(cb, /if \(!emailVerified\)\s*\{[\s\S]*?google_unverified/);
});

test("OAuth supports an optional GOOGLE_ALLOWED_DOMAINS allowlist", () => {
  const cb = sourceBetween('app.get("/auth/google/callback"', 'app.post("/api/logout"');
  assert.match(cb, /process\.env\.GOOGLE_ALLOWED_DOMAINS/);
  assert.match(cb, /google_domain/);
  // Unset must not restrict (allowlist logic is guarded by length).
  assert.match(cb, /if \(allowedDomains\.length\)/);
});

// -- 4. Shutdown ends streams before close() so the drain completes -------------
test("shutdown ends SSE/log streams before httpServer.close()", () => {
  const shutdown = sourceBetween("function shutdown(signal)", "process.on(\"SIGTERM\"");
  const endIdx   = shutdown.indexOf("for (const r of [...sseClients, ...logClients])");
  const closeIdx = shutdown.indexOf("httpServer.close(() =>");   // the actual call, not the comment
  assert.notEqual(endIdx, -1, "streams must be ended explicitly");
  assert.notEqual(closeIdx, -1);
  assert.ok(endIdx < closeIdx, "streams must be ended BEFORE httpServer.close()");
  assert.match(shutdown, /r\.socket && r\.socket\.destroy\(\)/);
  assert.match(shutdown, /sseClients = \[\];/);
});
