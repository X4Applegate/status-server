"use strict";
// Live monitor-delete tests: the real server against a throwaway MariaDB.
//
// Regression for T-0480: deleting a monitor left its in-flight incident open
// forever. The auto-resolve path needs a SUCCESSFUL check from the monitor, so
// once the monitor row is gone nothing can ever resolve its incident — it stays
// 'investigating' indefinitely and keeps showing on the public status page and
// in every later weekly report as an active outage for a service that no longer
// exists. One such row was found open for 8 days in production.
//
// Deleting a monitor must close its open incidents (resolved + ended_at set),
// keep them as history rather than deleting them, and annotate the timeline.
// Skipped unless TEST_DB_HOST is set; see scripts/test-with-db.sh.
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { skip, startApp, setupAdmin, query } = require("../test-support/live-app");

describe("deleting a monitor closes its in-flight incidents", { skip }, () => {
  let app, admin;

  before(async () => {
    // A long poll interval keeps the poller from touching the seeded incidents:
    // these tests assert on what monitor DELETION does, not on check results.
    app = await startApp({ env: { CHECK_INTERVAL: "3600000" } });
    admin = await setupAdmin(app);
  });
  after(async () => { if (app) await app.destroy(); });

  // Monitors point at a port nothing listens on, but CHECK_INTERVAL is long
  // enough (and these tests are short enough) that the poller never interferes
  // with the seeded incidents.
  const CHECKS = JSON.stringify([{ type: "tcp", port: 1, timeout: 500 }]);

  /**
   * Seed a monitor plus an incident that is open (ended_at IS NULL).
   *
   * `ageS` is how long the incident has been open. started_at is computed by
   * the DATABASE (NOW() - INTERVAL) rather than by this process: the app runs
   * with TZ=America/Los_Angeles and a `timezone: "local"` pool, while this test
   * helper's connection uses its own local zone, so a JS Date bound as a
   * parameter would be stored hours off and the duration assertion below would
   * be measuring the timezone skew instead of the fix.
   */
  async function seed(id, name, ageS) {
    await query(app.dbName,
      "INSERT INTO status_servers (id, name, host, checks, enabled) VALUES (?,?,?,?,1)",
      [id, name, "127.0.0.1", CHECKS]);
    const res = await query(app.dbName,
      "INSERT INTO status_incidents (server_id, server_name, started_at, cause) VALUES (?,?,DATE_SUB(NOW(), INTERVAL ? SECOND),?)",
      [id, name, ageS, "port 853 timeout"]);
    const incidentId = res.insertId;
    await query(app.dbName,
      "INSERT INTO status_incident_updates (incident_id, status, message) VALUES (?,?,?)",
      [incidentId, "investigating", "Automated check failed: port 853 timeout"]);
    return incidentId;
  }

  const openIncidents = () =>
    query(app.dbName, "SELECT id, server_id, status, ended_at, duration_s FROM status_incidents WHERE ended_at IS NULL");

  test("DELETE /api/admin/servers/:id resolves the open incident instead of orphaning it", async () => {
    // Open for an hour, like the production row that motivated this.
    const incidentId = await seed("dns-1", "Applegate DNS Server #1", 3600);

    const before = await openIncidents();
    assert.equal(before.length, 1, "fixture incident is open before the delete");

    const r = await admin.delete("/api/admin/servers/dns-1");
    assert.equal(r.status, 200, `delete failed: ${r.text}`);

    // The monitor is gone...
    const servers = await query(app.dbName, "SELECT id FROM status_servers WHERE id=?", ["dns-1"]);
    assert.equal(servers.length, 0, "monitor row removed");

    // ...and no incident is left open for it. This is the bug: before the fix
    // the row below stayed status='investigating', ended_at NULL, forever.
    assert.deepEqual(await openIncidents(), [], "no incident may be left open for a deleted monitor");

    // The incident is KEPT as history, resolved, with a real duration.
    const [inc] = await query(app.dbName, "SELECT * FROM status_incidents WHERE id=?", [incidentId]);
    assert.ok(inc, "incident is kept as history, not deleted with the monitor");
    assert.equal(inc.status, "resolved");
    assert.ok(inc.ended_at, "ended_at is stamped");
    assert.ok(inc.duration_s >= 3500 && inc.duration_s <= 3700,
      `duration_s should be ~3600 for an hour-old incident, got ${inc.duration_s}`);

    // ...and the closure is explainable on the public timeline.
    const updates = await query(app.dbName,
      "SELECT status, message FROM status_incident_updates WHERE incident_id=? ORDER BY id", [incidentId]);
    const closing = updates.at(-1);
    assert.equal(closing.status, "resolved");
    assert.match(closing.message, /Monitor removed/, "says why the incident was closed");
    assert.match(closing.message, /Applegate DNS Server #1/, "names the monitor");
  });

  test("bulk delete closes open incidents for every monitor it removes", async () => {
    const a = await seed("bulk-a", "Bulk A", 600);
    const b = await seed("bulk-b", "Bulk B", 600);
    assert.equal((await openIncidents()).length, 2, "two incidents open before the bulk delete");

    const r = await admin.post("/api/admin/servers/bulk", { ids: ["bulk-a", "bulk-b"], action: "delete" });
    assert.equal(r.status, 200, `bulk delete failed: ${r.text}`);

    assert.deepEqual(await openIncidents(), [], "bulk delete must not orphan incidents either");
    for (const id of [a, b]) {
      const [inc] = await query(app.dbName, "SELECT status, ended_at FROM status_incidents WHERE id=?", [id]);
      assert.equal(inc.status, "resolved");
      assert.ok(inc.ended_at);
    }
  });

  test("deleting a monitor leaves other monitors' incidents untouched", async () => {
    const keep   = await seed("keep-me", "Keep Me", 300);
    const remove = await seed("remove-me", "Remove Me", 300);

    const r = await admin.delete("/api/admin/servers/remove-me");
    assert.equal(r.status, 200, `delete failed: ${r.text}`);

    const [kept] = await query(app.dbName, "SELECT status, ended_at FROM status_incidents WHERE id=?", [keep]);
    assert.equal(kept.status, "investigating", "an unrelated monitor's incident stays open");
    assert.equal(kept.ended_at, null);

    const [closed] = await query(app.dbName, "SELECT status FROM status_incidents WHERE id=?", [remove]);
    assert.equal(closed.status, "resolved");

    // Clean up so later assertions on "nothing open" are not affected.
    await admin.delete("/api/admin/servers/keep-me");
  });

  test("deleting a monitor with no open incident is a clean no-op", async () => {
    await query(app.dbName,
      "INSERT INTO status_servers (id, name, host, checks, enabled) VALUES (?,?,?,?,1)",
      ["healthy", "Healthy", "127.0.0.1", CHECKS]);
    const r = await admin.delete("/api/admin/servers/healthy");
    assert.equal(r.status, 200, `delete failed: ${r.text}`);
    assert.equal((await query(app.dbName, "SELECT id FROM status_servers WHERE id=?", ["healthy"])).length, 0);
  });
});
