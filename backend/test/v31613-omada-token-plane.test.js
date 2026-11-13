"use strict";
// v3.16.13 — Omada token expiry logged false AP/router outages (T-0487).
//
// Two distinct faults, tested separately:
//
//   1. TOKEN: omadaGetToken() cached a token with an expiry it computed itself, and
//      neither omadaApiGet() nor omadaMspApiGet() retried on an auth rejection. When
//      the controller killed a token EARLY (restart, revocation, clock skew), the
//      cache still looked valid, so every poll resent the dead token until our own
//      expiry lapsed. Three observed occurrences lasting 30, 37 and 114 minutes —
//      the duration is whatever remained of the cached lifetime, which is why it grew.
//
//   2. PLANE: an Omada API failure was reported as a DEVICE failure, so one
//      unreadable controller produced N device outages. Six Joe monitors "failed"
//      and recovered in the SAME SECOND, three times, which corrupted the weekly
//      uptime report Richard reads as a site health summary.
//
// The behavioural tests run the real functions against a stub controller, so they
// fail if the retry or the classification is removed. The source assertions cover the
// poll-loop and recordHistory wiring, which needs a live DB to exercise end to end.
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

function namedFunction(name) {
  const re = new RegExp(`async function ${name}\\(|function ${name}\\(`);
  const m  = serverSource.match(re);
  assert.ok(m, `${name} must exist in server.js`);
  const start = m.index;
  // Walk to the function's closing brace at column 0.
  const end = serverSource.indexOf("\n}", start);
  assert.ok(end > start, `${name} must be a top-level function`);
  return serverSource.slice(start, end + 2);
}

// ---------------------------------------------------------------------------
// Harness: evaluate the Omada client in isolation.
//
// server.js boots a web server on require, so the client block is lifted out and
// run against stubs that COUNT calls. That lets a test assert "re-authenticated
// exactly once" rather than merely "did not throw", and lets it prove the retry
// used a DIFFERENT token — the fact that separates a real re-auth from a retry
// that resends the same dead token.
// ---------------------------------------------------------------------------
function buildOmadaClient() {
  const calls  = { auth: 0, get: 0, tokensUsed: [], logs: [], dbUpdates: [] };
  const queue  = { auth: [], get: [] };

  function makeResponse({ status = 200, body = { errorCode: 0, result: {} }, badJson = false }) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => { if (badJson) throw new Error("Unexpected token <"); return body; },
    };
  }

  const stubFetch = async (url, opts = {}) => {
    if (String(url).includes("/authorize/token")) {
      calls.auth += 1;
      const next = queue.auth.shift();
      if (!next) throw new Error("test: unexpected extra auth call");
      if (next.throw) throw next.throw;
      return makeResponse(next);
    }
    calls.get += 1;
    const next = queue.get.shift();
    if (!next) throw new Error("test: unexpected extra GET call");
    calls.tokensUsed.push((opts.headers || {}).Authorization);
    if (next.throw) throw next.throw;
    return makeResponse(next);
  };

  // Lift from the token cache declaration through to the MSP-mode detector.
  const src = sourceBetween(
    "const omadaTokens = {};",
    "// Detect MSP vs standard mode by probing"
  );

  const sandbox = {
    fetch: stubFetch,
    UndiciAgent: class { constructor(o) { this.o = o; } },
    addLog: (e) => { calls.logs.push(e); },
    sanitizeBaseUrl:    async (u) => u,
    sanitizePathSegment: (s) => s,
    db: { query: async (sql, params) => { calls.dbUpdates.push({ sql, params }); return [[]]; } },
    AbortSignal: { timeout: () => undefined },
    Date, Error, String, Array, Math, JSON, console,
  };

  const factory = new Function(
    ...Object.keys(sandbox),
    `${src}
     return { omadaGetToken, omadaApiGet, omadaMspApiGet, omadaAuthedGet,
              omadaInvalidateToken, isOmadaPlaneError, OmadaPlaneError,
              omadaCheckFailure, omadaNoteControllerUnreadable,
              omadaNoteControllerReadable, omadaForgetController,
              OMADA_EXPIRED_TOKEN_RE, omadaTokens };`
  );

  return { api: factory(...Object.values(sandbox)), calls, queue };
}

const CTRL = {
  id: 7, omadac_id: "abc123", client_id: "cid", client_secret: "sec",
  base_url: "https://omada.example", verify_tls: false, mode: "standard",
};

// The exact string the Joe controller returned in all three bursts.
const TOKEN_EXPIRED_MSG =
  "The access token has expired. Please re-initiate the refreshToken process to obtain the access token.";

const authOk = (token, expiresIn = 7200) =>
  ({ body: { errorCode: 0, result: { accessToken: token, expiresIn } } });

const tokenRejected = () => ({ body: { errorCode: -44112, msg: TOKEN_EXPIRED_MSG } });

// -- 1. The token fault ------------------------------------------------------

test("an expired-token response (HTTP 200 + errorCode body) triggers ONE re-auth and succeeds", async () => {
  const { api, calls, queue } = buildOmadaClient();
  queue.auth.push(authOk("DEAD-TOKEN"));
  queue.get.push(tokenRejected());
  queue.auth.push(authOk("FRESH-TOKEN"));
  queue.get.push({ body: { errorCode: 0, result: [{ mac: "AA", status: 1 }] } });

  const result = await api.omadaApiGet(CTRL, "/sites/s1/devices?pageSize=100&page=1");

  assert.deepEqual(result, [{ mac: "AA", status: 1 }], "the retry's result must be returned");
  assert.equal(calls.auth, 2, "must re-authenticate exactly once — not zero, not repeatedly");
  assert.equal(calls.get, 2, "must retry the GET exactly once");
  assert.deepEqual(calls.tokensUsed, ["AccessToken=DEAD-TOKEN", "AccessToken=FRESH-TOKEN"],
    "the retry must use a NEWLY issued token; resending the same one is the original bug");
});

test("HTTP 401 also triggers the re-auth retry", async () => {
  const { api, calls, queue } = buildOmadaClient();
  queue.auth.push(authOk("T1"));
  queue.get.push({ status: 401, body: {} });
  queue.auth.push(authOk("T2"));
  queue.get.push({ body: { errorCode: 0, result: { ok: true } } });

  assert.deepEqual(await api.omadaApiGet(CTRL, "/sites/s1/devices"), { ok: true });
  assert.equal(calls.auth, 2, "a 401 must force a re-auth");
});

test("HTTP 403 triggers the re-auth retry (read-only Viewer role still gets 403 on a dead token)", async () => {
  const { api, calls, queue } = buildOmadaClient();
  queue.auth.push(authOk("T1"));
  queue.get.push({ status: 403, body: {} });
  queue.auth.push(authOk("T2"));
  queue.get.push({ body: { errorCode: 0, result: 1 } });

  assert.equal(await api.omadaApiGet(CTRL, "/x"), 1);
  assert.equal(calls.auth, 2);
});

test("the cached token is REPLACED on rejection, so a later poll cannot resend the dead one", async () => {
  const { api, queue } = buildOmadaClient();
  queue.auth.push(authOk("DEAD"));
  queue.get.push(tokenRejected());
  queue.auth.push(authOk("FRESH"));
  queue.get.push({ body: { errorCode: 0, result: {} } });

  await api.omadaApiGet(CTRL, "/sites/s1/devices");
  assert.equal(api.omadaTokens[CTRL.id].accessToken, "FRESH",
    "the cache must hold the new token, not the rejected one");
});

test("a VALID cached token is reused — the fix must not re-auth on every call", async () => {
  const { api, calls, queue } = buildOmadaClient();
  queue.auth.push(authOk("GOOD"));
  for (let i = 0; i < 3; i++) queue.get.push({ body: { errorCode: 0, result: i } });

  await api.omadaApiGet(CTRL, "/a");
  await api.omadaApiGet(CTRL, "/b");
  await api.omadaApiGet(CTRL, "/c");

  assert.equal(calls.auth, 1, "three successful calls must share one token");
  assert.equal(calls.get, 3);
});

test("the retry is capped at one: a second rejection throws instead of looping", async () => {
  const { api, calls, queue } = buildOmadaClient();
  queue.auth.push(authOk("T1"));
  queue.get.push(tokenRejected());
  queue.auth.push(authOk("T2"));
  queue.get.push(tokenRejected());

  await assert.rejects(
    () => api.omadaApiGet(CTRL, "/sites/s1/devices"),
    /after re-auth/,
    "a persistent rejection must surface, not spin"
  );
  assert.equal(calls.auth, 2, "exactly two auth attempts — no unbounded retry loop");
  assert.equal(calls.get, 2, "exactly two GET attempts");
});

test("proactive refresh: the token is renewed at 75% of its lifetime, not at the last 30s", async () => {
  const { api, calls, queue } = buildOmadaClient();
  queue.auth.push(authOk("T1", 7200));            // 2h lifetime
  await api.omadaGetToken(CTRL);

  const entry = api.omadaTokens[CTRL.id];
  const lifeMs    = entry.expiresAt - (entry.refreshAt - 0.75 * 7200_000);
  const marginMs  = entry.expiresAt - entry.refreshAt;

  assert.ok(marginMs >= 60_000,
    `must renew at least a minute before expiry (margin was ${marginMs}ms) — a flat 30s margin left no room for clock skew`);
  assert.ok(Math.abs(marginMs - 0.25 * 7200_000) < 2000,
    `a 2h token must refresh after ~90min, i.e. a ~30min margin (got ${Math.round(marginMs / 60000)}min)`);
  assert.equal(calls.auth, 1);
  assert.ok(lifeMs > 0); // sanity: the arithmetic above is meaningful
});

test("proactive refresh keeps a minimum 60s margin even for a very short token", async () => {
  const { api, queue } = buildOmadaClient();
  queue.auth.push(authOk("SHORT", 70));           // 70s lifetime
  await api.omadaGetToken(CTRL);
  const e = api.omadaTokens[CTRL.id];
  assert.ok(e.expiresAt - e.refreshAt >= 60_000 - 5,
    "the 60s floor must win over the 75% ratio for a short-lived token");
  assert.ok(e.refreshAt >= Date.now() - 5,
    "refreshAt must not land in the past, which would re-auth on every single call");
});

test("force=true bypasses a cached token our own clock still thinks is valid", async () => {
  const { api, calls, queue } = buildOmadaClient();
  queue.auth.push(authOk("CACHED"));
  assert.equal(await api.omadaGetToken(CTRL), "CACHED");
  assert.equal(await api.omadaGetToken(CTRL), "CACHED", "a fresh token must be reused");
  assert.equal(calls.auth, 1);

  queue.auth.push(authOk("FORCED"));
  assert.equal(await api.omadaGetToken(CTRL, true), "FORCED",
    "force must re-auth — the controller is the authority, not our timer");
  assert.equal(calls.auth, 2);
});

test("the MSP client shares the same retry path, so behaviour cannot drift", async () => {
  const { api, calls, queue } = buildOmadaClient();
  queue.auth.push(authOk("T1"));
  queue.get.push(tokenRejected());
  queue.auth.push(authOk("T2"));
  queue.get.push({ body: { errorCode: 0, result: ["site"] } });

  assert.deepEqual(await api.omadaMspApiGet(CTRL, "/sites?pageSize=1&page=1"), ["site"]);
  assert.equal(calls.auth, 2, "MSP mode must retry too — the bursts hit both modes");
});

test("omadaApiGet and omadaMspApiGet both delegate to the shared authed GET", () => {
  const std = sourceBetween("async function omadaApiGet", "// Authenticated GET to /openapi/v1/msp");
  const msp = sourceBetween("async function omadaMspApiGet", "// Detect MSP vs standard");
  assert.match(std, /omadaAuthedGet\(controller, url, path\)/,
    "the standard client must not keep its own un-retried fetch");
  assert.match(msp, /omadaAuthedGet\(controller, url, path, "MSP"\)/,
    "the MSP client must not keep its own un-retried fetch");
  for (const [name, fn] of [["omadaApiGet", std], ["omadaMspApiGet", msp]]) {
    assert.doesNotMatch(fn, /await fetch\(/,
      `${name} must no longer fetch directly, or the retry can be bypassed`);
  }
});

test("the shared authed GET retries once on rejection and caps the retry", () => {
  const fn = sourceBetween("async function omadaAuthedGet", "// Authenticated GET to /openapi/v1/{omadacId}");
  assert.match(fn, /for \(let attempt = 0; attempt < 2; attempt\+\+\)/,
    "exactly two attempts: the original plus one re-auth, never an unbounded loop");
  assert.match(fn, /omadaGetToken\(controller, attempt > 0\)/,
    "the second attempt must force a fresh token rather than reuse the cache");
  assert.match(fn, /omadaInvalidateToken\(controller\.id\)/,
    "the rejected token must be cleared from the cache, not left to expire on our clock");
  assert.match(fn, /omadaNoteControllerReadable\(controller\.id\)/,
    "a successful read must clear the controller-health warning");
});

// -- The classifier: controller-read failure vs real device failure ----------

test("a controller read failure yields an indeterminate result, a device failure does not", () => {
  const fn = sourceBetween("function omadaCheckFailure", "// One warning per controller");
  assert.match(fn, /if \(!isOmadaPlaneError\(e\)\)/,
    "must branch on the classification");
  assert.match(fn, /return \{ type, ok:false, detail: msg \}/,
    "a real device failure must still report ok:false so a true outage still pages");
  assert.match(fn, /indeterminate: true/,
    "a plane fault must be tagged so the poll loop can exclude it");
  assert.match(fn, /ok: null/,
    "a plane fault is neither up nor down — it must not be ok:false");
  assert.match(fn, /Controller unreadable/,
    "the detail must say the controller was unreadable, not that the device is down");
});

test("all three Omada checks route their catch through omadaCheckFailure", () => {
  for (const name of ["omadaGatewayCheck", "omadaDeviceCheck", "omadaLteCheck"]) {
    const re = new RegExp(`async function ${name}[\\s\\S]*?\\n\\}`, "m");
    const fn = serverSource.match(re);
    assert.ok(fn, `${name} must exist`);
    assert.match(fn[0], /return omadaCheckFailure\(/,
      `${name} must classify its errors, not report every failure as a device outage`);
    assert.doesNotMatch(fn[0], /ok:false, detail: e\.message \}/,
      `${name} must not keep the old unclassified catch`);
  }
});

test("runChecks keeps an escaped plane fault indeterminate", () => {
  const fn = sourceBetween("async function runChecks", "// -- History + Incident tracking");
  assert.match(fn, /isOmadaPlaneError\(e\)/,
    "the catch-all must still classify, or ok:false would reinstate the fabricated outage");
  assert.match(fn, /omadaCheckFailure\(c\.type, e, c\.controller_id\)/,
    "an Omada plane fault escaping as a raw throw must still become indeterminate");
});

// -- 3. The poll loop must not turn a blind check into an outage -------------

test("the poll loop excludes indeterminate checks from the status calculation", () => {
  const loop = sourceBetween("const checks     = await runChecks(def);", "const inMaintenance");
  assert.match(loop, /const decisive\s+= checks\.filter\(c => !c\.indeterminate\)/,
    "indeterminate checks must be separated from device-state checks");
  assert.match(loop, /decisive\.every\(c=>c\.ok\) \? "up" : decisive\.some\(c=>c\.ok\) \? "degraded" : "down"/,
    "the status must be computed from decisive checks only");
  assert.match(loop, /!decisive\.length\s*\n?\s*\? null/,
    "a fully indeterminate poll must yield null, not a fabricated status");
});

test("a fully blind poll holds the previous status instead of reporting down", () => {
  const loop = sourceBetween("const checks     = await runChecks(def);", "const inMaintenance");
  assert.match(loop, /if \(rawOverall === null\) \{\s*\n\s*overall = \(prev\.overall && prev\.overall !== "pending"\) \? prev\.overall : "pending";/,
    "with nothing measurable, the last known device state must be retained");
});

test("a blind poll records no uptime sample — neither up nor down", () => {
  const loop = sourceBetween("const checks     = await runChecks(def);", "const inMaintenance");
  assert.match(loop, /rawOverall === null\s*\n?\s*\? \(prev\.uptimeHistory \|\| \[\]\)\.slice\(-90\)/,
    "a blind poll must not append to the uptime history; `null === \"up\"` is false, " +
    "so the unguarded form pushed a FALSE sample and deflated the figures");
});

test("a blind poll neither starts nor resets a fail streak", () => {
  const loop = sourceBetween("const threshold = Math.max(1, def.failure_threshold || 1);", "checks.forEach");
  assert.match(loop, /rawOverall === null \? \(prev\.failStreak \|\| 0\)/,
    "a blind poll must carry the existing streak forward unchanged");
});

test("the uptime rollup skips indeterminate checks", () => {
  const fn = sourceBetween("async function recordHistory", "// Incident detection");
  assert.match(fn, /if \(ch\.indeterminate\) continue;/,
    "an indeterminate check must not become a status_history row");
  // status_history.ok is NOT NULL, so there is no third value to store: 0 manufactures
  // the uptime deficit and 1 would hide a real outage. Skipping the row is the fix.
  assert.match(fn, /NOT NULL/,
    "the comment must record WHY the row is skipped rather than stored as NULL");
  assert.match(fn, /INSERT INTO status_history/,
    "decisive checks are still recorded");
});

test("a monitoring-plane failure cannot open or close a device incident", () => {
  const fn = sourceBetween("// Incident detection", "// Auto-close open incident");
  assert.match(fn, /const decisiveChecks = checks\.filter\(c => !c\.indeterminate\)/,
    "the incident path must separate decisive from indeterminate checks");
  assert.match(fn, /if \(!decisiveChecks\.length\) return;/,
    "a poll with no device evidence must neither open nor close an incident");
  assert.match(fn, /const cause = decisiveChecks\.filter\(c => !c\.ok\)/,
    "the incident cause must not be built from controller-read errors");
});

test("the incident auto-close ignores indeterminate checks", () => {
  // The guard sits on the `else if` line, which precedes the "Auto-close" comment.
  const fn = sourceBetween("// Incident detection", "function fmtWebhookTime");
  assert.match(fn, /overall === "up" && open\.length > 0 && decisiveChecks\.every\(c => c\.ok\)/,
    "recovery must be judged on real check results, not on an unreadable controller");
  assert.doesNotMatch(fn, /checks\.length > 0 && checks\.every\(c => c\.ok\)/,
    "the old unfiltered form would let an indeterminate poll resolve a live incident");
});

test("controller health is tracked once per controller, not once per monitor", () => {
  const block = sourceBetween("const _omadaUnreadable = {}", "// Called after any successful controller read");
  assert.match(block, /_omadaUnreadable\[key\]/,
    "health must be keyed by controller");
  assert.match(block, /if \(!prev\) \{/,
    "only the FIRST failure may alert — six monitors must not emit six alerts");
  assert.match(block, /OMADA_UNREADABLE_RELOG_MS/,
    "a continuing fault must re-log on a cooldown, not on every poll of every monitor");
  assert.match(block, /last_error/,
    "the fault must be recorded against the controller row an operator can see");
});

test("a successful controller read clears the plane-health warning", () => {
  const fn = sourceBetween("function omadaNoteControllerReadable", "// Returns an undici dispatcher");
  assert.match(fn, /delete _omadaUnreadable\[key\]/,
    "recovery must clear the warning state");
  assert.match(fn, /readable again after/,
    "recovery must be reported so a silent permanent warning cannot accumulate");
  assert.match(fn, /last_error=NULL/,
    "the controller row must be cleared too, or the UI shows a stale error forever");
});

test("the expired-token pattern matches the real Omada error code", () => {
  // -?4401[12] (an earlier draft) reads as 4401 + [12] and does NOT match -44112,
  // the code the controller actually returns. Caught by testing the pattern against
  // the verbatim codes from the three bursts.
  const line = sourceBetween("const OMADA_EXPIRED_TOKEN_RE", ";");
  assert.match(line, /4411\[12\]/,
    "must match -44112 / -44111, the real expired/invalid token codes");
  assert.doesNotMatch(line, /4401\[12\]/,
    "the 4401 form never matched the real code");
});

// -- 4. The original incident, end to end ------------------------------------

test("regression: the T-0487 shape — one dead token, six monitors, no fabricated outage", async () => {
  // Six monitors share one controller whose token was killed early. Under the old
  // code each produced ok:false with a device-shaped detail, and the poll loop
  // opened six incidents that all resolved in the same second.
  const { api, calls, queue } = buildOmadaClient();

  queue.auth.push(authOk("DEAD"));
  queue.get.push(tokenRejected());
  queue.auth.push(authOk("FRESH"));
  queue.get.push({ body: { errorCode: 0, result: [{ mac: "AA", status: 1 }] } });

  // The first monitor's read recovers in-band via the retry.
  const devices = await api.omadaApiGet(CTRL, "/sites/s1/devices?pageSize=100&page=1");
  assert.equal(devices[0].status, 1, "the first monitor recovers within its own poll");

  // The remaining five reuse the fresh cached token with no further auth.
  for (let i = 0; i < 5; i++) {
    queue.get.push({ body: { errorCode: 0, result: [{ mac: "AA", status: 1 }] } });
    const d = await api.omadaApiGet(CTRL, "/sites/s1/devices?pageSize=100&page=1");
    assert.equal(d[0].status, 1, `monitor ${i + 2} must read the device as connected`);
  }

  assert.equal(calls.auth, 2,
    "exactly two auths for all six monitors: the original plus one shared forced re-auth");
  assert.equal(api.omadaTokens[CTRL.id].accessToken, "FRESH");
  assert.equal(calls.logs.filter(l => l.check === "CONTROLLER").length, 0,
    "a self-healed token must not raise a controller warning at all");
});

test("regression: a genuinely unreachable controller yields indeterminate for all six, not down", async () => {
  // The retry cannot help when the controller is hard down. The requirement is that
  // this is indeterminate, so no device incident is opened and uptime is not charged.
  const { api, calls, queue } = buildOmadaClient();
  const results = [];

  for (let i = 0; i < 6; i++) {
    queue.auth.push(authOk(`T${i}`));
    queue.get.push({ throw: new Error("The operation was aborted due to timeout") });
    try {
      await api.omadaApiGet(CTRL, "/sites/s1/devices");
      assert.fail("expected the read to throw");
    } catch (e) {
      results.push(api.omadaCheckFailure("omada_device", e, CTRL.id));
    }
  }

  assert.equal(results.length, 6);
  for (const r of results) {
    assert.equal(r.ok, null, "every monitor must be indeterminate, never down");
    assert.equal(r.indeterminate, true);
  }
  assert.equal(calls.logs.filter(l => l.check === "CONTROLLER").length, 1,
    "six unreadable monitors must raise exactly one controller warning");
});

test("regression: a real device outage still opens an incident after the fix", async () => {
  // The guard against false positives must not suppress true ones. A successful
  // controller read that reports status 0 is real evidence and must fail decisively.
  const { api, queue } = buildOmadaClient();
  queue.auth.push(authOk("T1"));
  queue.get.push({ body: { errorCode: 0, result: [{ mac: "AA", status: 0 }] } });

  const devices = await api.omadaApiGet(CTRL, "/sites/s1/devices");
  assert.equal(devices[0].status, 0, "the read succeeded and the device reports offline");

  // That path never reaches omadaCheckFailure: the check returns ok:false directly.
  const gw = namedFunction("omadaGatewayCheck");
  assert.match(gw, /offline \(status \$\{gateway\.status\}\)/,
    "a device reporting offline must still produce a decisive ok:false result");
  assert.doesNotMatch(gw, /indeterminate: true/,
    "the offline path must not be tagged indeterminate, or real outages go unreported");
});

// -- 6. Review findings (code review + two security passes on ec022d2) ------
//
// Five defects were found after the first commit. Each is pinned here so it cannot
// regress. The first is the most consequential: the fix stopped the false INCIDENT
// but the alert channels still rendered the indeterminate check as a red failure,
// so an operator would have seen "AP down" anyway.

test("review-1: alert payloads exclude indeterminate checks entirely", () => {
  // `cause` was filtered, but the `checks` array passed into the event was not, and it
  // drops the `indeterminate` flag. Every alert renderer then does `filter(c => !c.ok)`
  // and `c.ok ? "✅" : "❌"` — and ok:null is falsy, so an unreadable controller was
  // shown to the operator as a failed check, in all five alert channels.
  const unfiltered = serverSource.match(
    /checks:\s+checks\.map\(c => \(\{ type:c\.type/g
  ) || [];
  assert.equal(unfiltered.length, 0,
    `every alert payload must filter indeterminate checks; ${unfiltered.length} unfiltered site(s) remain`);

  const filtered = serverSource.match(
    /checks:\s+checks\.filter\(c => !c\.indeterminate\)\.map\(c => \(\{ type:c\.type/g
  ) || [];
  assert.ok(filtered.length >= 4,
    `expected at least 4 filtered alert payload sites, found ${filtered.length}`);
});

test("review-1b: the renderers' !c.ok predicate is why filtering at the source matters", () => {
  // Documents the coupling: the renderers treat any falsy ok as a failure, so the
  // payload is the only correct place to drop an indeterminate check.
  assert.match(serverSource, /c\.ok \? "✅" : "❌"/,
    "renderers still use a binary ok -> icon mapping, so ok:null must never reach them");
});

test("review-2: omadaListDevices' final throw preserves the plane classification", () => {
  const fn = namedFunction("omadaListDevices");
  assert.match(fn, /throw lastErr \|\| new OmadaPlaneError\("All MSP device path variants failed", "api"\)/,
    "a plain Error here classifies as a DEVICE failure, reinstating the false outage " +
    "for the one path that only runs when the controller could not be read");
});

test("review-3: the transport matcher cannot match inside a device name", () => {
  const { api } = buildOmadaClient();
  // Bare /certificate/ and /self.signed/ matched any device whose NAME contained them,
  // silently reclassifying that device's real outage as indeterminate — i.e. dropping
  // it from status, history, incidents and alerting.
  const deviceNames = [
    "Certificate-Office-AP offline (status 0)",
    "AP-Certificates not found in site",
    "self-signed-cert-lab-AP offline (status 0)",
    "Token-Expired-Test-AP offline (status 0)",
    "Unauthorized-Zone-AP not found in site",
    "ER605-Unauthorized-VLAN offline (status 0)",
  ];
  for (const m of deviceNames) {
    assert.equal(api.isOmadaPlaneError(new Error(m)), false,
      `a device name must not trigger plane classification: ${m}`);
  }
});

test("review-3b: narrowing did not break any real controller error", () => {
  const { api } = buildOmadaClient();
  // Every string below is either verbatim from the three bursts or constructed by this
  // code. Narrowing the matchers must not lose any of them.
  const realErrors = [
    TOKEN_EXPIRED_MSG,
    "/sites/69c17da8/devices?pageSize=100&page=1 HTTP 502",
    "The operation was aborted due to timeout",
    "token HTTP 500",
    "MSP /sites HTTP 403",
    "fetch failed",
    "connect ECONNREFUSED 10.0.0.1:443",
    "connect ETIMEDOUT 10.8.0.2:443",
    "self signed certificate in certificate chain",
    "token request: connect ETIMEDOUT 10.0.0.1:443",
    "/x: invalid JSON response: Unexpected token <",
    "Invalid access token",
    "MSP /sites: unauthorized",
  ];
  for (const m of realErrors) {
    assert.equal(api.isOmadaPlaneError(new Error(m)), true,
      `must still be classified as a controller-read failure: ${m}`);
  }
  // And the real Omada error code still matches.
  for (const code of ["-44112", "-44111", "44112"]) {
    assert.equal(api.OMADA_EXPIRED_TOKEN_RE.test(code), true,
      `the real expired-token errorCode must match: ${code}`);
  }
});

test("review-4: deleting a controller drops its cached unreadable state", () => {
  const { api } = buildOmadaClient();
  api.omadaCheckFailure("omada_device", new api.OmadaPlaneError(TOKEN_EXPIRED_MSG, "auth"), 99);
  api.omadaForgetController(99);
  // Proven by behaviour: after forgetting, the next failure logs as a FIRST failure
  // again rather than incrementing a stale entry for a controller that no longer exists.
  const { calls } = (() => {
    const h = buildOmadaClient();
    h.api.omadaCheckFailure("omada_device", new h.api.OmadaPlaneError(TOKEN_EXPIRED_MSG, "auth"), 99);
    h.api.omadaForgetController(99);
    h.calls.logs.length = 0;
    h.api.omadaCheckFailure("omada_device", new h.api.OmadaPlaneError(TOKEN_EXPIRED_MSG, "auth"), 99);
    return h;
  })();
  assert.equal(calls.logs.filter(l => l.check === "CONTROLLER").length, 1,
    "after forgetting, a new failure must log as a first failure, not increment a stale entry");

  assert.match(serverSource, /omadaForgetController\(id\);/,
    "the controller DELETE handler must prune the unreadable-state entry");
});

test("review-5: the LTE probe loop stops at the first plane fault", () => {
  const fn = namedFunction("omadaLteCheck");
  assert.match(fn, /if \(isOmadaPlaneError\(e\)\) throw e;/,
    "8 discovery probes each carrying a re-auth retry is up to 16 token POSTs per poll " +
    "against a controller already rejecting us; it must abort on the first plane fault");
  // The per-path failure must still be swallowed — that is what the probes are for.
  assert.match(fn, /LTE probe \$\{path\}: \$\{e\.message\}/,
    "an ordinary per-path probe failure must still be logged and tolerated");
});
