"use strict";
// Live restart/incident tests: the real server against a throwaway MariaDB.
//
// Regression for the 2026-10-07 production incident: a graceful restart
// resolved an open auto-created incident ("Automated checks are passing
// again") although the device was still down, then opened a duplicate
// incident and sent a second DOWN alert once the failure threshold was hit
// again. After a restart a server with an open auto-incident must resume as
// down, and only a real successful check may resolve the incident.
//
// Monitored "device": a TCP check against a port owned by this test process.
// Closed = connection refused (down); listening = up. Alerts are counted with
// a generic-format webhook pointing at a local HTTP listener in this process.
// Skipped unless TEST_DB_HOST is set; see scripts/test-with-db.sh.
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net  = require("node:net");
const { skip, startApp, query, wait } = require("../test-support/live-app");

// Polls are driven by a fixed 5 s tick; poll_interval_sec=5 makes the server
// due on every tick. The admin API clamps the interval to >=10 s, so the
// fixture row is inserted directly.
const POLL_SEC  = 5;
const THRESHOLD = 2;

/** A free TCP port on 127.0.0.1 that nothing listens on (yet). */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** The fake device: listen() makes the TCP check pass, close() makes it fail. */
function device(port) {
  let srv = null;
  return {
    port,
    listen: () => new Promise((resolve, reject) => {
      srv = net.createServer(sock => sock.destroy());
      srv.once("error", reject);
      srv.listen(port, "127.0.0.1", () => resolve());
    }),
    close: () => new Promise(resolve => { if (!srv) return resolve(); const s = srv; srv = null; s.close(() => resolve()); }),
  };
}

/** Local webhook receiver; events() lists the generic payloads' `event` field. */
async function webhookSink() {
  const bodies = [];
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", c => { b += c; });
    req.on("end", () => {
      try { bodies.push(JSON.parse(b)); } catch { bodies.push({ event: "unparseable", raw: b }); }
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    });
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${srv.address().port}/hook`,
    events: () => bodies.map(b => b.event),
    count: ev => bodies.filter(b => b.event === ev).length,
    close: () => new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r()); }),
  };
}

async function addFixtures(dbName, { serverId, port, hookUrl }) {
  await query(dbName,
    "INSERT INTO status_webhooks (name, url, enabled, fire_on_down, fire_on_recovery, format) VALUES (?,?,1,1,1,'generic')",
    ["test sink", hookUrl]);
  await query(dbName,
    "INSERT INTO status_servers (id, name, host, checks, poll_interval_sec, failure_threshold, enabled) VALUES (?,?,?,?,?,?,1)",
    [serverId, "Label Printer " + serverId, "127.0.0.1", JSON.stringify([{ type: "tcp", port, timeout: 1000 }]), POLL_SEC, THRESHOLD]);
}

const incidents = (dbName, serverId) =>
  query(dbName, "SELECT id, status, ended_at FROM status_incidents WHERE server_id=? ORDER BY id", [serverId]);
const updates = (dbName, serverId) =>
  query(dbName,
    "SELECT u.incident_id, u.status, u.message FROM status_incident_updates u JOIN status_incidents i ON i.id=u.incident_id WHERE i.server_id=? ORDER BY u.id",
    [serverId]);

async function until(what, fn, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await wait(500);
  }
}

describe("live: restart does not falsely resolve open incidents", { skip }, () => {
  let app1, app2, sink, dev;
  const serverId = "restart-printer";

  before(async () => {
    sink = await webhookSink();
    dev  = device(await freePort());           // closed: the device is offline
    app1 = await startApp();
    await addFixtures(app1.dbName, { serverId, port: dev.port, hookUrl: sink.url });
  });
  after(async () => {
    // app2 does not own the database; destroy app1 last, which drops it.
    if (app2) await app2.stop();
    if (app1) await app1.destroy();
    if (dev)  await dev.close();
    if (sink) await sink.close();
  });

  test("threshold failures open one auto-incident and alert once", async () => {
    await until("auto-incident opened", async () => (await incidents(app1.dbName, serverId)).length > 0);
    await until("DOWN webhook", () => sink.count("server.down") >= 1, 20000);
    const inc = await incidents(app1.dbName, serverId);
    assert.equal(inc.length, 1);
    assert.equal(inc[0].ended_at, null);
    // A few more failing polls change nothing.
    await wait(POLL_SEC * 1000 * 2 + 1000);
    assert.equal((await incidents(app1.dbName, serverId)).length, 1);
    assert.deepEqual(sink.events(), ["server.down"]);
  });

  test("after a restart the still-down server keeps its incident open, with no duplicate or new alert", async () => {
    const [before] = await incidents(app1.dbName, serverId);
    const { code } = await app1.stop();
    assert.equal(code, 0);

    app2 = await startApp({ dbName: app1.dbName });
    // Initial forced poll plus several 5 s ticks: well past the threshold.
    await wait(POLL_SEC * 1000 * 5 + 2000);

    const inc = await incidents(app2.dbName, serverId);
    assert.equal(inc.length, 1, `duplicate incident opened: ${JSON.stringify(inc)}`);
    assert.equal(inc[0].id, before.id);
    assert.equal(inc[0].ended_at, null, "incident was resolved while the device was still down");
    assert.notEqual(inc[0].status, "resolved");
    const resolvedUpdates = (await updates(app2.dbName, serverId)).filter(u => u.status === "resolved");
    assert.deepEqual(resolvedUpdates, [], "a 'resolved' update was written");
    assert.deepEqual(sink.events(), ["server.down"], "restart sent another alert");
  });

  test("a real recovery after the restart resolves the incident once and alerts recovery once", async () => {
    await dev.listen();
    await until("incident resolved", async () => (await incidents(app2.dbName, serverId))[0].ended_at !== null, 30000);
    await until("recovery webhook", () => sink.count("server.recovered") >= 1, 20000);
    await wait(POLL_SEC * 1000 * 2 + 1000);

    const inc = await incidents(app2.dbName, serverId);
    assert.equal(inc.length, 1);
    assert.equal(inc[0].status, "resolved");
    const resolvedUpdates = (await updates(app2.dbName, serverId)).filter(u => u.status === "resolved");
    assert.equal(resolvedUpdates.length, 1, JSON.stringify(resolvedUpdates));
    assert.deepEqual(sink.events(), ["server.down", "server.recovered"]);
  });
});

describe("live: normal down/recovery cycle (control)", { skip }, () => {
  let app, sink, dev;
  const serverId = "control-printer";

  before(async () => {
    sink = await webhookSink();
    dev  = device(await freePort());
    app  = await startApp();
    await addFixtures(app.dbName, { serverId, port: dev.port, hookUrl: sink.url });
  });
  after(async () => {
    if (app)  await app.destroy();
    if (dev)  await dev.close();
    if (sink) await sink.close();
  });

  test("fail then pass: one incident, resolved exactly once, one DOWN and one recovery alert", async () => {
    await until("auto-incident opened", async () => (await incidents(app.dbName, serverId)).length > 0);
    await until("DOWN webhook", () => sink.count("server.down") >= 1, 20000);
    const opened = await updates(app.dbName, serverId);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].status, "investigating");
    assert.match(opened[0].message, /^Automated check failed: /);

    await dev.listen();
    await until("incident resolved", async () => (await incidents(app.dbName, serverId))[0].ended_at !== null, 30000);
    await until("recovery webhook", () => sink.count("server.recovered") >= 1, 20000);
    await wait(POLL_SEC * 1000 * 2 + 1000);

    const inc = await incidents(app.dbName, serverId);
    assert.equal(inc.length, 1);
    assert.equal(inc[0].status, "resolved");
    const resolvedUpdates = (await updates(app.dbName, serverId)).filter(u => u.status === "resolved");
    assert.equal(resolvedUpdates.length, 1, JSON.stringify(resolvedUpdates));
    assert.deepEqual(sink.events(), ["server.down", "server.recovered"]);
  });
});
