"use strict";
// Live incident-resolve tests: the real server against a throwaway MariaDB.
//
// Regression for T-0836: an incident could be stored with ended_at BEFORE
// started_at and a NEGATIVE duration_s. Six such rows exist in production
// (duration_s -35, -34, -5, -5, -10, -10).
//
// The cause was two writers closing the same incident from the same recovery,
// each with its OWN clock and a DIFFERENT claim predicate:
//
//   pollAll()        reads the clock once, before any check runs, and passes it to
//                    autoResolveIncidents(), which claimed on `status <> 'resolved'`.
//   recordHistory()  reads the clock AGAIN, after that monitor's checks have
//                    finished, and claimed on `ended_at IS NULL`.
//
// Both are launched unawaited from the same poll, so they interleave. Because the
// predicates were on different columns they did not mutually exclude, and whichever
// landed second overwrote ended_at with its own timestamp. autoResolveIncidents
// winning meant ended_at went backwards by exactly the duration of that monitor's
// checks — 5 s to 35 s in production, the larger values on polls where an Omada
// controller was timing out.
//
// It was NOT the timezone skew fixed in v3.16.12: that predicts a uniform ~28800 s
// (8 h) offset, and v3.16.12 only changed the monitor-DELETE path. These tests
// therefore assert the invariant directly against stored rows, and assert the
// structural properties that make the race impossible.
//
// Skipped unless TEST_DB_HOST is set; see scripts/test-with-db.sh.
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { skip, startApp, setupAdmin, query, wait } = require("../test-support/live-app");

const SERVER_JS = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

describe("incident resolve: one clock, one guard, never a negative duration", { skip }, () => {
  let app, admin;

  before(async () => {
    // A fast tick: these tests need the REAL poller to open and close incidents,
    // which is the code path that produced the bad rows. loadConfig() runs on every
    // tick before pollAll(), so editing status_servers directly is picked up on the
    // next poll — which also keeps poll_interval_sec at 1 (the admin PUT route
    // clamps it to a 10 s minimum).
    app = await startApp({ env: { CHECK_INTERVAL: "1000" } });
    admin = await setupAdmin(app);
  });
  after(async () => { if (app) await app.destroy(); });

  // tcp checks target def.host (see runChecks), so the monitor's host decides
  // whether it passes. Port 1 on localhost is refused fast; 192.0.2.1 is
  // TEST-NET-1 (RFC 5737) and blackholes, so the check burns its whole timeout.
  const REFUSED  = JSON.stringify([{ type: "tcp", port: 1, timeout: 300 }]);
  const SLOW     = JSON.stringify([{ type: "tcp", port: 9, timeout: 2500 }]);

  /** Create a monitor that fails every poll. */
  const addFailing = (id, name, host, checks) => query(app.dbName,
    "INSERT INTO status_servers (id, name, host, checks, enabled, poll_interval_sec, failure_threshold) VALUES (?,?,?,?,1,1,1)",
    [id, name, host, checks]);

  /** Flip a monitor to passing: the app's own listening port always answers. */
  const makePass = id => query(app.dbName,
    "UPDATE status_servers SET host=?, checks=? WHERE id=?",
    ["127.0.0.1", JSON.stringify([{ type: "tcp", port: app.port, timeout: 1000 }]), id]);

  const incidents = () => query(app.dbName,
    `SELECT id, server_id, status, started_at, ended_at, duration_s,
            TIMESTAMPDIFF(SECOND, started_at, ended_at) AS real_interval_s
       FROM status_incidents ORDER BY id`);

  /** Wait until check(rows) holds, or fail showing what was actually stored. */
  async function until(check, what, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await incidents();
      if (check(rows)) return rows;
      if (Date.now() > deadline) {
        assert.fail(`timed out waiting for ${what}; incidents were ${JSON.stringify(rows)}\n` +
                    `server output:\n${app.output().slice(-1500)}`);
      }
      await wait(400);
    }
  }

  /** Every stored incident must describe a forward interval. */
  function assertNoBackwardsIntervals(rows) {
    const negativeDuration = rows.filter(i => i.duration_s != null && Number(i.duration_s) < 0);
    const backwards = rows.filter(i => i.ended_at && Number(i.real_interval_s) < 0);
    assert.deepEqual(negativeDuration.map(i => ({ id: i.id, duration_s: i.duration_s })), [],
      "no incident may store a negative duration_s");
    assert.deepEqual(backwards.map(i => ({ id: i.id, started_at: i.started_at, ended_at: i.ended_at })), [],
      "no incident may store ended_at before started_at");
  }

  // ---------------------------------------------------------------- behaviour

  // The incident the first test drives through a real recovery. Shared with the
  // next test, which asserts on that SAME incident: under load race-1 can flap
  // and open a FRESH incident after recovering, so "the newest incident for
  // race-1" is not necessarily the one that was just closed.
  let recoveredIncidentId;

  test("a real poller recovery stores ended_at >= started_at and duration_s >= 0", async () => {
    await addFailing("race-1", "Race One", "127.0.0.1", REFUSED);

    const opened = await until(r => r.some(i => i.server_id === "race-1" && !i.ended_at),
      "the poller to open an incident for race-1");
    const incidentId = opened.find(i => i.server_id === "race-1" && !i.ended_at).id;
    recoveredIncidentId = incidentId;

    // Keep it open a few polls, so started_at is meaningfully in the past and a
    // backwards ended_at would be unmistakable rather than sub-second.
    await wait(4000);

    // Now make it pass. This drives the DOWN -> UP transition in pollAll(), which
    // launches autoResolveIncidents() and recordHistory() concurrently — the race.
    await makePass("race-1");

    const closed = await until(r => r.some(i => i.id === incidentId && i.ended_at),
      "the poller to resolve the incident");
    const inc = closed.find(i => i.id === incidentId);

    // The invariant. Before the fix this is where a -5 to -35 landed.
    assert.ok(Number(inc.duration_s) >= 0,
      `duration_s must never be negative, got ${inc.duration_s}`);
    assert.ok(Number(inc.real_interval_s) >= 0,
      `ended_at must not precede started_at, interval was ${inc.real_interval_s}s ` +
      `(started_at ${inc.started_at}, ended_at ${inc.ended_at})`);
    assert.equal(inc.status, "resolved");

    // duration_s must describe the stored interval, not a second opinion from
    // another clock. Both are DB-side now, so they agree exactly.
    assert.equal(Number(inc.duration_s), Number(inc.real_interval_s),
      "duration_s must equal TIMESTAMPDIFF(SECOND, started_at, ended_at)");

    // And it must be a plausible duration, not a timezone offset. Both the 8 h
    // (28800 s) skew of the v3.16.12 bug and this bug's negatives fail here.
    assert.ok(Number(inc.duration_s) >= 2 && Number(inc.duration_s) < 600,
      `duration_s should be the few seconds this incident was really open, got ${inc.duration_s}`);
  });

  test("exactly one 'resolved' timeline update per recovery", async () => {
    // Both resolve paths append a recovery update. If both can claim the row the
    // public timeline shows the recovery twice — the user-visible symptom.
    //
    // Assert on the exact incident the previous test saw resolved, not on the
    // newest one for race-1: under full-suite load the monitor can flap and open
    // a fresh, still-open incident whose timeline legitimately has no recovery
    // entry yet, which made this read 0 updates and fail for the wrong reason.
    assert.ok(recoveredIncidentId, "the previous test recorded which incident it resolved");
    const [inc] = await query(app.dbName,
      "SELECT id, ended_at FROM status_incidents WHERE id=?", [recoveredIncidentId]);
    assert.ok(inc, "the resolved incident is still present");
    assert.ok(inc.ended_at, "the previous test left it closed");

    const updates = await query(app.dbName,
      "SELECT status, message FROM status_incident_updates WHERE incident_id=? ORDER BY id", [inc.id]);
    const resolvedUpdates = updates.filter(u => u.status === "resolved");
    assert.equal(resolvedUpdates.length, 1,
      `exactly one writer may close an incident, got ${resolvedUpdates.length} resolved updates: ` +
      JSON.stringify(resolvedUpdates));
  });

  test("no monitor, however slow its checks, produces a negative duration_s", async () => {
    // The production gap was "how long this monitor's checks took this poll": the
    // wider the window between pollAll()'s clock read and recordHistory()'s, the
    // more negative the row. A 2500 ms timeout against a blackholed address makes
    // that window far larger than the -5 s and -10 s rows this reproduces, and
    // several monitors recovering at once maximises the overlap.
    const ids = ["slow-a", "slow-b", "slow-c", "slow-d"];
    for (const id of ids) await addFailing(id, `Slow ${id}`, "192.0.2.1", SLOW);

    await until(r => ids.every(id => r.some(i => i.server_id === id && !i.ended_at)),
      "the poller to open an incident for every slow monitor", 40000);
    await wait(4000);

    for (const id of ids) await makePass(id);

    await until(r => ids.every(id => r.some(i => i.server_id === id && i.ended_at)),
      "every slow monitor's incident to resolve", 40000);

    // The whole table, including rows from the earlier tests.
    assertNoBackwardsIntervals(await incidents());
  });

  test("resolve-all cannot overwrite an ended_at the poller already wrote", async () => {
    // The bulk operator path had no claim predicate at all, so it could re-close an
    // incident the poll path had just closed and stretch its duration to 'now'.
    // poll_interval_sec 3600 keeps the poller away from this fixture.
    await query(app.dbName,
      "INSERT INTO status_servers (id, name, host, checks, enabled, poll_interval_sec) VALUES (?,?,?,?,1,3600)",
      ["bulk-race", "Bulk Race", "127.0.0.1", REFUSED]);
    const ins = await query(app.dbName,
      "INSERT INTO status_incidents (server_id, server_name, started_at, cause) VALUES (?,?,DATE_SUB(NOW(), INTERVAL 600 SECOND),?)",
      ["bulk-race", "Bulk Race", "port 1 refused"]);
    const id = ins.insertId;

    // The poll path closes it first, exactly as the shipped statement does.
    await query(app.dbName,
      `UPDATE status_incidents
          SET ended_at=NOW(), duration_s=GREATEST(0, TIMESTAMPDIFF(SECOND, started_at, NOW())), status='resolved'
        WHERE id=? AND ended_at IS NULL`, [id]);
    const [first] = await query(app.dbName,
      "SELECT ended_at, duration_s FROM status_incidents WHERE id=?", [id]);
    assert.ok(Number(first.duration_s) >= 595, `fixture closed with ~600s, got ${first.duration_s}`);
    await wait(2500);

    // Then the operator hits resolve-all. It must not touch the closed row.
    const r = await admin.post("/api/admin/incidents/resolve-all");
    assert.equal(r.status, 200, `resolve-all failed: ${r.text}`);

    const [after] = await query(app.dbName,
      "SELECT ended_at, duration_s FROM status_incidents WHERE id=?", [id]);
    assert.equal(String(after.ended_at), String(first.ended_at),
      "resolve-all must not rewrite an ended_at that was already set");
    assert.equal(Number(after.duration_s), Number(first.duration_s),
      "resolve-all must not rewrite duration_s on an already-closed incident");

    // And it reports what it actually closed, not how many rows it looked at.
    assert.equal(typeof r.json.resolved, "number", "resolve-all reports a count");
  });

  test("an operator update on a closed incident does not move its ended_at", async () => {
    // autoResolveIncidents() used to select on `status <> 'resolved'`. Posting a
    // 'monitoring' update sets status WITHOUT clearing ended_at, so that SELECT
    // would pick the closed row back up and re-stamp ended_at to 'now', silently
    // stretching a finished incident's duration.
    const ins = await query(app.dbName,
      "INSERT INTO status_incidents (server_id, server_name, started_at, ended_at, duration_s, status, cause) " +
      "VALUES (?,?,DATE_SUB(NOW(), INTERVAL 300 SECOND),DATE_SUB(NOW(), INTERVAL 120 SECOND),180,'resolved',?)",
      ["race-1", "Race One", "already closed"]);
    const id = ins.insertId;
    await query(app.dbName,
      "INSERT INTO status_incident_updates (incident_id, status, message) VALUES (?,?,?)",
      [id, "resolved", "closed earlier"]);

    const r = await admin.post(`/api/admin/incidents/${id}/updates`,
      { status: "monitoring", message: "watching for recurrence" });
    assert.equal(r.status, 200, `posting an update failed: ${r.text}`);

    const [inc] = await query(app.dbName,
      "SELECT status, duration_s, TIMESTAMPDIFF(SECOND, started_at, ended_at) AS real_interval_s " +
      "FROM status_incidents WHERE id=?", [id]);
    assert.equal(inc.status, "monitoring", "the operator's status is recorded");
    assert.equal(Number(inc.duration_s), 180,
      "reopening the status must not rewrite the duration of a closed interval");
    assert.equal(Number(inc.real_interval_s), 180, "ended_at is unchanged");

    // race-1 is passing by now, so autoResolveIncidents() runs against that server
    // on later polls. It must still leave this already-closed row alone.
    await wait(3500);
    const [still] = await query(app.dbName,
      "SELECT duration_s, TIMESTAMPDIFF(SECOND, started_at, ended_at) AS real_interval_s " +
      "FROM status_incidents WHERE id=?", [id]);
    assert.equal(Number(still.duration_s), 180,
      "a later poll must not re-close an incident that already has an ended_at");
    assert.equal(Number(still.real_interval_s), 180, "ended_at still unchanged after polling");
  });

  test("the whole run left no incident with a backwards interval", async () => {
    assertNoBackwardsIntervals(await incidents());
  });

  // ------------------------------------------------------------------- source

  // The behaviour tests above only catch the race on polls where the two writers
  // happen to interleave. These assert the structural properties that make it
  // impossible, so a future edit reintroducing a second clock or a divergent guard
  // fails here even when the timing does not reproduce.

  /** Each `UPDATE status_incidents ... ended_at=NOW() ... WHERE ...` statement. */
  const endedAtWriters = () =>
    SERVER_JS.match(/UPDATE status_incidents[\s\S]{0,600}?ended_at\s*=\s*NOW\(\)[\s\S]{0,400}?WHERE[^`"']*/g) || [];

  test("every UPDATE that writes ended_at uses NOW(), not a bound JS Date", () => {
    const bound = SERVER_JS.match(/UPDATE status_incidents[\s\S]{0,400}?ended_at\s*=\s*\?/g) || [];
    assert.deepEqual(bound, [],
      "ended_at must be stamped by the database (NOW()); binding a JS Date puts the two " +
      "ends of the incident interval in different clocks (T-0836)");
    assert.ok(endedAtWriters().length >= 5,
      `expected every ended_at writer to use NOW(); found ${endedAtWriters().length}`);
  });

  test("every UPDATE that writes ended_at floors duration_s DB-side", () => {
    // GREATEST(0, ...) is the backstop: even if some future clock disagreement
    // reappears, a negative interval can no longer reach the column.
    const floored = SERVER_JS.match(
      /duration_s\s*=\s*GREATEST\(0, TIMESTAMPDIFF\(SECOND, started_at, NOW\(\)\)\)/g) || [];
    assert.equal(floored.length, endedAtWriters().length,
      `every ended_at writer must floor duration_s DB-side; ${endedAtWriters().length} writers ` +
      `but ${floored.length} floored`);

    const jsComputed = SERVER_JS.match(/duration_s\s*=\s*\?/g) || [];
    assert.deepEqual(jsComputed, [],
      "duration_s must not be computed in JS and bound as a parameter (T-0836)");
  });

  test("every UPDATE that writes ended_at claims on the same predicate", () => {
    // The race needed TWO guards on DIFFERENT columns to let both writers win. One
    // predicate, on the column being written, makes closing an incident idempotent.
    const writers = endedAtWriters();
    assert.ok(writers.length >= 5, `expected at least 5 ended_at writers, found ${writers.length}`);
    for (const w of writers) {
      assert.match(w, /ended_at IS NULL/,
        "every writer of ended_at must claim the row with `ended_at IS NULL`, so only one " +
        `writer can close a given incident (T-0836); offending statement: ${w.slice(0, 220)}`);
    }

    // The specific guard that let autoResolveIncidents() overwrite a closed row.
    assert.doesNotMatch(SERVER_JS,
      /UPDATE status_incidents[\s\S]{0,400}?WHERE id=\? AND status <> 'resolved'/,
      "autoResolveIncidents() must not claim on `status <> 'resolved'`: it is a different " +
      "column from the one being written, so it does not exclude the other resolve path");
  });

  test("autoResolveIncidents selects only incidents that are still open", () => {
    // Selecting on status alone also picked up rows an operator had moved off
    // 'resolved' after they closed, and re-stamped their ended_at.
    // Anchored on the next top-level declaration rather than a byte budget, so
    // adding comments inside the function cannot silently empty this assertion.
    const fn = SERVER_JS.match(
      /async function autoResolveIncidents\([\s\S]*?\n}\n/);
    assert.ok(fn, "autoResolveIncidents() is still present");
    const body = fn[0];
    assert.match(body, /SELECT id FROM status_incidents WHERE server_id=\? AND ended_at IS NULL/,
      "autoResolveIncidents() must select on ended_at IS NULL, not on status");
    assert.doesNotMatch(body, /SELECT[^;]*status NOT IN \('resolved'\)/,
      "selecting on status re-closes incidents an operator reopened the status of (T-0836)");
  });

  test("incident interval endpoints are both stamped by the database", () => {
    // started_at bound as a JS Date against an ended_at of NOW() is the v3.16.12
    // timezone bug; both DB-side is the only combination with a single clock.
    const inserts = SERVER_JS.match(/INSERT INTO status_incidents[^`"']*/g) || [];
    assert.ok(inserts.length >= 2, `expected incident INSERTs, found ${inserts.length}`);
    for (const stmt of inserts) {
      assert.match(stmt, /started_at/, "incident INSERTs name started_at explicitly");
      assert.match(stmt, /NOW\(\)/,
        `started_at must be stamped by the database, not bound as a JS Date (T-0836); got: ${stmt}`);
    }
  });
});
