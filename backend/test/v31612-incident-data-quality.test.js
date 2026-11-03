"use strict";
// v3.16.12 — two incident data-quality fixes (T-0480):
//   1. Deleting a monitor left its in-flight incident open forever, because the
//      resolve path needs a SUCCESSFUL check from a monitor that no longer exists.
//   2. The weekly report counted incidents by started_at, so an outage that began
//      before the window was invisible — a service could sit at 0.00% uptime for a
//      full week and still render "0 incidents · longest 0s".
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

// -- 1. Monitor deletion closes in-flight incidents ---------------------------

test("closeIncidentsForDeletedServer resolves open incidents and keeps the history", () => {
  const fn = sourceBetween("async function closeIncidentsForDeletedServer", "// Atomically replace the set of groups");
  assert.match(fn, /SELECT id FROM status_incidents WHERE server_id=\? AND ended_at IS NULL/,
    "must select only in-flight incidents for that server");
  assert.match(fn, /WHERE id=\? AND ended_at IS NULL/,
    "the UPDATE must claim the incident atomically");
  assert.match(fn, /if \(!upd\.affectedRows\) continue;/,
    "only the writer that actually closed the incident may append the update");
  assert.match(fn, /INSERT INTO status_incident_updates/,
    "must annotate the timeline so the closure is explainable");
  assert.doesNotMatch(fn, /DELETE FROM status_incidents/,
    "incidents are kept as history, not deleted with the monitor");
});

test("both monitor-delete paths close incidents before removing the monitor row", () => {
  // Single delete route
  const single = sourceBetween('app.delete("/api/admin/servers/:id"', "// Reorder a single server");
  assert.match(single, /closeIncidentsForDeletedServer\(req\.params\.id, rows\[0\]\.name\)/,
    "DELETE /api/admin/servers/:id must close incidents");
  assert.ok(
    single.indexOf("closeIncidentsForDeletedServer") < single.indexOf("DELETE FROM status_servers"),
    "must close incidents BEFORE deleting the monitor row"
  );

  // Bulk delete action
  const bulk = sourceBetween('app.post("/api/admin/servers/bulk"', 'else if (action === "move")');
  assert.match(bulk, /closeIncidentsForDeletedServer\(id, rows\[0\]\.name\)/,
    "bulk delete must close incidents too");
  assert.ok(
    bulk.indexOf("closeIncidentsForDeletedServer") < bulk.indexOf("DELETE FROM status_servers"),
    "bulk delete must close incidents BEFORE deleting the monitor row"
  );
});

test("every status_servers delete site is covered by the incident cleanup", () => {
  // Guards against a future third delete path reintroducing the orphan bug.
  const deletes = serverSource.match(/DELETE FROM status_servers WHERE/g) || [];
  const closes  = serverSource.match(/closeIncidentsForDeletedServer\(/g) || [];
  assert.equal(deletes.length, 2, "exactly two monitor-delete paths are expected");
  // 2 call sites + 1 definition
  assert.equal(closes.length, 3, "each delete path must call the cleanup helper");
});

// Functional: a deleted monitor's open incident really does get resolved.
function loadCloser() {
  const body = sourceBetween("async function closeIncidentsForDeletedServer", "// Atomically replace the set of groups");
  const factory = new Function("db", "addLog", "fmtDuration",
    `${body}; return closeIncidentsForDeletedServer;`);
  return factory;
}

test("functional: an orphan-to-be incident is resolved with a real duration", async () => {
  const queries = [];
  const db = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/SELECT id FROM status_incidents/.test(sql)) return [[{ id: 2719 }]];
      if (/SELECT duration_s FROM status_incidents/.test(sql)) return [[{ duration_s: 3600 }]];
      return [{ affectedRows: 1 }];
    }
  };
  const logs = [];
  const close = loadCloser()(db, e => logs.push(e), s => `${s}s`);

  const n = await close("applegate-dns-1-1775966594549", "Applegate DNS Server #1 - On Premised");
  assert.equal(n, 1, "one incident closed");

  const upd = queries.find(q => /UPDATE status_incidents/.test(q.sql));
  assert.ok(upd, "incident was resolved");
  assert.equal(upd.params[0], 2719, "resolved the right incident id");

  const note = queries.find(q => /INSERT INTO status_incident_updates/.test(q.sql));
  assert.ok(note, "timeline update written");
  assert.match(note.params[2], /Monitor removed/, "closure reason is explicit");
  assert.match(note.params[2], /Applegate DNS Server #1/, "names the monitor");
  assert.match(note.params[2], /3600s/, "reports the DB-computed duration");
  assert.equal(logs.length, 1, "logged for the audit trail");
});

test("duration and ended_at are computed by the DB, not from a JS Date", () => {
  // A JS Date bound through the `timezone: "local"` pool is shifted by the
  // local UTC offset. Mixed with a DB-side started_at that stored an ended_at
  // BEFORE started_at and a zero duration. Both values must come from one clock.
  const fn = sourceBetween("async function closeIncidentsForDeletedServer", "// Atomically replace the set of groups");
  assert.match(fn, /ended_at=NOW\(\)/, "ended_at must be the DB's NOW()");
  assert.match(fn, /duration_s=GREATEST\(0, TIMESTAMPDIFF\(SECOND, started_at, NOW\(\)\)\)/,
    "duration must be computed by the DB from started_at");
  assert.doesNotMatch(fn, /new Date\(/, "no JS clock may take part in the timestamp arithmetic");
});

test("functional: deleting a monitor with no open incidents is a no-op", async () => {
  const queries = [];
  const db = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/SELECT id FROM status_incidents/.test(sql)) return [[]];
      return [{ affectedRows: 1 }];
    }
  };
  const logs = [];
  const close = loadCloser()(db, e => logs.push(e), s => `${s}s`);

  const n = await close("some-healthy-server", "Healthy");
  assert.equal(n, 0);
  assert.equal(queries.length, 1, "only the SELECT runs; nothing is written");
  assert.equal(logs.length, 0, "no log noise when there is nothing to close");
});

test("functional: an incident the poller closed first is not double-annotated", async () => {
  // The UPDATE claims the row; if it affected nothing, another writer already
  // resolved it and this path must not append a second "resolved" update.
  const queries = [];
  const db = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/SELECT id FROM status_incidents/.test(sql)) return [[{ id: 999 }]];
      if (/UPDATE status_incidents/.test(sql)) return [{ affectedRows: 0 }];
      return [{ affectedRows: 1 }];
    }
  };
  const logs = [];
  const close = loadCloser()(db, e => logs.push(e), s => `${s}s`);

  const n = await close("raced", "Raced");
  assert.equal(n, 0, "nothing was closed by this caller");
  assert.ok(!queries.some(q => /INSERT INTO status_incident_updates/.test(q.sql)),
    "must not append a duplicate resolved update");
  assert.equal(logs.length, 0);
});

// -- 2. Weekly report counts overlapping incidents ----------------------------

test("weekly report counts incidents OVERLAPPING the window, not just starting in it", () => {
  const fn = sourceBetween("async function buildWeeklyReport", "function fmtReportDuration");

  // The old, blind predicate must be gone.
  assert.doesNotMatch(fn, /WHERE started_at >= \? AND started_at <= \?\s*\n\s*GROUP BY server_id/,
    "started_at-only incident window must be replaced by overlap matching");

  assert.match(fn, /WHERE started_at < \? AND \(ended_at IS NULL OR ended_at > \?\)/,
    "must use the standard half-open overlap predicate");
  assert.match(fn, /SUM\(ended_at IS NULL\) AS open_count/,
    "must track how many of those incidents are still open");
  assert.match(fn, /AS open_age_s/, "must carry the running age of an open incident");
  // longest outage is clamped to the window so a 16-day incident does not
  // report 16 days against a 7-day report
  assert.match(fn, /GREATEST\(started_at, \?\)/, "longest_s clamps to window start");
  assert.match(fn, /LEAST\(COALESCE\(ended_at, NOW\(\)\), \?\)/, "longest_s clamps to window end");
});

test("report rows and totals expose still-open incidents", () => {
  const fn = sourceBetween("async function buildWeeklyReport", "function fmtReportDuration");
  assert.match(fn, /openIncidents:/, "per-server open incident count");
  assert.match(fn, /totalOpenIncidents/, "summary open incident count");
  assert.match(fn, /return \{ periodStart, periodEnd, servers, totalChecks, totalIncidents, totalOpenIncidents/,
    "totalOpenIncidents must be part of the report payload");
});

test("both renderers call out a still-open incident", () => {
  const html = sourceBetween("function renderWeeklyReportHtml", "function renderWeeklyReportText");
  assert.match(html, /s\.openIncidents \?/, "HTML worst-rows must branch on openIncidents");
  assert.match(html, /Still open/, "HTML must say the incident is still open");
  assert.match(html, /rep\.totalOpenIncidents \?/, "HTML summary tile must branch on open count");

  const text = sourceBetween("function renderWeeklyReportText", "// Minimal HTML-safe escape");
  assert.match(text, /STILL OPEN/, "text report must say the incident is still open");
  assert.match(text, /and counting/, "text report must show the running duration");
});

// Functional: the exact Joe Label Printer scenario that motivated this fix.
function loadReportRenderers() {
  const body = sourceBetween("function fmtReportDuration", "// Minimal HTML-safe escape");
  const factory = new Function("escAttrServer", "EXTERNAL_URL",
    `${body}; return { renderWeeklyReportHtml, renderWeeklyReportText, fmtReportDuration };`);
  return factory(s => String(s), "");
}

test("functional: a 0.00% service with an incident open from before the window is never '0 incidents'", () => {
  const { renderWeeklyReportText, renderWeeklyReportHtml } = loadReportRenderers();
  // Joe Label Printer: incident started 2026-10-17, window 2026-10-26 → 2026-11-02.
  // Overlap counting gives incidents=1, open for ~16 days.
  const rep = {
    periodStart: new Date("2026-10-26T00:00:00Z"),
    periodEnd:   new Date("2026-11-02T00:00:00Z"),
    overallUptime: 97.5,
    totalChecks: 100000,
    totalIncidents: 1,
    totalOpenIncidents: 1,
    worst: [{
      name: "Joe Label Printer",
      uptime: 0,
      incidents: 1,
      longestS: 7 * 86400,
      openIncidents: 1,
      openAgeS: 16 * 86400,
      openSince: new Date("2026-10-17T15:54:49Z")
    }],
    slowest: []
  };

  const text = renderWeeklyReportText(rep);
  assert.match(text, /Joe Label Printer: 0\.00%/);
  assert.doesNotMatch(text, /Joe Label Printer: 0\.00% · 0 incidents/,
    "the 0.00%-with-0-incidents line must be impossible");
  assert.match(text, /1 incidents/, "the overlapping incident is counted");
  assert.match(text, /STILL OPEN \(16d 0h and counting\)/, "running age is surfaced");
  assert.match(text, /Incidents: 1 \(1 still open\)/, "summary flags the open incident");

  const html = renderWeeklyReportHtml(rep);
  assert.match(html, /Still open — 16d 0h and counting/);
  assert.match(html, /1 still open/);
});

test("functional: a fully-resolved week renders no open-incident noise", () => {
  const { renderWeeklyReportText, renderWeeklyReportHtml } = loadReportRenderers();
  const rep = {
    periodStart: new Date("2026-10-26T00:00:00Z"),
    periodEnd:   new Date("2026-11-02T00:00:00Z"),
    overallUptime: 99.95,
    totalChecks: 100000,
    totalIncidents: 2,
    totalOpenIncidents: 0,
    worst: [{ name: "Web Server", uptime: 99.8, incidents: 2, longestS: 240, openIncidents: 0, openAgeS: null, openSince: null }],
    slowest: []
  };
  const text = renderWeeklyReportText(rep);
  assert.doesNotMatch(text, /STILL OPEN/);
  assert.doesNotMatch(text, /still open/);
  assert.match(text, /Incidents: 2$/m);

  const html = renderWeeklyReportHtml(rep);
  assert.doesNotMatch(html, /Still open/);
  assert.doesNotMatch(html, /still open/);
});
