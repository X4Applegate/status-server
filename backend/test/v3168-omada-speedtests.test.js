"use strict";
// v3.16.8 — Omada gateway WAN speed tests: harvest the controller's own scheduled results,
// store long-term history, show them behind login, and alert on degraded/stale.
//
// The tests below pin the facts that were expensive to learn and are easy to regress:
// the API reports bits/sec, `status` 3 rows are junk, history needs a portUuid, and the
// server must never trigger a test on a live retail WAN.
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

// -- Read-only guarantee -------------------------------------------------------
// A speed test saturates the site WAN for ~30s. These are coffee shops running card
// payments; the controller owns the schedule (04:00) and this server must only ever read.
test("the server never triggers a speed test", () => {
  assert.doesNotMatch(
    serverSource,
    /omadaApiPost\([^)]*gateways\/\$\{[^}]*\}\/speedTest["'`]/,
    "must not POST .../speedTest — that fires a test on a live store WAN"
  );
});

// -- The two API traps ---------------------------------------------------------
test("history is read from dateList WITH a portUuid, not from the live result", () => {
  const fn = sourceBetween("async function omadaSpeedTestHarvest(", "async function omadaSpeedTestHarvestAll");
  assert.match(fn, /speedTestResult\/dateList/, "history comes from dateList");
  assert.match(fn, /portUuid: port\.uuid/, "dateList without portUuid returns a misleading -33488");
  assert.doesNotMatch(fn, /\/speedTestResult["'`]\s*\)/, "the bare speedTestResult endpoint is live-only and returns [] when idle");
});

test("port UUIDs come from wan-lan-status", () => {
  const fn = sourceBetween("async function omadaSpeedTestHarvest(", "async function omadaSpeedTestHarvestAll");
  assert.match(fn, /wan-lan-status/);
  assert.match(fn, /wanList/, "wanList[].portId is already '<port>_<uuid>'");
});

// -- Data correctness ----------------------------------------------------------
test("throughput is converted from bits/sec to Mbps", () => {
  const fn = sourceBetween("const bpsToMbps", "// Is this gateway capable");
  assert.match(fn, /1e6/, "the API returns bits per second, e.g. 945036656 ≈ 945 Mbps");
});

test("failed-port rows (status 3) are discarded before storage", () => {
  assert.match(serverSource, /const OMADA_SPEEDTEST_OK = 1;/);
  const fn = sourceBetween("async function omadaSpeedTestHarvest(", "async function omadaSpeedTestHarvestAll");
  assert.match(
    fn,
    /if \(r\.status !== OMADA_SPEEDTEST_OK\) continue;/,
    "a dead WAN logs 0/0 every run and would halve the site average"
  );
});

test("dedupe key includes the port — a dual-WAN gateway emits one row per port", () => {
  const ddl = sourceBetween("CREATE TABLE IF NOT EXISTS status_omada_speedtests", "CREATE TABLE IF NOT EXISTS status_omada_speedtest_thresholds");
  assert.match(ddl, /UNIQUE KEY uniq_result \(controller_id, site_id, gateway_mac, port_id, tested_at\)/);
  const fn = sourceBetween("async function omadaSpeedTestHarvest(", "async function omadaSpeedTestHarvestAll");
  assert.match(fn, /INSERT IGNORE INTO status_omada_speedtests/, "polling re-reads the same result all day");
  assert.match(fn, /FROM_UNIXTIME\(\?\)/, "tested_at is the result's own time, never insert time");
});

// -- Capability gating ---------------------------------------------------------
// Only the ER7412-M2 supports speed test. Three Anthem sites run ER7206/ER706W-4G and will
// never produce data; without this gate they would alarm forever for working as designed.
test("unsupported gateways are skipped via featureState, not guessed", () => {
  const fn = sourceBetween("async function omadaSpeedTestSupported", "// Harvest new speed-test rows");
  assert.match(fn, /featureDescription/);
  assert.match(fn, /state === 0/, "0 = supported; 1 = pre-configured but unsupported; 2 = unsupported");
});

// -- Scheduling ----------------------------------------------------------------
test("harvest runs on its own interval, not the per-check poll loop", () => {
  assert.match(serverSource, /setInterval\(\(\) => \{ omadaSpeedTestHarvestAll\(\)\.catch\(\(\) => \{\}\); \}, 30 \* 60 \* 1000\)/);
  assert.match(serverSource, /setInterval\(\(\) => \{ omadaSpeedTestAlertScan\(\)\.catch\(\(\) => \{\}\); \}, 60 \* 60 \* 1000\)/);
});

// -- Alerting ------------------------------------------------------------------
test("alerts fire only on a state change, and reuse the existing webhook path", () => {
  const fn = sourceBetween("async function omadaSpeedTestAlertTransition", "async function runChecks");
  assert.match(fn, /if \(badNow === wasActive\) return;/, "an hourly re-alert on a still-slow site trains people to ignore it");
  assert.match(fn, /fireWebhooks\(/, "must not introduce a second notification path");
  assert.match(fn, /isRecovery: !badNow/);
});

test("alert state is persisted so a restart does not re-fire an open alert", () => {
  const fn = sourceBetween("async function omadaSpeedTestAlertScan", "async function omadaSpeedTestAlertTransition");
  assert.match(fn, /CREATE TABLE IF NOT EXISTS status_omada_speedtest_alert_state/);
});

test("a stale site does not also raise a slow-speed alert", () => {
  const fn = sourceBetween("async function omadaSpeedTestAlertScan", "async function omadaSpeedTestAlertTransition");
  assert.match(fn, /if \(!row \|\| staleNow \|\| cfg\.min_down_mbps == null\) continue;/, "a missing result is Alert B's job");
});

test("speed thresholds are per-site, never one global number", () => {
  const ddl = sourceBetween("CREATE TABLE IF NOT EXISTS status_omada_speedtest_thresholds", "CREATE TABLE IF NOT EXISTS status_unifi_controllers");
  assert.match(ddl, /PRIMARY KEY \(controller_id, site_id\)/, "sites sit on different ISPs and tiers");
  assert.match(ddl, /min_down_mbps/);
  assert.match(ddl, /stale_hours/);
});

// -- Exposure ------------------------------------------------------------------
test("speed results are behind login and thresholds are admin-only", () => {
  assert.match(serverSource, /app\.get\("\/api\/omada\/speedtests", requireAuth,/, "Richard: logged-in users only, not the public page");
  assert.match(serverSource, /app\.post\("\/api\/omada\/speedtests\/threshold", requireAdmin,/);
});

test("results are scoped to the groups the user may see", () => {
  const fn = sourceBetween('app.get("/api/omada/speedtests", requireAuth', 'app.post("/api/omada/speedtests/threshold"');
  assert.match(fn, /getUserAllowedGroupIds/);
  assert.match(fn, /status_omada_controller_groups/);
});

// -- Display -------------------------------------------------------------------
test("speeds render as Mbps, dropping to Kbps only below 1 Mbps", () => {
  const fn = indexSource.slice(indexSource.indexOf("function fmtSpeed"), indexSource.indexOf("let _speedActive"));
  assert.match(fn, /mbps < 1/);
  assert.match(fn, /Kbps/);
  assert.match(fn, /toFixed\(1\)\} Mbps/);

  // Behavioural check of the exact rule Richard specified.
  const fmtSpeed = (mbps) =>
    mbps == null || !isFinite(mbps) ? "—"
    : mbps < 1 ? `${Math.round(mbps * 1000)} Kbps`
               : `${mbps.toFixed(1)} Mbps`;
  assert.equal(fmtSpeed(945.04), "945.0 Mbps");
  assert.equal(fmtSpeed(1), "1.0 Mbps");
  assert.equal(fmtSpeed(0.4), "400 Kbps");
  assert.equal(fmtSpeed(null), "—");
});

test("the worst site sorts first", () => {
  const fn = sourceBetween('app.get("/api/omada/speedtests", requireAuth', 'app.post("/api/omada/speedtests/threshold"');
  assert.match(fn, /sort\(\(a, b\) =>/);
  assert.match(fn, /return av - bv;/, "ascending download — a degraded store surfaces without hunting");
});
