"use strict";
// v3.16.7 — history retention moved out of the per-poll path into a periodic,
// batched, single-flight background job.
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

// -- recordHistory no longer prunes inline -------------------------------------
test("recordHistory no longer runs an unbounded per-poll DELETE", () => {
  const fn = sourceBetween("async function recordHistory", "// -- Webhooks");
  assert.doesNotMatch(fn, /DELETE FROM status_history/, "retention delete must be out of recordHistory");
});

// -- pruneHistoryBatched is batched, bounded, per-server, single-flight ---------
test("pruneHistoryBatched deletes in bounded per-server batches", () => {
  const fn = sourceBetween("async function pruneHistoryBatched", "app.get(\"/api/admin/servers\"");
  assert.match(fn, /if \(historyPruneRunning \|\| !db\) return/, "single-flight guard");
  assert.match(fn, /DELETE FROM status_history WHERE server_id=\? AND checked_at < DATE_SUB\(NOW\(\), INTERVAL \? DAY\) LIMIT \?/);
  assert.match(fn, /HISTORY_PRUNE_MAX_BATCHES/, "must cap batches per run");
  assert.match(fn, /while \(n === HISTORY_PRUNE_BATCH\)/, "loops until a short batch");
});

test("retention prune is scheduled on its own interval (not the poll loop)", () => {
  assert.match(serverSource, /setInterval\(\(\) => \{ pruneHistoryBatched\(\)\.catch\(\(\) => \{\}\); \}, 60 \* 60 \* 1000\)/);
});

// -- Functional: batching, totals, and single-flight ---------------------------
function loadPrune(db) {
  const body = sourceBetween("const HISTORY_RETENTION_DAYS", "app.get(\"/api/admin/servers\"");
  const factory = new Function("db", "addLog",
    `${body}; return { pruneHistoryBatched, get running(){ return historyPruneRunning; } };`);
  return factory(db, () => {});
}

test("pruneHistoryBatched loops per server until a short batch, summing deletions", async () => {
  // server 'a' has 12000 rows to prune (5000,5000,2000); server 'b' has none.
  const remaining = { a: 12000, b: 0 };
  const deletes = [];
  const db = {
    query: async (sql, params) => {
      if (/SELECT DISTINCT server_id/.test(sql)) return [[{ server_id: "a" }, { server_id: "b" }]];
      const id = params[0];
      const n = Math.min(remaining[id], 5000); // HISTORY_PRUNE_BATCH
      remaining[id] -= n;
      deletes.push({ id, n });
      return [{ affectedRows: n }];
    }
  };
  await loadPrune(db).pruneHistoryBatched();
  const total = deletes.reduce((s, d) => s + d.n, 0);
  assert.equal(total, 12000);
  assert.deepEqual(deletes.map(d => d.n), [5000, 5000, 2000, 0]); // a x3 then b x1
});

test("pruneHistoryBatched is single-flight (a second concurrent call is a no-op)", async () => {
  let selects = 0;
  const db = {
    query: async (sql) => {
      if (/SELECT DISTINCT server_id/.test(sql)) { selects++; await new Promise(r => setTimeout(r, 10)); return [[]]; }
      return [{ affectedRows: 0 }];
    }
  };
  const mod = loadPrune(db);
  await Promise.all([mod.pruneHistoryBatched(), mod.pruneHistoryBatched()]);
  assert.equal(selects, 1, "overlapping runs must not both query");
});
