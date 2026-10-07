"use strict";
// Live HTTP test support: boots the real server.js against a throwaway
// MariaDB database so tests can exercise routes the way a browser would.
//
// Enabled only when TEST_DB_HOST points at a MariaDB/MySQL server whose user
// may CREATE and DROP databases (the CI `live` job, or scripts/test-with-db.sh
// locally). Otherwise `skip` holds a reason string and live suites are
// skipped, so a plain `npm test` still needs no database.
//
// Lives outside test/ so `node --test` does not run it as a test file.
const { spawn } = require("node:child_process");
const crypto    = require("node:crypto");
const net       = require("node:net");
const path      = require("node:path");
const mysql     = require("mysql2/promise");

const BACKEND = path.resolve(__dirname, "..");
const DB = {
  host:     process.env.TEST_DB_HOST,
  port:     Number(process.env.TEST_DB_PORT || 3306),
  user:     process.env.TEST_DB_USER || "root",
  password: process.env.TEST_DB_PASSWORD || "",
};
const skip = DB.host ? false : "live HTTP test: set TEST_DB_HOST (see scripts/test-with-db.sh)";

// Requests look like they came through the production reverse proxy
// (trust proxy = 1): HTTPS, so the session cookie is issued, from a fixed IP.
const PROXY_HEADERS = { "X-Forwarded-Proto": "https", "X-Forwarded-For": "203.0.113.10" };

const wait = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function withServerConnection(fn, database) {
  const conn = await mysql.createConnection(database ? { ...DB, database } : DB);
  try { return await fn(conn); } finally { await conn.end(); }
}

/** Run SQL against a test database, e.g. to seed fixtures or inspect stored state. */
function query(dbName, sql, params) {
  return withServerConnection(async c => (await c.query(sql, params))[0], dbName);
}

/**
 * Start server.js on a free port against `dbName`, or against a new empty
 * database when omitted. Resolves once /healthz answers 200; `env` overrides
 * the defaults below. stop() sends SIGTERM and keeps the database, so a second
 * startApp({ dbName }) can test behaviour across a restart. destroy() stops
 * the process and drops the database if this call created it.
 */
async function startApp({ dbName, env = {}, timeoutMs = 90000 } = {}) {
  if (!DB.host) throw new Error("TEST_DB_HOST is not set");
  const ownsDb = !dbName;
  if (ownsDb) {
    dbName = "t_" + crypto.randomBytes(6).toString("hex");
    await withServerConnection(c => c.query(`CREATE DATABASE \`${dbName}\``));
  }
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: BACKEND,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV:       "production",
      LOG_LEVEL:      process.env.TEST_LOG_LEVEL || "warn",
      PORT:           String(port),
      DB_HOST:        DB.host,
      DB_PORT:        String(DB.port),
      DB_USER:        DB.user,
      DB_PASSWORD:    DB.password,
      DB_NAME:        dbName,
      SESSION_SECRET: crypto.randomBytes(32).toString("hex"),
      EXTERNAL_URL:   base,
      TZ:             "America/Los_Angeles",
      CHECK_INTERVAL: "60000",
      ...env,
    },
  });
  let output = "";
  const capture = chunk => { output = (output + chunk).slice(-20000); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  const running = () => child.exitCode === null && child.signalCode === null;

  const app = {
    base, port, dbName, child,
    /** Last 20 kB of the server's stdout+stderr, for assertion messages. */
    output: () => output,
    async stop(graceMs = 20000) {
      if (running()) {
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
        try { await exited; } finally { clearTimeout(timer); }
      }
      return exited;
    },
    async destroy() {
      await app.stop();
      if (ownsDb) await withServerConnection(c => c.query(`DROP DATABASE IF EXISTS \`${dbName}\``));
    },
  };

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!running()) {
      await app.destroy();
      throw new Error(`server.js exited during boot (${child.exitCode ?? child.signalCode}):\n${output.slice(-3000)}`);
    }
    try {
      const r = await fetch(base + "/healthz", { signal: AbortSignal.timeout(2000) });
      if (r.status === 200) return app;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) {
      await app.destroy();
      throw new Error(`server.js was not healthy within ${timeoutMs} ms:\n${output.slice(-3000)}`);
    }
    await wait(500);
  }
}

/**
 * A cookie-holding HTTP client, like one browser tab. Requests carry the proxy
 * headers and never follow redirects, so tests can assert on them.
 *   const r = await c.post("/api/login", { username, password });
 *   r.status, r.headers, r.text, r.json (null unless the body is JSON)
 */
function client(app, { headers: defaults = {} } = {}) {
  const c = { cookie: "" };
  c.request = async (method, urlPath, body, headers = {}) => {
    const h = { ...PROXY_HEADERS, ...defaults, ...headers };
    if (body !== undefined) h["Content-Type"] = "application/json";
    if (c.cookie) h.Cookie = c.cookie;
    const r = await fetch(app.base + urlPath, {
      method, headers: h, redirect: "manual",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sid = r.headers.getSetCookie().find(s => s.startsWith("connect.sid="));
    if (sid) c.cookie = sid.split(";")[0];
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, headers: r.headers, text, json };
  };
  for (const m of ["get", "post", "put", "patch", "delete"]) {
    c[m] = (urlPath, body, headers) => c.request(m.toUpperCase(), urlPath, body, headers);
  }
  return c;
}

/** First-run setup; returns a client logged in as the new admin (with .username/.password). */
async function setupAdmin(app, username = "rootadmin") {
  const password = crypto.randomBytes(12).toString("hex");
  const admin = client(app);
  const r = await admin.post("/api/setup", { username, password });
  if (r.status !== 200) throw new Error(`setup failed: ${r.status} ${r.text}`);
  return Object.assign(admin, { username, password });
}

/** Log in as an existing user; returns the logged-in client. */
async function login(app, username, password) {
  const c = client(app);
  const r = await c.post("/api/login", { username, password });
  if (r.status !== 200) throw new Error(`login as ${username} failed: ${r.status} ${r.text}`);
  return Object.assign(c, { username, password });
}

/**
 * Open the /api/events SSE stream as `who` (a client, or null for anonymous)
 * and collect everything it sends. received() returns the text so far.
 */
async function openEvents(app, who = null) {
  const ctrl = new AbortController();
  const headers = { ...PROXY_HEADERS };
  if (who && who.cookie) headers.Cookie = who.cookie;
  const r = await fetch(app.base + "/api/events", { headers, signal: ctrl.signal });
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
  return {
    status: r.status,
    received: () => text,
    async close() { ctrl.abort(); await reading; },
  };
}

module.exports = { skip, startApp, client, setupAdmin, login, openEvents, query, wait, PROXY_HEADERS };
