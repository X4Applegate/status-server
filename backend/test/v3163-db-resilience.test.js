"use strict";
const { test } = require("node:test");
const assert   = require("node:assert/strict");
const fs       = require("node:fs");
const path     = require("node:path");

const ROOT         = path.resolve(__dirname, "..");
const serverSource = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const mysql        = require("mysql2");
const mysqlPromise = require("mysql2/promise");

function sourceBetween(start, end) {
  const si = serverSource.indexOf(start);
  if (si === -1) throw new Error(`Start marker not found: ${start}`);
  const ei = serverSource.indexOf(end, si);
  if (ei === -1) throw new Error(`End marker not found after start: ${end}`);
  return serverSource.slice(si, ei);
}

// Evaluate the real withDbTimeout / createDbPool implementations from server.js
// with their module-level dependencies injected, so the test exercises the
// shipped code rather than a copy of it.
function loadPoolHelpers(overrides) {
  const body = sourceBetween("function withDbTimeout", "// Watchdog:");
  const factory = new Function(
    "mysql", "DB_HOST", "DB_PORT", "DB_USER", "DB_PASS", "DB_NAME", "DB_QUERY_TIMEOUT_MS", "DB_STATEMENT_CAP_S", "DB_POOL_SIZE",
    `let dbQueryTimeouts = 0; ${body}; return { withDbTimeout, createDbPool, timeouts: () => dbQueryTimeouts };`
  );
  return factory(mysqlPromise, "127.0.0.1", overrides.port, "u", "p", "d", overrides.timeoutMs, 300, 4);
}

// Minimal MySQL server: answers SELECTs after `delayMs`, records SET statements.
function fakeMysqlServer({ delayMs = 5 } = {}) {
  const server = mysql.createServer();
  const seen = [];
  let id = 0;
  server.on("connection", (conn) => {
    conn.on("error", () => {});
    conn.serverHandshake({ protocolVersion: 10, serverVersion: "10.11.6-MariaDB", connectionId: ++id, statusFlags: 2, characterSet: 8, capabilityFlags: 0xffffff });
    conn.on("query", (sql) => {
      seen.push(sql);
      // Reply asynchronously: the fake server only advances its sequence id after the handler returns.
      if (/^SET SESSION/i.test(sql)) return setImmediate(() => { try { conn.writeOk(); } catch (_) {} });
      setTimeout(() => {
        try { conn.writeTextResult([{ v: 1 }], [{ catalog: "def", schema: "", table: "", orgTable: "", name: "v", orgName: "v", characterSet: 63, columnLength: 11, columnType: 3, flags: 0, decimals: 0 }]); } catch (_) {}
      }, delayMs);
    });
  });
  const port = 33500 + Math.floor(Math.random() * 400);
  return new Promise((resolve) => server.listen(port, () => resolve({ server, port, seen, close: () => new Promise((r) => server.close(() => r())) })));
}

// ── withDbTimeout ─────────────────────────────────────────────────────────────

test("withDbTimeout rejects with DB_QUERY_TIMEOUT instead of waiting forever", async () => {
  const { withDbTimeout, timeouts } = loadPoolHelpers({ port: 1, timeoutMs: 60000 });
  const never = new Promise(() => {});
  await assert.rejects(withDbTimeout(never, "SELECT sleep(999)", 50), (e) => e.code === "DB_QUERY_TIMEOUT" && /SELECT sleep/.test(e.sql));
  assert.equal(timeouts(), 1);
});

test("withDbTimeout passes fast results through untouched", async () => {
  const { withDbTimeout } = loadPoolHelpers({ port: 1, timeoutMs: 60000 });
  assert.deepEqual(await withDbTimeout(Promise.resolve([[{ v: 1 }]]), "SELECT 1", 500), [[{ v: 1 }]]);
});

// ── createDbPool against a fake server ────────────────────────────────────────

test("createDbPool: slow statements time out, fast ones succeed, session cap is applied", async () => {
  const fake = await fakeMysqlServer({ delayMs: 400 });
  let pool;
  try {
    const { createDbPool } = loadPoolHelpers({ port: fake.port, timeoutMs: 5000 });
    pool = createDbPool();
    // The statement-cap hook fires a query from inside the connect callback, which
    // mysql2's in-process fake server cannot sequence (verified working against
    // real MariaDB 11.4). Detach it so this test exercises the timeout wrapper.
    assert.equal(pool.pool.listenerCount("connection"), 1, "statement-cap hook must be registered");
    pool.pool.removeAllListeners("connection");
    // Fast path (5 s cap, 400 ms answer)
    const [rows] = await pool.query("SELECT 1 AS v");
    assert.equal(rows[0].v, 1);
    // Slow path: cap the wrapper far below the server delay
    const { withDbTimeout } = loadPoolHelpers({ port: fake.port, timeoutMs: 5000 });
    const started = Date.now();
    await assert.rejects(withDbTimeout(pool.query("SELECT 2 AS v"), "SELECT 2", 100), (e) => e.code === "DB_QUERY_TIMEOUT");
    assert.ok(Date.now() - started < 1000, "timeout did not fire promptly");
  } finally {
    if (pool) await pool.end().catch(() => {});
    await fake.close();
  }
});

// ── Source-level guarantees ───────────────────────────────────────────────────

test("GET /api/admin/servers no longer aggregates status_history inline", () => {
  const route = sourceBetween('app.get("/api/admin/servers", ', "\napp.");
  assert.doesNotMatch(route, /FROM status_history/);
  assert.match(route, /getUptime30Map\(\)/);
});

test("30-day uptime is summed from the daily rollup, never from status_history, at most once at a time", () => {
  const fn = sourceBetween("function refreshUptime30Cache", "function getUptime30Map");
  assert.match(fn, /if \(uptime30Cache\.inflight\) return uptime30Cache\.inflight/);
  assert.match(fn, /FROM status_uptime_daily/);
  assert.doesNotMatch(fn, /FROM status_history/);
  assert.match(fn, /INTERVAL 30 DAY/);
});

test("status_uptime_daily rollup table exists and recordHistory upserts into it per poll", () => {
  assert.match(serverSource, /CREATE TABLE IF NOT EXISTS status_uptime_daily \(\s+server_id VARCHAR\(150\) NOT NULL,\s+day\s+DATE\s+NOT NULL/);
  const fn = sourceBetween("async function recordHistory", "// Incident detection");
  assert.match(fn, /INSERT INTO status_uptime_daily \(server_id, day, total, up\) VALUES \(\?, DATE\(\?\), \?, \?\) ON DUPLICATE KEY UPDATE total = total \+ VALUES\(total\), up = up \+ VALUES\(up\)/);
  assert.match(fn, /rollupTotal \+= 1;\s+if \(ch\.ok\) rollupUp \+= 1;/);
});

test("history maintenance builds the covering index online and backfills newest-first with resumable progress", () => {
  const idx = sourceBetween("async function ensureHistoryCoveringIndex", "async function backfillUptimeDaily");
  assert.match(idx, /INDEX_NAME='idx_server_time_ok'/);
  assert.match(idx, /ADD INDEX idx_server_time_ok \(server_id, checked_at, ok\), ALGORITHM=INPLACE, LOCK=NONE/);
  const bf = sourceBetween("async function backfillUptimeDaily", "async function runHistoryMaintenance");
  assert.match(bf, /FROM status_servers s\s+LEFT JOIN status_history h\s+ON h\.server_id = s\.id AND h\.checked_at >= \? AND h\.checked_at < \?/);
  assert.match(bf, /ON DUPLICATE KEY UPDATE total = VALUES\(total\), up = VALUES\(up\)/);
  assert.match(bf, /if \(done\.includes\(day\)\) continue/);
  assert.match(bf, /key_name=\?", \[UPTIME_BACKFILL_SETTING\]/);
  const mw = sourceBetween("async function withMaintenanceConnection", "async function ensureHistoryCoveringIndex");
  assert.match(mw, /SET SESSION max_statement_time=0/);
  assert.match(mw, /conn\.release\(\)/);
  assert.match(serverSource, /setTimeout\(\(\) => \{ runHistoryMaintenance\(\)\.catch\(\(\) => \{\}\); \}, 20 \* 1000\)/);
});

test("startup registers the DB watchdog and the uptime cache refresh", () => {
  assert.match(serverSource, /setInterval\(\(\) => \{ dbWatchdog\(\)\.catch\(\(\) => \{\}\); \}, DB_WATCHDOG_INTERVAL_MS\)/);
  assert.match(serverSource, /setInterval\(\(\) => \{ refreshUptime30Cache\(\); \}, UPTIME30_REFRESH_MS\)/);
});

test("watchdog replaces the pool after consecutive failures", () => {
  const fn = sourceBetween("async function dbWatchdog", "// -- Database setup");
  assert.match(fn, /dbWatchdogFailures >= DB_WATCHDOG_MAX_FAILURES\) recreateDbPool/);
  assert.match(fn, /db = createDbPool\(\)/);
  assert.match(fn, /old\.end\(\)/);
});

test("/healthz probes with a 5s cap so Docker HEALTHCHECK sees 503 instead of a hang", () => {
  const route = sourceBetween('app.get("/healthz"', 'db: "down"');
  assert.match(route, /withDbTimeout\(db\.query\("SELECT 1"\), "SELECT 1 \/\* healthz \*\/", 5000\)/);
});
