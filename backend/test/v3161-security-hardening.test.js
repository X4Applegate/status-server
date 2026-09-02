"use strict";
const { test } = require("node:test");
const assert   = require("node:assert/strict");
const fs       = require("node:fs");
const path     = require("node:path");

const ROOT         = path.resolve(__dirname, "..");
const serverSource = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const inviteView   = fs.readFileSync(path.join(ROOT, "views", "invite-claim.ejs"), "utf8");
const pkg          = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const lock         = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));

function sourceBetween(start, end) {
  const si = serverSource.indexOf(start);
  if (si === -1) throw new Error(`Start marker not found: ${start}`);
  const ei = serverSource.indexOf(end, si);
  if (ei === -1) throw new Error(`End marker not found after start: ${end}`);
  return serverSource.slice(si, ei);
}

function semverGte(a, b) {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i] > pb[i]; }
  return true;
}

// ── Dependencies (Dependabot GHSA-3f6p-5ww8-9rcr / GHSA-rgwj-5xj2-c3m3) ───────

test("every mysql2 copy in the lockfile is >= 3.22.0 (patched auth-downgrade + zlib bomb)", () => {
  const copies = Object.entries(lock.packages).filter(([k]) => k === "node_modules/mysql2" || k.endsWith("/node_modules/mysql2"));
  assert.ok(copies.length >= 1, "mysql2 must be in the lockfile");
  for (const [k, v] of copies) assert.ok(semverGte(v.version, "3.22.0"), `${k} is ${v.version}`);
});

test("mysql2 override pins express-mysql-session's nested copy to the direct dependency", () => {
  assert.equal(pkg.overrides.mysql2, "$mysql2");
  assert.equal(lock.packages["node_modules/express-mysql-session/node_modules/mysql2"], undefined);
});

// ── Prototype pollution guard (CodeQL js/prototype-polluting-assignment) ─────

test("isSafeObjectKey rejects __proto__, constructor and prototype", () => {
  assert.match(serverSource, /const UNSAFE_OBJECT_KEYS = new Set\(\["__proto__", "constructor", "prototype"\]\)/);
  assert.match(serverSource, /function isSafeObjectKey\(key\)/);
});

test("bulk server action filters ids through isSafeObjectKey and uses Object.hasOwn on serverStatus", () => {
  const route = sourceBetween('app.post("/api/admin/servers/bulk"', "// Quick status override");
  assert.match(route, /safeIds = ids\.filter\([^)]*isSafeObjectKey\(id\)\)/);
  assert.doesNotMatch(route, /if \(serverStatus\[id\]\)/, "must not truthy-check serverStatus[id] with a user-supplied id");
  assert.ok((route.match(/Object\.hasOwn\(serverStatus, id\)/g) || []).length >= 3);
});

// ── Invite claim request-forgery fix (CodeQL js/request-forgery) ─────────────

test("invite-claim view never interpolates the token into a fetch URL", () => {
  assert.doesNotMatch(inviteView, /fetch\([^)]*<%/);
  assert.match(inviteView, /<input type="hidden" id="inviteToken" value="<%= token %>">/);
  assert.match(inviteView, /fetch\("\/api\/invite\/claim"/);
});

test("POST /api/invite/claim reads the token from the body and shares the handler with the legacy route", () => {
  assert.match(serverSource, /app\.post\("\/api\/invite\/claim", \(req, res\) => claimInvite\(req\.body && req\.body\.token, req, res\)\)/);
  assert.match(serverSource, /app\.post\("\/api\/invite\/:token\/claim", \(req, res\) => claimInvite\(req\.params\.token, req, res\)\)/);
  assert.match(serverSource, /async function claimInvite\(token, req, res\)/);
});

// ── Invite token validation ──────────────────────────────────────────────────

test("invite tokens must be 64 lowercase hex chars", () => {
  assert.match(serverSource, /const INVITE_TOKEN_RE = \/\^\[a-f0-9\]\{64\}\$\//);
  assert.match(sourceBetween('app.get("/api/invite/:token"', 'app.post("/api/invite/claim"'), /isValidInviteToken\(req\.params\.token\)/);
  assert.match(sourceBetween("async function claimInvite", "// -- Webhook"), /isValidInviteToken\(token\)/);
  assert.match(sourceBetween('app.get("/invite/:token"', 'app.get("/privacy"'), /isValidInviteToken\(req\.params\.token\)/);
});

// ── Rate limiting (CodeQL js/missing-rate-limiting) ──────────────────────────

test("GET /invite/:token page is rate limited", () => {
  assert.match(serverSource, /app\.get\("\/invite\/:token", pageLimiter, async/);
});

test("invite note is HTML-escaped on the claim page", () => {
  assert.match(inviteView, /<%= note %>/);
  assert.doesNotMatch(inviteView, /<%- note %>/);
});
