"use strict";
const { test } = require("node:test");
const assert   = require("node:assert/strict");
const fs       = require("node:fs");
const path     = require("node:path");

const ROOT       = path.resolve(__dirname, "..");
const serverSource = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const adminSource  = fs.readFileSync(path.join(ROOT, "views", "admin.ejs"), "utf8");
const inviteView   = fs.readFileSync(path.join(ROOT, "views", "invite-claim.ejs"), "utf8");

function sourceBetween(start, end) {
  const si = serverSource.indexOf(start);
  if (si === -1) throw new Error(`Start marker not found: ${start}`);
  const ei = serverSource.indexOf(end, si);
  if (ei === -1) throw new Error(`End marker not found after start: ${end}`);
  return serverSource.slice(si, ei);
}

// ── requireManager middleware ──────────────────────────────────────────────────

test("requireManager middleware is defined and allows admin and manager roles", () => {
  assert.match(serverSource, /function requireManager\(/);
  const fn = sourceBetween("function requireManager(", "// -- Event log");
  assert.match(fn, /role === "admin" \|\| role === "manager"/);
});

test("requireManager returns 401 for unauthenticated requests", () => {
  const fn = sourceBetween("function requireManager(", "// -- Event log");
  assert.match(fn, /401/);
  assert.match(fn, /Unauthorized/);
});

test("requireManager returns 403 for logged-in non-manager users", () => {
  const fn = sourceBetween("function requireManager(", "// -- Event log");
  assert.match(fn, /403/);
  assert.match(fn, /Forbidden/);
});

// ── Role schema ───────────────────────────────────────────────────────────────

test("status_users role column ENUM includes manager", () => {
  assert.match(serverSource, /ENUM\(['"]admin['"],['"]manager['"],['"]viewer['"]\)/);
});

test("MODIFY COLUMN migration upgrades role to include manager", () => {
  assert.match(serverSource, /MODIFY COLUMN role ENUM\(['"]admin['"],['"]manager['"]/);
});

// ── Invite tokens table ───────────────────────────────────────────────────────

test("status_invite_tokens table is created in initDb", () => {
  assert.match(serverSource, /CREATE TABLE IF NOT EXISTS status_invite_tokens/);
});

test("invite tokens table has token, role, note, created_by, expires_at columns", () => {
  const tbl = sourceBetween(
    "CREATE TABLE IF NOT EXISTS status_invite_tokens",
    "INDEX idx_expires"
  );
  assert.match(tbl, /token\s+VARCHAR/);
  assert.match(tbl, /role\s+ENUM/);
  assert.match(tbl, /note\s+VARCHAR/);
  assert.match(tbl, /created_by\s+INT/);
  assert.match(tbl, /expires_at\s+TIMESTAMP/);
});

// ── Invite API endpoints ──────────────────────────────────────────────────────

test("GET /api/admin/invites endpoint exists and requires admin", () => {
  assert.match(serverSource, /app\.get\("\/api\/admin\/invites",\s*requireAdmin/);
});

test("POST /api/admin/invites endpoint exists and requires admin", () => {
  assert.match(serverSource, /app\.post\("\/api\/admin\/invites",\s*requireAdmin/);
});

test("POST /api/admin/invites generates a 64-char hex token", () => {
  assert.match(serverSource, /randomBytes\(32\)\.toString\(["']hex["']\)/);
});

test("DELETE /api/admin/invites/:id endpoint exists and requires admin", () => {
  assert.match(serverSource, /app\.delete\("\/api\/admin\/invites\/:id",\s*requireAdmin/);
});

test("GET /api/invite/:token public endpoint exists", () => {
  assert.match(serverSource, /app\.get\("\/api\/invite\/:token"/);
});

test("POST /api/invite/:token/claim public endpoint exists", () => {
  assert.match(serverSource, /app\.post\("\/api\/invite\/:token\/claim"/);
});

test("invite claim endpoint creates user and marks token used", () => {
  const route = sourceBetween(
    'app.post("/api/invite/:token/claim"',
    "// -- Webhook"
  );
  assert.match(route, /INSERT INTO status_users/);
  assert.match(route, /UPDATE status_invite_tokens SET used_at/);
});

test("invite claim rejects expired tokens", () => {
  const route = sourceBetween(
    'app.post("/api/invite/:token/claim"',
    "// -- Webhook"
  );
  assert.match(route, /expired|expires_at/i);
});

test("invite page route renders invite-claim view", () => {
  assert.match(serverSource, /app\.get\("\/invite\/:token"/);
  assert.match(serverSource, /render\("invite-claim"/);
});

// ── invite-claim.ejs view ─────────────────────────────────────────────────────

test("invite-claim view renders role and note from server", () => {
  assert.match(inviteView, /<%= role %>/);
  assert.match(inviteView, /note/);
});

test("invite-claim view has username and password fields", () => {
  assert.match(inviteView, /id="username"/);
  assert.match(inviteView, /id="password"/);
  assert.match(inviteView, /id="confirm"/);
});

test("invite-claim view POSTs to the fixed /api/invite/claim URL with the token in the body", () => {
  assert.match(inviteView, /fetch\("\/api\/invite\/claim"/);
  assert.match(inviteView, /JSON\.stringify\(\{ token, username, password \}\)/);
});

test("invite-claim view redirects to /login on success", () => {
  assert.match(inviteView, /\/login/);
});

// ── Manager role in admin UI ──────────────────────────────────────────────────

test("admin.ejs role dropdown includes manager option", () => {
  assert.match(adminSource, /<option value="manager">/);
});

test("isManager() function exists and allows admin or manager session role", () => {
  assert.match(adminSource, /function isManager\(\)/);
  assert.match(adminSource, /sessionRole === ["']admin["'] \|\| sessionRole === ["']manager["']/);
});

test("manager role badge CSS is defined", () => {
  assert.match(adminSource, /\.role-badge\.manager/);
});

// ── Invite management UI ──────────────────────────────────────────────────────

test("admin.ejs has invite panel CSS classes", () => {
  assert.match(adminSource, /\.invite-panel/);
  assert.match(adminSource, /\.invite-panel-heading/);
});

test("loadInvitePanel function fetches /api/admin/invites", () => {
  assert.match(adminSource, /function loadInvitePanel/);
  assert.match(adminSource, /\/api\/admin\/invites/);
});

test("generateInvite function POSTs to /api/admin/invites", () => {
  assert.match(adminSource, /function generateInvite/);
  assert.match(adminSource, /fetch\("\/api\/admin\/invites"/);
});

test("revokeInvite function DELETEs /api/admin/invites/:id", () => {
  assert.match(adminSource, /function revokeInvite/);
  assert.match(adminSource, /\/api\/admin\/invites\//);
  assert.match(adminSource, /method:"DELETE"/);
});

test("invite panel renders role select with viewer and manager options", () => {
  assert.match(adminSource, /value="viewer".*Viewer|Viewer.*value="viewer"/);
  assert.match(adminSource, /value="manager".*Manager|Manager.*value="manager"/);
  assert.match(adminSource, /invNewRole/);
});

test("invite panel renders expiry select", () => {
  assert.match(adminSource, /invNewExpiry/);
  assert.match(adminSource, /expires_hours/);
});
