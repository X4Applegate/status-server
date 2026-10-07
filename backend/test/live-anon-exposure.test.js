"use strict";
// Live tests: anonymous visitors only see what public status pages show.
//   C. Every /api/events write is filtered per client. Operator status
//      overrides, bulk status changes and API push-status used to write the
//      full server list (host, runbook, check details) to every SSE client,
//      anonymous ones included.
//   D. A group with public_enabled=0 is readable only by admins and by users
//      it is granted to. Anonymous requests for its dashboard pages, feeds,
//      icon, manifest, API data, badges and per-service data get 404, exactly
//      like a group or service that does not exist; its custom domain behaves
//      like an unmapped host. Public groups keep working.
// Skipped unless TEST_DB_HOST is set; see scripts/test-with-db.sh.
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { skip, startApp, client, setupAdmin, login, wait, PROXY_HEADERS } = require("../test-support/live-app");

// Internal-only values. None of them may ever reach an anonymous visitor.
const PRIV = { name: "Internal DB",  host: "10.99.0.1", runbook: "RUNBOOK-PRIVATE-7f3a" };
const PUB  = { name: "Public API",   host: "10.99.0.2", runbook: "RUNBOOK-PUBLIC-9c1e" };
const BOTH = { name: "Shared Edge",  host: "10.99.0.3", runbook: "RUNBOOK-SHARED-4d2b" };
const PUSH_DETAIL = "PUSH-DETAIL-MARKER-61e0";
const INTERNAL = [PRIV.host, PUB.host, BOTH.host, PRIV.runbook, PUB.runbook, BOTH.runbook,
  PUSH_DETAIL, "via admin", "bulk action", "rootadmin"];

// Like live-app's openEvents(), plus a query string (public dashboards connect
// as /api/events?slug=<group>) and parsing of the server lists it receives.
async function openStream(app, query = "", who = null) {
  const ctrl = new AbortController();
  const headers = { ...PROXY_HEADERS };
  if (who && who.cookie) headers.Cookie = who.cookie;
  const r = await fetch(`${app.base}/api/events${query}`, { headers, signal: ctrl.signal });
  let text = "";
  const reading = (async () => {
    try {
      const reader = r.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += Buffer.from(value).toString();
      }
    } catch { /* aborted by close() */ }
  })();
  // Complete frames only: the last split element is "" or a partial frame.
  const events = () => text.split("\n\n").slice(0, -1)
    .filter(f => f.startsWith("data: ")).map(f => JSON.parse(f.slice(6)));
  return {
    status: r.status,
    mark: () => events().length,
    since: (n = 0) => events().slice(n),
    async close() { ctrl.abort(); await reading; },
  };
}

async function until(fn, label, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await wait(50);
  }
}

const find = (list, id) => list.find(s => s.id === id);

describe("live: anonymous exposure of internal and private-group data", { skip }, () => {
  let app, admin, member, outsider, ids, privId, pubId;
  const streams = {};

  before(async () => {
    app = await startApp();
    admin = await setupAdmin(app);
    ids = {};
    for (const [key, s] of Object.entries({ PRIV, PUB, BOTH })) {
      const r = await admin.post("/api/admin/servers", {
        name: s.name, host: s.host, runbook: s.runbook, poll_interval_sec: 3600,
        checks: [{ type: "tcp", port: 3306, timeout: 1000 }],
      });
      assert.equal(r.status, 200, r.text);
      ids[key] = r.json.id;
    }
    let r = await admin.post("/api/admin/groups", {
      name: "Private Grp", slug: "priv", public_enabled: 0,
      custom_domain: "status.private.test", server_ids: [ids.PRIV, ids.BOTH],
    });
    assert.equal(r.status, 200, r.text);
    privId = r.json.id;
    r = await admin.post("/api/admin/groups", {
      name: "Public Grp", slug: "pub", public_enabled: 1,
      custom_domain: "status.public.test", server_ids: [ids.PUB, ids.BOTH],
    });
    assert.equal(r.status, 200, r.text);
    pubId = r.json.id;

    for (const [username, groups] of [["member1", [privId]], ["outsider1", [pubId]]]) {
      r = await admin.post("/api/admin/users", {
        username, password: `${username}-password`, role: "viewer", allowed_group_ids: groups,
      });
      assert.equal(r.status, 200, r.text);
    }
    member   = await login(app, "member1",   "member1-password");
    outsider = await login(app, "outsider1", "outsider1-password");
  });

  after(async () => {
    await Promise.all(Object.values(streams).map(s => s.close()));
    if (app) await app.destroy();
  });

  describe("C: every SSE write is filtered per client", () => {
    let apiKey;

    // Anonymous streams must never carry internal fields; the private-group
    // and slug-less ones must not carry any service at all.
    function assertNothingLeaked(marks, step) {
      const forbidden = {
        anonAll:  [...INTERNAL, PRIV.name, PUB.name, BOTH.name],
        anonPriv: [...INTERNAL, PRIV.name, PUB.name, BOTH.name],
        anonPub:  [...INTERNAL, PRIV.name],
        member:   [PUB.name, PUB.runbook],   // viewer of the private group only
      };
      for (const [who, words] of Object.entries(forbidden)) {
        const text = JSON.stringify(streams[who].since(marks[who]));
        for (const w of words) assert.ok(!text.includes(w), `${step}: ${who} SSE client received ${JSON.stringify(w)}`);
      }
      for (const who of ["anonAll", "anonPriv"]) {
        assert.ok(streams[who].since(marks[who]).every(list => list.length === 0), `${step}: ${who} received services`);
      }
    }
    const marks = () => Object.fromEntries(Object.entries(streams).map(([k, s]) => [k, s.mark()]));
    const sawStatus = (who, from, key, overall, extra = () => true) => streams[who].since(from).some(list => {
      const s = find(list, ids[key]);
      return s && s.overall === overall && extra(s);
    });

    before(async () => {
      const r = await admin.post("/api/admin/api-keys", { name: "ci", scope: "write" });
      assert.equal(r.status, 200, r.text);
      apiKey = r.json.key;
      streams.admin    = await openStream(app, "", admin);
      streams.member   = await openStream(app, "", member);
      streams.anonAll  = await openStream(app);
      streams.anonPriv = await openStream(app, "?slug=priv");
      streams.anonPub  = await openStream(app, "?slug=pub");
      for (const [who, s] of Object.entries(streams)) {
        assert.equal(s.status, 200);
        await until(() => s.mark() > 0, `${who} initial event`);
      }
      // Let the one scheduled poll (interval 3600 s) land first, so it cannot
      // race the status changes below.
      await until(() => streams.admin.since(0).some(list =>
        Object.values(ids).every(id => find(list, id) && find(list, id).lastChecked)), "first poll", 15000);
    });

    test("initial events: anonymous get only the public dashboard they view", () => {
      assertNothingLeaked(Object.fromEntries(Object.keys(streams).map(k => [k, 0])), "initial");
      const pub = streams.anonPub.since(0)[0];
      assert.deepEqual(pub.map(s => s.id).sort(), [ids.PUB, ids.BOTH].sort());
      assert.ok(pub.every(s => !("host" in s) && !("runbook" in s)));
      const adminFirst = streams.admin.since(0)[0];
      assert.equal(find(adminFirst, ids.PRIV).runbook, PRIV.runbook, "admin still gets full records");
    });

    test("status override: anonymous get no host/runbook, admin and public dashboard get the update", async () => {
      const m = marks();
      const r = await admin.patch(`/api/admin/servers/${ids.PUB}/status`, { status: "degraded" });
      assert.equal(r.status, 200, r.text);
      await until(() => sawStatus("admin", m.admin, "PUB", "degraded",
        s => s.runbook === PUB.runbook && /via admin/.test(s.checks[0].detail)), "admin update");
      await until(() => sawStatus("anonPub", m.anonPub, "PUB", "degraded"), "public dashboard update");
      await wait(300);
      assertNothingLeaked(m, "override");
    });

    test("bulk status: anonymous get no host/runbook, admin and public dashboard get the update", async () => {
      const m = marks();
      const r = await admin.post("/api/admin/servers/bulk", { ids: [ids.PRIV, ids.PUB, ids.BOTH], action: "status", status: "up" });
      assert.equal(r.status, 200, r.text);
      await until(() => sawStatus("admin", m.admin, "PRIV", "up", s => s.host === PRIV.host), "admin update");
      await until(() => sawStatus("anonPub", m.anonPub, "BOTH", "up"), "public dashboard update");
      await until(() => sawStatus("member", m.member, "PRIV", "up"), "member update");
      await wait(300);
      assertNothingLeaked(m, "bulk");
    });

    test("API push-status: anonymous get no host/runbook/detail, admin and member get the update", async () => {
      const m = marks();
      const r = await client(app).post(`/api/v1/servers/${ids.PRIV}/push-status`,
        { status: "degraded", detail: PUSH_DETAIL }, { "X-API-Key": apiKey });
      assert.equal(r.status, 200, r.text);
      await until(() => sawStatus("admin", m.admin, "PRIV", "degraded", s => s.checks[0].detail === PUSH_DETAIL), "admin update");
      await until(() => sawStatus("member", m.member, "PRIV", "degraded"), "member update");
      await wait(300);
      assertNothingLeaked(m, "push-status");
    });

    test("a dashboard made private stops streaming to anonymous visitors", async () => {
      const r = await admin.put(`/api/admin/groups/${pubId}`, {
        name: "Public Grp", slug: "pub", public_enabled: 0,
        custom_domain: "status.public.test", server_ids: [ids.PUB, ids.BOTH],
      });
      assert.equal(r.status, 200, r.text);
      try {
        const m = marks();
        const s = await admin.patch(`/api/admin/servers/${ids.PUB}/status`, { status: "down" });
        assert.equal(s.status, 200, s.text);
        await until(() => sawStatus("admin", m.admin, "PUB", "down"), "admin update");
        await wait(300);
        const after = streams.anonPub.since(m.anonPub);
        assert.ok(after.length > 0, "the anonymous client still gets (empty) events");
        assert.ok(after.every(list => list.length === 0), "no services for a private dashboard");
      } finally {
        const back = await admin.put(`/api/admin/groups/${pubId}`, {
          name: "Public Grp", slug: "pub", public_enabled: 1,
          custom_domain: "status.public.test", server_ids: [ids.PUB, ids.BOTH],
        });
        assert.equal(back.status, 200, back.text);
      }
    });
  });

  describe("D: private groups are not readable anonymously", () => {
    const groupPaths = slug => [
      `/dashboard/${slug}`, `/dashboard/${slug}/incidents`, `/dashboard/${slug}/privacy`,
      `/dashboard/${slug}/terms`, `/dashboard/${slug}/feed.rss`, `/dashboard/${slug}/manifest.json`,
      `/status/${slug}`, `/api/icon/${slug}`,
      `/api/public/group/${slug}`, `/api/public/group/${slug}/incidents`,
      `/api/public/group/${slug}/maintenance`, `/api/public/group/${slug}/banners`,
    ];
    const serverPaths = id => [
      `/api/public/uptime/${id}`, `/api/public/response/${id}`, `/api/public/heartbeat/${id}`,
      `/api/public/incidents/${id}`, `/api/badge/${id}/status`, `/api/badge/${id}/uptime`,
      `/api/badge/${id}/ping`, `/api/badge/${id}/cert-exp`,
    ];

    test("anonymous gets 404 for every private-group page, feed and API, like a missing group", async () => {
      const anon = client(app);
      for (const path of [...groupPaths("priv"), ...serverPaths(ids.PRIV)]) {
        const r = await anon.get(path);
        assert.equal(r.status, 404, `${path} -> ${r.status}`);
        for (const w of ["Private Grp", PRIV.name, PRIV.host]) assert.ok(!r.text.includes(w), `${path} leaks ${w}`);
      }
      for (const path of [...groupPaths("no-such-group"), ...serverPaths("no-such-server")]) {
        assert.equal((await anon.get(path)).status, 404, `${path} (missing) should look the same`);
      }
    });

    test("anonymous cannot subscribe to a private group's notifications", async () => {
      const anon = client(app);
      const priv = await anon.post("/api/public/subscribe", { email: "visitor@example.test", group_id: privId });
      assert.equal(priv.status, 404, priv.text);
      const pub = await anon.post("/api/public/subscribe", { email: "visitor@example.test", group_id: pubId });
      assert.equal(pub.status, 200, pub.text);
    });

    test("public groups and their services still return 200 anonymously", async () => {
      const anon = client(app);
      for (const path of [...groupPaths("pub"), ...serverPaths(ids.PUB), ...serverPaths(ids.BOTH)]) {
        const r = await anon.get(path);
        assert.equal(r.status, 200, `${path} -> ${r.status}`);
      }
      const g = await anon.get("/api/public/group/pub");
      assert.deepEqual(g.json.servers.map(s => s.id).sort(), [ids.PUB, ids.BOTH].sort());
      for (const w of [PUB.host, PUB.runbook, BOTH.host, PRIV.name]) assert.ok(!g.text.includes(w), `public group leaks ${w}`);
    });

    test("custom domain: a public group renders, a private one behaves like an unmapped host", async () => {
      const anon = client(app);
      const onHost = (c, host, path = "/") => c.get(path, undefined, { "X-Forwarded-Host": host });
      const pub = await onHost(anon, "status.public.test");
      assert.equal(pub.status, 200);
      assert.ok(pub.text.includes("Public Grp"));
      assert.equal((await onHost(anon, "status.public.test", "/feed.rss")).status, 200);
      for (const path of ["/", "/incidents", "/feed.rss", "/privacy"]) {
        const priv     = await onHost(anon, "status.private.test", path);
        const unmapped = await onHost(anon, "unmapped.example.test", path);
        assert.equal(priv.status, unmapped.status, `${path}: private custom domain differs from an unmapped host`);
        assert.equal(priv.headers.get("location"), unmapped.headers.get("location"), path);
        assert.ok(!priv.text.includes("Private Grp") && !priv.text.includes(PRIV.name), `${path} leaks the private group`);
      }
      const asAdmin = await onHost(admin, "status.private.test");
      assert.equal(asAdmin.status, 200);
      assert.ok(asAdmin.text.includes("Private Grp"), "admin still sees the private custom domain");
    });

    test("admins and granted members keep access to the private group; other viewers get 404", async () => {
      for (const who of [admin, member]) {
        const page = await who.get("/dashboard/priv");
        assert.equal(page.status, 200, `${who.username}: /dashboard/priv -> ${page.status}`);
        assert.ok(page.text.includes("Private Grp"));
        const data = await who.get("/api/public/group/priv");
        assert.equal(data.status, 200, data.text);
        assert.equal(find(data.json.servers, ids.PRIV).host, PRIV.host, "members get the internal view");
        for (const path of ["/dashboard/priv/incidents", "/dashboard/priv/feed.rss", "/api/icon/priv",
          "/api/public/group/priv/incidents", `/api/public/uptime/${ids.PRIV}`, `/api/badge/${ids.PRIV}/status`]) {
          assert.equal((await who.get(path)).status, 200, `${who.username}: ${path}`);
        }
      }
      for (const path of ["/dashboard/priv", "/api/public/group/priv", "/api/public/group/priv/banners"]) {
        assert.equal((await outsider.get(path)).status, 404, `outsider: ${path}`);
      }
      assert.equal((await outsider.get("/dashboard/pub")).status, 200);
    });
  });
});
