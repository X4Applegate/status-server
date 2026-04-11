const express      = require("express");
const { exec }     = require("child_process");
const net          = require("net");
const http         = require("http");
const https        = require("https");
const fs           = require("fs");
const path         = require("path");
const mysql        = require("mysql2/promise");
const bcrypt       = require("bcryptjs");
const session      = require("express-session");

const app  = express();
const PORT          = process.env.PORT           || 3000;
const CONFIG_PATH   = process.env.CONFIG_PATH    || "/config/servers.json";
const CHECK_INTERVAL= parseInt(process.env.CHECK_INTERVAL || "30000");
const LOG_MAX       = 500;

// -- DB config (from env) ------------------------------------------------------
const DB_HOST = process.env.DB_HOST     || "mariadb";
const DB_PORT = parseInt(process.env.DB_PORT || "3306");
const DB_USER = process.env.DB_USER     || "root";
const DB_PASS = process.env.DB_PASSWORD || "";
const DB_NAME = process.env.DB_NAME     || "status_monitor";

// -- Initial admin credentials (used only on first run) -----------------------
const INIT_USER = process.env.ADMIN_USERNAME || "admin";
const INIT_PASS = process.env.ADMIN_PASSWORD || "changeme";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-secret-in-production";

// -- Global safety net ---------------------------------------------------------
// Catch any unhandled promise rejection or exception so one bug can't kill the poll
// loop. We log and keep running — much better UX than a crash-restart loop.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason && reason.stack || reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err && err.stack || err);
});

// -- State ---------------------------------------------------------------------
let db;
let serverStatus = {};
let sseClients   = [];
let logClients   = [];
let serverConfig = [];
let eventLog     = [];

// -- View engine ---------------------------------------------------------------
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// -- Middleware ----------------------------------------------------------------
// 1 MB limit lets group logo data URLs (max 256KB after our validation) fit comfortably
app.use(express.json({ limit: "1mb" }));

// Ensure all /api routes return JSON and are never cached
app.use("/api", (req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, maxAge: 24 * 60 * 60 * 1000 } // 24h
}));

// Auth middleware � protects admin routes
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: "Unauthorized" });
}

// For HTML page routes — redirect to /login instead of returning JSON 401
function requireAuthPage(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.redirect("/login");
}

// Admin-only middleware
function requireAdmin(req, res, next) {
  if (req.session && req.session.userId && req.session.role === "admin") return next();
  if (req.session && req.session.userId) return res.status(403).json({ error: "Forbidden � admin only" });
  res.status(401).json({ error: "Unauthorized" });
}

// -- Logger --------------------------------------------------------------------
function addLog(entry) {
  const record = { id: Date.now() + Math.random(), ts: new Date().toISOString(), ...entry };
  eventLog.push(record);
  if (eventLog.length > LOG_MAX) eventLog.shift();
  const payload = JSON.stringify(record);
  logClients = logClients.filter(r => !r.writableEnded);
  logClients.forEach(r => r.write(`data: ${payload}\n\n`));
  const icon = entry.level === "error" ? "x" : entry.level === "warn" ? "!" : "+";
  console.log(`[${entry.level||"info"}] ${icon} ${entry.server||""} - ${entry.message}`);
}

// -- Database setup ------------------------------------------------------------
async function initDB() {
  // Retry loop � MariaDB may not be ready immediately on first boot
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      db = await mysql.createPool({
        host: DB_HOST, port: DB_PORT,
        user: DB_USER, password: DB_PASS,
        database: DB_NAME,
        waitForConnections: true,
        connectionLimit: 10
      });
      await db.query("SELECT 1"); // test connection
      addLog({ level:"info", server:"system", message:`Database connected (${DB_HOST}:${DB_PORT}/${DB_NAME})` });
      break;
    } catch(err) {
      addLog({ level:"warn", server:"system", message:`DB connect attempt ${attempt}/10 failed: ${err.message}` });
      if (attempt === 10) throw err;
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // Create tables
  await db.query(`
    CREATE TABLE IF NOT EXISTS status_users (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      username      VARCHAR(100) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role          ENUM('admin','viewer') NOT NULL DEFAULT 'viewer',
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Add role column if upgrading from older version
  try {
    await db.query("ALTER TABLE status_users ADD COLUMN role ENUM('admin','viewer') NOT NULL DEFAULT 'viewer'");
  } catch(e) { /* column already exists, ignore */ }

  await db.query(`
    CREATE TABLE IF NOT EXISTS status_servers (
      id                VARCHAR(150) PRIMARY KEY,
      name              VARCHAR(255) NOT NULL,
      host              VARCHAR(255) NOT NULL,
      description       TEXT,
      tags              JSON,
      checks            JSON,
      sort_order        INT DEFAULT 0,
      poll_interval_sec INT NOT NULL DEFAULT 30,
      created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  try {
    await db.query("ALTER TABLE status_servers ADD COLUMN poll_interval_sec INT NOT NULL DEFAULT 30");
  } catch(e) { /* column already exists */ }

  await db.query(`
    CREATE TABLE IF NOT EXISTS status_history (
      id          BIGINT AUTO_INCREMENT PRIMARY KEY,
      server_id   VARCHAR(150) NOT NULL,
      check_type  VARCHAR(50)  NOT NULL,
      ok          TINYINT(1)   NOT NULL,
      response_ms INT          DEFAULT NULL,
      detail      VARCHAR(255) DEFAULT NULL,
      checked_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_server_time (server_id, checked_at)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS status_incidents (
      id          BIGINT AUTO_INCREMENT PRIMARY KEY,
      server_id   VARCHAR(150) NOT NULL,
      server_name VARCHAR(255) NOT NULL,
      started_at  TIMESTAMP NOT NULL,
      ended_at    TIMESTAMP NULL DEFAULT NULL,
      duration_s  INT       NULL DEFAULT NULL,
      cause       VARCHAR(255) DEFAULT NULL,
      INDEX idx_server (server_id)
    )
  `);

  // Many-to-many: a server can belong to multiple dashboards (groups)
  await db.query(`
    CREATE TABLE IF NOT EXISTS status_server_group_map (
      server_id  VARCHAR(150) NOT NULL,
      group_id   INT          NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (server_id, group_id),
      INDEX idx_server (server_id),
      INDEX idx_group (group_id)
    )
  `);

  // One-time data migration: if the new map table is empty but servers have legacy group_id values,
  // back-fill the map from the old column. After this, the column is a fossil — we only read the map.
  try {
    const [mapCount] = await db.query("SELECT COUNT(*) AS cnt FROM status_server_group_map");
    if (mapCount[0].cnt === 0) {
      const [legacy] = await db.query("SELECT id, group_id FROM status_servers WHERE group_id IS NOT NULL");
      if (legacy.length > 0) {
        const values = legacy.map(r => [r.id, r.group_id]);
        await db.query("INSERT INTO status_server_group_map (server_id, group_id) VALUES ?", [values]);
        addLog({ level:"info", server:"system", message:`Migrated ${legacy.length} server→group assignments into the new many-to-many map` });
      }
    }
  } catch(e) {
    addLog({ level:"warn", server:"system", message:`server→group migration skipped: ${e.message}` });
  }

  // Per-user dashboard access — viewers only see servers in groups they're explicitly granted
  await db.query(`
    CREATE TABLE IF NOT EXISTS status_user_groups (
      user_id    INT NOT NULL,
      group_id   INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, group_id),
      INDEX idx_user (user_id),
      INDEX idx_group (group_id)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS status_omada_controllers (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      name          VARCHAR(150) NOT NULL,
      base_url      VARCHAR(255) NOT NULL,
      client_id     VARCHAR(255) NOT NULL,
      client_secret VARCHAR(255) NOT NULL,
      omadac_id     VARCHAR(64)  DEFAULT NULL,
      verify_tls    TINYINT(1)   NOT NULL DEFAULT 1,
      mode          VARCHAR(16)  NOT NULL DEFAULT 'standard',
      group_id      INT          DEFAULT NULL,
      last_error    TEXT         DEFAULT NULL,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Upgrade-safe: add group_id column for installs that pre-date per-group ownership
  try {
    await db.query("ALTER TABLE status_omada_controllers ADD COLUMN group_id INT DEFAULT NULL");
  } catch(e) { /* column already exists */ }

  // Add mode column on existing installs
  try {
    await db.query("ALTER TABLE status_omada_controllers ADD COLUMN mode VARCHAR(16) NOT NULL DEFAULT 'standard'");
  } catch(e) { /* column already exists, ignore */ }

  await db.query(`
    CREATE TABLE IF NOT EXISTS status_groups (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      slug          VARCHAR(64)  UNIQUE NOT NULL,
      name          VARCHAR(150) NOT NULL,
      description   VARCHAR(255) DEFAULT '',
      logo_text     VARCHAR(8)   DEFAULT '',
      logo_image    MEDIUMTEXT   DEFAULT NULL,
      accent_color  VARCHAR(16)  DEFAULT '#2a7fff',
      bg_color      VARCHAR(16)  DEFAULT NULL,
      default_theme VARCHAR(8)   NOT NULL DEFAULT 'dark',
      custom_domain VARCHAR(255) DEFAULT NULL,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  try {
    await db.query("ALTER TABLE status_groups ADD COLUMN custom_domain VARCHAR(255) DEFAULT NULL");
  } catch(e) { /* column already exists */ }
  try {
    await db.query("CREATE UNIQUE INDEX idx_custom_domain ON status_groups (custom_domain)");
  } catch(e) { /* index already exists */ }

  // Upgrade-safe: add columns for installs created before these features
  try {
    await db.query("ALTER TABLE status_groups ADD COLUMN logo_image MEDIUMTEXT DEFAULT NULL");
  } catch(e) { /* column already exists */ }
  try {
    await db.query("ALTER TABLE status_groups ADD COLUMN default_theme VARCHAR(8) NOT NULL DEFAULT 'dark'");
  } catch(e) { /* column already exists */ }
  try {
    await db.query("ALTER TABLE status_groups ADD COLUMN bg_color VARCHAR(16) DEFAULT NULL");
  } catch(e) { /* column already exists */ }
  // Per-dashboard logo size (in pixels, applied to the topbar-icon square). 42 = current default.
  try {
    await db.query("ALTER TABLE status_groups ADD COLUMN logo_size INT NOT NULL DEFAULT 42");
  } catch(e) { /* column already exists */ }

  // Add group_id column to status_servers if upgrading from older version
  try {
    await db.query("ALTER TABLE status_servers ADD COLUMN group_id INT NULL");
  } catch(e) { /* column already exists, ignore */ }

  await db.query(`
    CREATE TABLE IF NOT EXISTS status_webhooks (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      name             VARCHAR(150) NOT NULL,
      url              TEXT         NOT NULL,
      enabled          TINYINT(1)   NOT NULL DEFAULT 1,
      fire_on_down     TINYINT(1)   NOT NULL DEFAULT 1,
      fire_on_recovery TINYINT(1)   NOT NULL DEFAULT 1,
      format           ENUM('auto','generic','discord','slack') NOT NULL DEFAULT 'auto',
      group_id         INT          DEFAULT NULL,
      created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Upgrade-safe: add group_id column so per-group ownership works on existing installs
  try {
    await db.query("ALTER TABLE status_webhooks ADD COLUMN group_id INT DEFAULT NULL");
  } catch(e) { /* column already exists */ }

  // Create default admin user if no users exist
  const [users] = await db.query("SELECT COUNT(*) as cnt FROM status_users");
  if (users[0].cnt === 0) {
    const hash = await bcrypt.hash(INIT_PASS, 10);
    await db.query("INSERT INTO status_users (username, password_hash, role) VALUES (?, ?, 'admin')", [INIT_USER, hash]);
    addLog({ level:"info", server:"system", message:`Created default admin user: ${INIT_USER}` });
  }

  // Migrate servers.json ? DB if DB is empty
  const [rows] = await db.query("SELECT COUNT(*) as cnt FROM status_servers");
  if (rows[0].cnt === 0) {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, "utf8");
      const imported = JSON.parse(raw);
      for (const s of imported) {
        await db.query(
          "INSERT IGNORE INTO status_servers (id, name, host, description, tags, checks) VALUES (?,?,?,?,?,?)",
          [s.id, s.name, s.host, s.description||"", JSON.stringify(s.tags||[]), JSON.stringify(s.checks||[])]
        );
      }
      addLog({ level:"info", server:"system", message:`Migrated ${imported.length} server(s) from servers.json to database` });
    } catch(e) {
      addLog({ level:"warn", server:"system", message:`No servers.json to migrate: ${e.message}` });
    }
  }
}

// Return the set of group ids this server currently belongs to (many-to-many)
async function getServerGroupIds(serverId) {
  const [rows] = await db.query(
     "SELECT group_id FROM status_server_group_map WHERE server_id=?",
     [serverId]
  );
  return rows.map(r => r.group_id);
}

// Atomically replace the set of groups a server belongs to with the given list.
// Empty/null clears the server out of all groups.
async function setServerGroupIds(serverId, groupIds) {
  await db.query("DELETE FROM status_server_group_map WHERE server_id=?", [serverId]);
  if (Array.isArray(groupIds) && groupIds.length) {
    const values = groupIds
      .map(g => parseInt(g))
      .filter(Number.isFinite)
      .map(g => [serverId, g]);
    if (values.length) {
      await db.query("INSERT INTO status_server_group_map (server_id, group_id) VALUES ?", [values]);
    }
  }
}

// -- Config loader (from DB) ---------------------------------------------------
async function loadConfig() {
  try {
    const [rows] = await db.query("SELECT * FROM status_servers ORDER BY sort_order, created_at");
    // Load all (server_id, group_id) pairs in one query and bucket them
    const [mapRows] = await db.query("SELECT server_id, group_id FROM status_server_group_map");
    const groupsByServer = {};
    for (const m of mapRows) {
      (groupsByServer[m.server_id] ||= []).push(m.group_id);
    }
    serverConfig = rows.map(r => ({
      id:                r.id,
      name:              r.name,
      host:              r.host,
      description:       r.description || "",
      poll_interval_sec: r.poll_interval_sec || 30,
      group_ids:         groupsByServer[r.id] || [],
      tags:              typeof r.tags   === "string" ? JSON.parse(r.tags)   : (r.tags   || []),
      checks:            typeof r.checks === "string" ? JSON.parse(r.checks) : (r.checks || [])
    }));

    serverConfig.forEach(s => {
      if (!serverStatus[s.id]) {
        serverStatus[s.id] = { id:s.id, name:s.name, host:s.host, description:s.description, group_ids:s.group_ids, tags:s.tags, checks:[], overall:"pending", lastChecked:null, uptimeHistory:[] };
      } else {
        // Keep group_ids in sync on existing entries
        serverStatus[s.id].group_ids = s.group_ids;
      }
    });

    // Remove stale status entries for deleted servers
    const ids = new Set(serverConfig.map(s => s.id));
    Object.keys(serverStatus).forEach(id => { if (!ids.has(id)) delete serverStatus[id]; });

  } catch(err) {
    addLog({ level:"error", server:"system", message:`loadConfig failed: ${err.message}` });
  }
}

// -- Check functions -----------------------------------------------------------
function pingCheck(host) {
  return new Promise(resolve => {
    exec(`ping -c 2 -W 2 ${host}`, (err, stdout) => {
      if (err) return resolve({ type:"ping", ok:false, detail:"No response" });
      const match = stdout.match(/rtt[^=]+=\s*([\d.]+)\/([\d.]+)/);
      resolve({ type:"ping", ok:true, detail: match ? `${Math.round(parseFloat(match[2]))}ms` : "ok" });
    });
  });
}

function tcpCheck(host, port, timeout=3000) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok, detail) => { if(done)return; done=true; socket.destroy(); resolve({type:"tcp",port,ok,detail}); };
    socket.setTimeout(timeout);
    socket.on("connect", () => finish(true,  `port ${port} open`));
    socket.on("timeout", () => finish(false, `port ${port} timeout`));
    socket.on("error",   () => finish(false, `port ${port} refused`));
    socket.connect(port, host);
  });
}

// HTTPS agent that disables session caching + keep-alive. Without this, Node reuses
// the TLS session on subsequent polls and getPeerCertificate() returns an empty {} —
// so cert expiry info only shows up on the very first poll and never again.
const httpsNoCacheAgent = new https.Agent({ maxCachedSessions: 0, keepAlive: false });

function httpCheck(url, expectedStatus=200, timeout=5000, showCert=true) {
  return new Promise(resolve => {
    // Guard against missing/malformed URLs and case-insensitive protocol detection —
    // "Https://example.com" (capital H) used to slip through startsWith("https") and crash
    // because the http module rejects https:// URLs.
    if (typeof url !== "string" || !url.trim()) {
      return resolve({ type:"http", url, ok:false, detail:"missing URL" });
    }
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch(e) {
      return resolve({ type:"http", url, ok:false, detail:`invalid URL: ${e.message}` });
    }
    const isHttps = parsedUrl.protocol === "https:";
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return resolve({ type:"http", url, ok:false, detail:`unsupported protocol: ${parsedUrl.protocol}` });
    }
    const lib = isHttps ? https : http;
    // Use the no-cache agent for HTTPS so each poll triggers a fresh TLS handshake
    // (required for getPeerCertificate() to return actual cert data every time).
    const reqOpts = { timeout };
    if (isHttps) reqOpts.agent = httpsNoCacheAgent;
    const req = lib.get(parsedUrl.toString(), reqOpts, res => {
      const ok = res.statusCode === expectedStatus;
      const result = { type:"http", url, ok, detail:`HTTP ${res.statusCode}` };
      // Attach TLS certificate info (for HTTPS only, and only when the check has cert
      // tracking enabled). Used by the detail view to show "SSL expires in N days" and
      // warn when <14 days.
      if (showCert && isHttps && res.socket && typeof res.socket.getPeerCertificate === "function") {
        try {
          const cert = res.socket.getPeerCertificate();
          if (cert && cert.valid_to) {
            const expiry = new Date(cert.valid_to);
            const days   = Math.round((expiry.getTime() - Date.now()) / 86400000);
            result.cert = {
              expires_at: expiry.toISOString(),
              days_left:  days,
              subject:    cert.subject && (cert.subject.CN || cert.subject.O) || null,
              issuer:     cert.issuer  && (cert.issuer.O  || cert.issuer.CN) || null
            };
            // Flip to warning or error if the cert is expiring/expired
            if (days < 0) {
              result.ok = false;
              result.detail = `HTTP ${res.statusCode} · SSL EXPIRED ${-days}d ago`;
            } else if (days < 14) {
              result.detail = `HTTP ${res.statusCode} · SSL expires in ${days}d`;
            }
          }
        } catch(e) { console.log("[httpCheck cert error]", url, e.message); }
      }
      resolve(result);
      res.resume();
    });
    req.on("error",   e  => resolve({ type:"http", url, ok:false, detail:e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ type:"http", url, ok:false, detail:"timeout" }); });
  });
}

function udpCheck(host, port, timeout=3000) {
  const p = parseInt(port);
  if (!p || p < 1 || p > 65535) {
    return Promise.resolve({ type:"udp", port, ok:false, detail:"invalid port" });
  }
  return new Promise(resolve => {
    const dgram = require("dgram");
    const socket = dgram.createSocket("udp4");
    let done = false;
    let timer;
    const finish = (ok, detail) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.close(); } catch(_) {}
      resolve({ type:"udp", port:p, ok, detail });
    };
    socket.on("message", () => finish(true, `UDP :${p} reachable`));
    socket.on("error", err => {
      if (err.code === "ECONNREFUSED") finish(true, `UDP :${p} reachable (ICMP)`);
      else finish(false, `UDP :${p} ${err.code}`);
    });
    timer = setTimeout(() => finish(false, `UDP :${p} no response`), timeout);
    socket.bind(() => {
      const probe = Buffer.alloc(4);
      socket.send(probe, 0, probe.length, p, host, err => {
        if (err) finish(false, `UDP :${p} send failed`);
      });
    });
  });
}

// Resolve a DNS record and optionally compare against an expected value.
// Returns the standard { type, ok, detail } shape. Supports A, AAAA, CNAME, MX, TXT, NS.
function dnsCheck(hostname, recordType = "A", expected = "", timeout = 5000) {
  const dns = require("dns").promises;
  const type = (recordType || "A").toUpperCase();
  const resolvers = {
    A:     (h) => dns.resolve4(h),
    AAAA:  (h) => dns.resolve6(h),
    CNAME: (h) => dns.resolveCname(h),
    MX:    (h) => dns.resolveMx(h).then(rs => rs.map(r => `${r.priority} ${r.exchange}`)),
    TXT:   (h) => dns.resolveTxt(h).then(rs => rs.map(parts => parts.join(""))),
    NS:    (h) => dns.resolveNs(h),
  };
  const resolver = resolvers[type];
  if (!resolver) return Promise.resolve({ type:"dns", ok:false, detail:`Unknown record type: ${type}` });
  if (!hostname)  return Promise.resolve({ type:"dns", ok:false, detail:"Missing hostname" });

  return Promise.race([
    resolver(String(hostname).trim())
      .then(values => {
        if (!values || !values.length) {
          return { type:"dns", ok:false, detail:`${type} ${hostname}: no records` };
        }
        // If the admin specified an expected value, it must match any of the returned records
        if (expected && expected.trim()) {
          const exp = expected.trim();
          const match = values.some(v => String(v).includes(exp));
          if (!match) {
            return { type:"dns", ok:false, detail:`${type} ${hostname} = ${values.join(", ")} (wanted ${exp})` };
          }
        }
        return { type:"dns", ok:true, detail:`${type} ${hostname} → ${values.slice(0, 3).join(", ")}${values.length>3?"…":""}` };
      })
      .catch(err => ({ type:"dns", ok:false, detail:`${type} ${hostname}: ${err.code || err.message}` })),
    new Promise(resolve => setTimeout(
      () => resolve({ type:"dns", ok:false, detail:`${type} ${hostname}: timeout` }),
      timeout
    ))
  ]);
}

// -- Omada Open API client -----------------------------------------------------
const fetch = require("node-fetch");
const omadaTokens = {}; // { controllerId: { accessToken, expiresAt } }

function omadaAgent(verifyTls) {
  return verifyTls ? undefined : new https.Agent({ rejectUnauthorized: false });
}

// Hit /api/info on a controller to discover its omadacId. No auth required.
async function omadaGetInfo(baseUrl, verifyTls) {
  const url = `${baseUrl.replace(/\/$/, "")}/api/info`;
  const r = await fetch(url, { agent: omadaAgent(verifyTls), timeout: 8000 });
  if (!r.ok) throw new Error(`/api/info HTTP ${r.status}`);
  const data = await r.json();
  if (data.errorCode !== 0) throw new Error(data.msg || "info error");
  return data.result; // { omadacId, controllerVer, ... }
}

// Get a (cached) access token for a controller. Re-auths if missing or near expiry.
async function omadaGetToken(controller) {
  const cached = omadaTokens[controller.id];
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.accessToken;
  if (!controller.omadac_id) throw new Error("omadacId not set on controller");
  const url = `${controller.base_url.replace(/\/$/, "")}/openapi/authorize/token?grant_type=client_credentials`;
  const body = JSON.stringify({
    omadacId:      controller.omadac_id,
    client_id:     controller.client_id,
    client_secret: controller.client_secret
  });
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body, agent: omadaAgent(controller.verify_tls), timeout: 8000
  });
  if (!r.ok) throw new Error(`token HTTP ${r.status}`);
  const data = await r.json();
  if (data.errorCode !== 0) throw new Error(data.msg || "auth error");
  const accessToken = data.result?.accessToken;
  const expiresIn   = data.result?.expiresIn || 7200;
  if (!accessToken) throw new Error("no accessToken in response");
  omadaTokens[controller.id] = { accessToken, expiresAt: Date.now() + expiresIn * 1000 };
  return accessToken;
}

// Authenticated GET to /openapi/v1/{omadacId}<path>  (standard mode)
async function omadaApiGet(controller, path) {
  const token = await omadaGetToken(controller);
  const url   = `${controller.base_url.replace(/\/$/, "")}/openapi/v1/${controller.omadac_id}${path}`;
  const r = await fetch(url, {
    headers: { Authorization: `AccessToken=${token}` },
    agent:   omadaAgent(controller.verify_tls),
    timeout: 8000
  });
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
  const data = await r.json();
  if (data.errorCode !== 0) throw new Error(data.msg || `${path} error`);
  return data.result;
}

// Authenticated GET to /openapi/v1/msp/{mspId}<path>  (MSP mode — different URL shape)
// mspId is the same value as omadacId in practice; if your controller exposes a separate
// mspId, we'll switch to that field, but for now they're equal.
async function omadaMspApiGet(controller, path) {
  const token = await omadaGetToken(controller);
  const mspId = controller.omadac_id;
  const url   = `${controller.base_url.replace(/\/$/, "")}/openapi/v1/msp/${mspId}${path}`;
  const r = await fetch(url, {
    headers: { Authorization: `AccessToken=${token}` },
    agent:   omadaAgent(controller.verify_tls),
    timeout: 8000
  });
  if (!r.ok) throw new Error(`MSP ${path} HTTP ${r.status}`);
  const data = await r.json();
  if (data.errorCode !== 0) throw new Error(data.msg || `MSP ${path} error`);
  return data.result;
}

// Detect MSP vs standard mode by probing the actual MSP path documented for v6:
//   GET /openapi/v1/msp/{mspId}/sites
// Returns "msp" if it works, "standard" if the standard /sites works, otherwise gives up.
async function detectOmadaMode(controller) {
  try {
    await omadaMspApiGet(controller, "/sites?pageSize=1&page=1");
    addLog({ level:"info", server:"omada", message:`Mode detect: MSP /openapi/v1/msp/${controller.omadac_id}/sites SUCCESS for controller ${controller.id}` });
    return "msp";
  } catch(e) {
    addLog({ level:"info", server:"omada", message:`Mode detect: MSP probe → ${e.message}` });
  }
  try {
    await omadaApiGet(controller, "/sites?pageSize=1&page=1");
    addLog({ level:"info", server:"omada", message:`Mode detect: standard /sites SUCCESS for controller ${controller.id}` });
    return "standard";
  } catch(e) {
    addLog({ level:"warn", server:"omada", message:`Mode detect: standard /sites ALSO failed: ${e.message}` });
    return "standard";
  }
}

// List sites — MSP returns a flat list across all customers (each site object
// already carries its customer info via customerId / customerName fields).
async function omadaListSites(controller) {
  if (controller.mode === "msp") {
    const result = await omadaMspApiGet(controller, "/sites?pageSize=100&page=1");
    const sites  = Array.isArray(result) ? result : (result.data || []);
    return sites.map(s => ({
      siteId:       s.siteId || s.id,
      name:         s.name || s.siteName || s.siteId || s.id,
      customerId:   s.customerId || s.customer_id || null,
      customerName: s.customerName || s.customer_name || ""
    }));
  }
  // Standard mode
  const result = await omadaApiGet(controller, "/sites?pageSize=100&page=1");
  return Array.isArray(result) ? result : (result.data || []);
}

// Fetch all "known devices" across the MSP (flat list, all customers, all sites)
// and filter to just the ones for the requested site.
//
// IMPORTANT: the /devices/known-devices endpoint does NOT return siteId per device —
// only siteName and customerName. So we filter by NAME, using the site_name and
// customer_name fields stored on the check at pick time.
async function omadaMspKnownDevices(controller, siteId, siteName, customerName) {
  const result = await omadaMspApiGet(controller, `/devices/known-devices?pageSize=500&page=1`);
  const all =
    Array.isArray(result)            ? result :
    Array.isArray(result?.data)      ? result.data :
    Array.isArray(result?.devices)   ? result.devices :
    Array.isArray(result?.list)      ? result.list :
    Array.isArray(result?.knownDevices) ? result.knownDevices :
    [];

  return all.filter(d => {
    // Prefer name match (this is what the API actually returns)
    if (siteName && d.siteName === siteName) {
      if (customerName) return d.customerName === customerName;
      return true;
    }
    // Fallback: if some firmware DOES return siteId, match it
    const sid = d.siteId || d.site_id || (d.site && (d.site.siteId || d.site.id));
    return sid && sid === siteId;
  });
}

// Cache the working device-list path per controller so we don't probe on every poll
const _deviceVariantById = {}; // controllerId -> variant key

async function omadaListDevices(controller, siteId, customerId, siteName, customerName) {
  if (controller.mode !== "msp") {
    const result = await omadaApiGet(controller, `/sites/${siteId}/devices?pageSize=100&page=1`);
    return Array.isArray(result) ? result : (result.data || []);
  }

  // MSP mode — try the cached working variant first, otherwise probe candidates in order.
  // "msp-known-devices" is the documented path (flat list, filter by siteName client-side).
  const candidates = [
    { key: "msp-known-devices", fn: () => omadaMspKnownDevices(controller, siteId, siteName, customerName) },
    { key: "msp-sites",         fn: () => omadaMspApiGet(controller, `/sites/${siteId}/devices?pageSize=100&page=1`) },
    { key: "standard-sites",    fn: () => omadaApiGet(controller,    `/sites/${siteId}/devices?pageSize=100&page=1`) },
  ];
  const cachedKey = _deviceVariantById[controller.id];
  if (cachedKey) {
    const cached = candidates.find(c => c.key === cachedKey);
    if (cached) {
      try {
        const result = await cached.fn();
        return Array.isArray(result) ? result : (result.data || []);
      } catch(e) {
        addLog({ level:"warn", server:"omada", message:`MSP device path ${cachedKey} stopped working: ${e.message}` });
        delete _deviceVariantById[controller.id];
      }
    }
  }
  let lastErr;
  for (const c of candidates) {
    try {
      const result = await c.fn();
      _deviceVariantById[controller.id] = c.key;
      addLog({ level:"info", server:"omada", message:`MSP device path: using ${c.key} for controller ${controller.id}` });
      return Array.isArray(result) ? result : (result.data || []);
    } catch(e) {
      lastErr = e;
      addLog({ level:"info", server:"omada", message:`MSP device path ${c.key} → ${e.message}` });
    }
  }
  throw lastErr || new Error("All MSP device path variants failed");
}

// Tracks which controllers we've already logged a "device shape diagnostic" for,
// so we don't spam logs every 30 seconds.
const _omadaShapeLogged = new Set();

// Look up a controller from DB and check its gateway in a given site.
// Returns the same shape as other check functions: { type, ok, detail }
async function omadaGatewayCheck(controllerId, siteId, customerId, siteName, customerName) {
  try {
    const [rows] = await db.query("SELECT * FROM status_omada_controllers WHERE id=?", [controllerId]);
    if (!rows.length) return { type:"omada_gateway", ok:false, detail:"controller not found" };
    const ctrl = rows[0];
    // For MSP checks created BEFORE site_name was tracked, we don't have the names on
    // the check. Resolve them on the fly by listing sites and matching by siteId.
    if (ctrl.mode === "msp" && !siteName) {
      try {
        const sites = await omadaListSites(ctrl);
        const match = sites.find(s => (s.siteId || s.id) === siteId);
        if (match) { siteName = match.name; customerName = match.customerName; }
      } catch(e) { /* fall through, the check will report an error */ }
    }
    const devices = await omadaListDevices(ctrl, siteId, customerId, siteName, customerName);

    // Match gateway by several heuristics — type/deviceType strings, numeric type,
    // and model name (Omada gateway hardware all starts with "ER").
    const isGateway = (d) => {
      const t  = (d.type || d.deviceType || "").toString().toLowerCase();
      const m  = (d.model || d.modelName || d.product || "").toString().toUpperCase();
      const dn = (d.deviceName || "").toString().toLowerCase();
      return t === "gateway"
          || t.includes("gateway")
          || t.includes("router")
          || dn.includes("gateway")
          || /^ER\d/.test(m)        // ER605, ER7206, ER7212PC, ER8411…
          || d.type === 0;
    };
    const gateway = devices.find(isGateway);

    if (!gateway) {
      // First time we hit this on a given controller, log the device shape so we can debug
      const tag = `${controllerId}:${siteId}`;
      if (!_omadaShapeLogged.has(tag)) {
        _omadaShapeLogged.add(tag);
        if (devices.length === 0) {
          addLog({ level:"warn", server:"omada", message:`Site ${siteId}: 0 devices returned (siteId filter may be wrong — check /devices/known-devices response shape)` });
        } else {
          const sample = devices.slice(0, 3).map(d => JSON.stringify({
            name: d.name, mac: d.mac, type: d.type, deviceType: d.deviceType,
            model: d.model || d.modelName || d.product, status: d.status,
            siteId: d.siteId || d.site_id
          })).join(" | ");
          addLog({ level:"warn", server:"omada", message:`Site ${siteId}: ${devices.length} devices found but no gateway. First 3: ${sample}` });
        }
      }
      return { type:"omada_gateway", ok:false, detail: devices.length ? `no gateway among ${devices.length} devices` : "no devices in site" };
    }

    // Omada device.status: 1 = Connected (Wired), 11 = Connected (Wireless), 0 = Disconnected
    const ok = gateway.status === 1 || gateway.status === 11;
    const name = gateway.name || gateway.deviceName || gateway.model || gateway.modelName || gateway.mac || "gateway";
    const detail = ok
      ? `${name} connected`
      : `${name} offline (status ${gateway.status})`;
    return { type:"omada_gateway", ok, detail };
  } catch(e) {
    return { type:"omada_gateway", ok:false, detail: e.message };
  }
}

async function runChecks(def) {
  return Promise.all((def.checks||[{type:"ping"}]).map(async c => {
    // Wrap every check in a try/catch so one malformed check (bad URL, etc.)
    // can never crash the poll loop or leak an unhandled rejection.
    try {
      if (c.type==="ping")          return await pingCheck(def.host);
      if (c.type==="tcp")           return await tcpCheck(def.host, c.port, c.timeout);
      if (c.type==="http")          return await httpCheck(c.url, c.expectedStatus, c.timeout, c.show_cert !== false);
      if (c.type==="udp")           return await udpCheck(def.host, c.port, c.timeout);
      if (c.type==="dns")           return await dnsCheck(c.hostname || def.host, c.record_type, c.expected, c.timeout);
      if (c.type==="omada_gateway") return await omadaGatewayCheck(c.controller_id, c.site_id, c.customer_id, c.site_name, c.customer_name);
      return { type:c.type, ok:false, detail:"unknown check type" };
    } catch(e) {
      return { type:c.type, ok:false, detail:`check error: ${e.message}` };
    }
  }));
}


// -- History + Incident tracking -----------------------------------------------
async function recordHistory(def, checks, overall) {
  const now = new Date();
  try {
    // Store each check result
    for (const ch of checks) {
      let ms = null;
      if (ch.ok && ch.detail) {
        const match = ch.detail.match(/(\d+)\s*ms/);
        if (match) ms = parseInt(match[1]);
      }
      const label = ch.type === "ping"          ? "ping"
                  : ch.type === "tcp"           ? `tcp:${ch.port}`
                  : ch.type === "udp"           ? `udp:${ch.port}`
                  : ch.type === "http"          ? "http"
                  : ch.type === "dns"           ? `dns:${(ch.record_type||"A").toUpperCase()}`
                  : ch.type === "omada_gateway" ? "omada_gateway"
                  : ch.type;
      await db.query(
        "INSERT INTO status_history (server_id, check_type, ok, response_ms, detail, checked_at) VALUES (?,?,?,?,?,?)",
        [def.id, label, ch.ok ? 1 : 0, ms, ch.detail || null, now]
      );
    }

    // Incident detection � look at the primary check result (overall)
    const [open] = await db.query(
      "SELECT * FROM status_incidents WHERE server_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
      [def.id]
    );

    if (overall !== "up" && open.length === 0) {
      // New incident
      const cause = checks.filter(c => !c.ok).map(c => c.detail).join(", ");
      await db.query(
        "INSERT INTO status_incidents (server_id, server_name, started_at, cause) VALUES (?,?,?,?)",
        [def.id, def.name, now, cause]
      );
    } else if (overall === "up" && open.length > 0) {
      // Close open incident
      const dur = Math.round((now - new Date(open[0].started_at)) / 1000);
      await db.query(
        "UPDATE status_incidents SET ended_at=?, duration_s=? WHERE id=?",
        [now, dur, open[0].id]
      );
    }

    // Prune history older than 90 days
    await db.query(
      "DELETE FROM status_history WHERE server_id=? AND checked_at < DATE_SUB(NOW(), INTERVAL 90 DAY)",
      [def.id]
    );
  } catch(e) {
    addLog({ level:"warn", server:"system", message:`recordHistory failed: ${e.message}` });
  }
}

// -- Webhooks ------------------------------------------------------------------
function buildWebhookPayload(format, evt) {
  // evt: { server, host, status, previous, cause, time, isRecovery }
  const emoji = evt.isRecovery ? "✅" : (evt.status === "down" ? "🔴" : "🟠");
  const verb  = evt.isRecovery ? "recovered" : (evt.status === "down" ? "is DOWN" : "is DEGRADED");
  const title = `${emoji} ${evt.server} ${verb}`;
  const lines = [
    `**Server:** ${evt.server}`,
    `**Host:** ${evt.host}`,
    `**Status:** ${evt.previous.toUpperCase()} → ${evt.status.toUpperCase()}`,
    evt.cause ? `**Cause:** ${evt.cause}` : null,
    `**Time:** ${evt.time}`
  ].filter(Boolean).join("\n");

  if (format === "discord") {
    return {
      embeds: [{
        title,
        description: lines,
        color: evt.isRecovery ? 0x10e88a : (evt.status === "down" ? 0xff3d5a : 0xff8c2a),
        timestamp: evt.time
      }]
    };
  }
  if (format === "slack") {
    return { text: `${title}\n${lines.replace(/\*\*/g, "*")}` };
  }
  // generic
  return {
    event: evt.isRecovery ? "server.recovered" : "server.down",
    server: evt.server,
    host: evt.host,
    status: evt.status,
    previous: evt.previous,
    cause: evt.cause || null,
    time: evt.time
  };
}

function detectFormat(url) {
  if (/discord(app)?\.com\/api\/webhooks/i.test(url)) return "discord";
  if (/hooks\.slack\.com/i.test(url)) return "slack";
  return "generic";
}

function postWebhook(url, body) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch(e) { return reject(new Error("Invalid URL")); }
    const lib = parsed.protocol === "https:" ? https : http;
    const data = Buffer.from(JSON.stringify(body));
    const req = lib.request({
      method: "POST",
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": data.length,
        "User-Agent": "status-monitor-webhook/1.0"
      },
      timeout: 8000
    }, res => {
      let chunks = "";
      res.on("data", c => { if (chunks.length < 500) chunks += c.toString(); });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode });
        else reject(new Error(`HTTP ${res.statusCode}${chunks ? ": " + chunks.slice(0, 200) : ""}`));
      });
    });
    req.on("error",   e => reject(e));
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(data);
    req.end();
  });
}

async function fireWebhooks(evt) {
  let hooks;
  try {
    // A global webhook (group_id IS NULL) fires for any server. A group-scoped webhook
    // fires only when the affected server is a member of that group (many-to-many).
    const serverGroupIds = Array.isArray(evt.serverGroupIds) ? evt.serverGroupIds : [];
    let rows;
    if (serverGroupIds.length === 0) {
      // Server is not in any group → only global webhooks fire
      [rows] = await db.query("SELECT * FROM status_webhooks WHERE enabled=1 AND group_id IS NULL");
    } else {
      [rows] = await db.query(
        "SELECT * FROM status_webhooks WHERE enabled=1 AND (group_id IS NULL OR group_id IN (?))",
        [serverGroupIds]
      );
    }
    hooks = rows;
  } catch(e) {
    addLog({ level:"warn", server:"webhook", message:`Failed to load webhooks: ${e.message}` });
    return;
  }
  for (const h of hooks) {
    if (evt.isRecovery && !h.fire_on_recovery) continue;
    if (!evt.isRecovery && !h.fire_on_down)    continue;
    const fmt  = h.format === "auto" ? detectFormat(h.url) : h.format;
    const body = buildWebhookPayload(fmt, evt);
    // Fire-and-forget with one retry
    (async () => {
      try {
        await postWebhook(h.url, body);
        addLog({ level:"info", server:"webhook", message:`Sent "${h.name}" for ${evt.server} (${evt.isRecovery?"recovery":evt.status})` });
      } catch(e1) {
        addLog({ level:"warn", server:"webhook", message:`Webhook "${h.name}" attempt 1 failed: ${e1.message}` });
        await new Promise(r => setTimeout(r, 1500));
        try {
          await postWebhook(h.url, body);
          addLog({ level:"info", server:"webhook", message:`Sent "${h.name}" on retry for ${evt.server}` });
        } catch(e2) {
          addLog({ level:"error", server:"webhook", message:`Webhook "${h.name}" failed: ${e2.message}` });
        }
      }
    })();
  }
}

// -- Poll ----------------------------------------------------------------------
// Tracks last-polled epoch (ms) per server, so per-server intervals work.
// `pollAll(force=true)` ignores the schedule and polls every server (used by /api/refresh).
const _lastPolled = {};
async function pollAll(force = false) {
  const now = new Date().toISOString();
  const nowMs = Date.now();
  // Pick only servers that are DUE for polling based on their poll_interval_sec.
  // Default interval is 30s; servers can override to be faster (e.g. 20s) or slower.
  const due = force
    ? serverConfig
    : serverConfig.filter(def => {
        const interval = Math.max(10, def.poll_interval_sec || 30) * 1000;
        const last = _lastPolled[def.id] || 0;
        return (nowMs - last) >= interval;
      });
  if (!due.length) return;
  due.forEach(def => { _lastPolled[def.id] = nowMs; });
  await Promise.all(due.map(async def => {
    const checks  = await runChecks(def);
    const overall = checks.every(c=>c.ok) ? "up" : checks.some(c=>c.ok) ? "degraded" : "down";
    const prev    = serverStatus[def.id] || {};
    const history = [...(prev.uptimeHistory||[]), overall==="up"].slice(-20);

    checks.forEach(c => {
      const label =
        c.type === "ping"          ? "PING" :
        c.type === "tcp"           ? `TCP :${c.port}` :
        c.type === "udp"           ? `UDP :${c.port}` :
        c.type === "http"          ? "HTTP" :
        c.type === "dns"           ? `DNS ${(c.record_type||"A").toUpperCase()}` :
        c.type === "omada_gateway" ? "OMADA-GW" :
        c.type.toUpperCase();
      addLog({ level:c.ok?"info":"error", server:def.name, serverId:def.id, check:label, message:`${label} - ${c.detail}`, ok:c.ok, detail:c.detail });
    });

    if (prev.overall && prev.overall!=="pending" && prev.overall!==overall) {
      addLog({ level:overall==="up"?"info":"error", server:def.name, serverId:def.id, check:"STATUS", message:`Status changed: ${prev.overall.toUpperCase()} -> ${overall.toUpperCase()}`, ok:overall==="up", isStatusChange:true });

      // Fire webhooks on down/degraded transitions and recoveries
      const isRecovery = overall === "up";
      const isDownward = overall === "down" || overall === "degraded";
      if (isRecovery || isDownward) {
        fireWebhooks({
          server:          def.name,
          host:            def.host,
          status:          overall,
          previous:        prev.overall,
          cause:           checks.filter(c => !c.ok).map(c => c.detail).join(", ") || null,
          time:            now,
          isRecovery,
          serverGroupIds:  def.group_ids || []
        }).catch(() => {});
      }
    }

    serverStatus[def.id] = { id:def.id, name:def.name, host:def.host, description:def.description||"", group_ids:def.group_ids||[], tags:def.tags||[], checks, overall, lastChecked:now, uptimeHistory:history };
    // Record to DB (non-blocking)
    recordHistory(def, checks, overall).catch(() => {});
  }));

  // Each SSE client gets a payload filtered to what they're allowed to see —
  // admins get everything, viewers get their granted groups, public gets any grouped server.
  const all = Object.values(serverStatus);
  sseClients = sseClients.filter(r => !r.writableEnded);
  sseClients.forEach(r => {
    const subset = filterServersForSseClient(r, all);
    r.write(`data: ${JSON.stringify(subset)}\n\n`);
  });
}

// -- Auth routes ---------------------------------------------------------------
// Compute the landing page after login. Admins land on the master dashboard "/"
// so they see everything at a glance. Viewers land on their first assigned
// dashboard (e.g. AnthemAdmin → /dashboard/anthemstatus) so they immediately see
// the branded page for the group they manage, not a generic master view.
async function computeLoginRedirect(userId, role) {
  if (role === "admin") return "/";
  try {
    const allowed = await getUserAllowedGroupIds(userId, role);
    if (!Array.isArray(allowed) || allowed.length === 0) return "/";
    const [rows] = await db.query(
      "SELECT slug FROM status_groups WHERE id IN (?) ORDER BY id LIMIT 1",
      [allowed]
    );
    if (rows.length && rows[0].slug) return `/dashboard/${rows[0].slug}`;
  } catch(_) { /* fall through to safe default */ }
  return "/";
}

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error:"Username and password required" });
  try {
    const [rows] = await db.query("SELECT * FROM status_users WHERE username = ?", [username]);
    if (!rows.length) return res.status(401).json({ error:"Invalid credentials" });
    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error:"Invalid credentials" });
    req.session.userId   = rows[0].id;
    req.session.username = rows[0].username;
    req.session.role     = rows[0].role;
    addLog({ level:"info", server:"auth", message:`Login: ${username} (${rows[0].role})` });
    const redirect = await computeLoginRedirect(rows[0].id, rows[0].role);
    res.json({ ok:true, username: rows[0].username, role: rows[0].role, redirect });
  } catch(err) {
    res.status(500).json({ error:err.message });
  }
});

app.post("/api/logout", (req, res) => {
  const user = req.session.username || "unknown";
  req.session.destroy(() => {
    addLog({ level:"info", server:"auth", message:`Logout: ${user}` });
    res.json({ ok:true });
  });
});

app.get("/api/me", async (req, res) => {
  if (req.session && req.session.userId) {
    try {
      const allowed = await getUserAllowedGroupIds(req.session.userId, req.session.role);
      const login_redirect = await computeLoginRedirect(req.session.userId, req.session.role);
      res.json({
        loggedIn: true,
        username: req.session.username,
        role:     req.session.role,
        allowed_group_ids: allowed,  // null for admin (unrestricted), array for viewer
        login_redirect               // where "already logged in" visitors should bounce to
      });
    } catch(e) {
      res.json({ loggedIn:true, username: req.session.username, role: req.session.role, allowed_group_ids: [], login_redirect: "/" });
    }
  } else {
    res.json({ loggedIn:false });
  }
});

// Change password
app.post("/api/admin/change-password", requireAdmin, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error:"Both fields required" });
  if (newPassword.length < 8) return res.status(400).json({ error:"Password must be at least 8 characters" });
  try {
    const [rows] = await db.query("SELECT * FROM status_users WHERE id = ?", [req.session.userId]);
    if (!rows.length) return res.status(404).json({ error:"User not found" });
    const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error:"Current password incorrect" });
    const hash = await bcrypt.hash(newPassword, 10);
    await db.query("UPDATE status_users SET password_hash = ? WHERE id = ?", [hash, req.session.userId]);
    addLog({ level:"info", server:"auth", message:`Password changed: ${rows[0].username}` });
    res.json({ ok:true });
  } catch(err) {
    res.status(500).json({ error:err.message });
  }
});

// -- Public API ----------------------------------------------------------------
app.get("/api/status", (req, res) => res.json(Object.values(serverStatus)));

app.get("/api/logs", (req, res) => {
  let logs = [...eventLog].reverse();
  if (req.query.server) logs = logs.filter(l => l.serverId===req.query.server||l.server===req.query.server);
  if (req.query.level)  logs = logs.filter(l => l.level===req.query.level);
  res.json(logs.slice(0, Math.min(parseInt(req.query.limit||"200"), LOG_MAX)));
});

app.get("/api/events", async (req, res) => {
  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","no-cache");
  res.setHeader("Connection","keep-alive");
  res.flushHeaders();
  // Tag the connection so the broadcaster knows what to send.
  // - Admin    → full server list (all groups + ungrouped)
  // - Viewer   → only servers in groups they're granted (resolved at connect time)
  // - Public   → only servers in any group (for dashboard pages)
  res._authed   = !!(req.session && req.session.userId);
  res._isAdmin  = res._authed && req.session.role === "admin";
  res._allowed  = null;          // null = unrestricted
  if (res._authed && !res._isAdmin) {
    try {
      const ids = await getUserAllowedGroupIds(req.session.userId, req.session.role);
      res._allowed = new Set(ids || []);
    } catch(e) { res._allowed = new Set(); }
  }
  const initial = filterServersForSseClient(res, Object.values(serverStatus));
  res.write(`data: ${JSON.stringify(initial)}\n\n`);
  sseClients.push(res);
  req.on("close", () => { sseClients = sseClients.filter(c=>c!==res); });
});

// Returns the subset of server records this SSE client is allowed to see.
// With many-to-many, a server is visible if ANY of its groups is accessible to the client.
function filterServersForSseClient(res, all) {
  if (res._isAdmin) return all;                                              // admin → everything
  if (res._authed) {
    return all.filter(s => Array.isArray(s.group_ids) && s.group_ids.some(gid => res._allowed.has(gid)));
  }
  return all.filter(s => Array.isArray(s.group_ids) && s.group_ids.length > 0); // public → any grouped server
}

// Logs reveal internal system state — admin only
app.get("/api/log-events", requireAdmin, (req, res) => {
  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","no-cache");
  res.setHeader("Connection","keep-alive");
  res.flushHeaders();
  [...eventLog].slice(-50).forEach(e => res.write(`data: ${JSON.stringify(e)}\n\n`));
  logClients.push(res);
  req.on("close", () => { logClients = logClients.filter(c=>c!==res); });
});

app.post("/api/refresh", async (req, res) => {
  await loadConfig();   // pick up newly added/edited servers without waiting for the next interval
  await pollAll(true);  // force-poll every server, ignoring per-server intervals
  res.json({ ok:true });
});

// Temporary debug endpoint — dumps raw serverStatus so we can see if cert info
// is being stored correctly. Remove after debugging.
app.get("/api/debug/raw-status", (req, res) => {
  res.json(serverStatus);
});

// -- Admin API (protected) -----------------------------------------------------
// Many-to-many server↔group: viewers manage servers they share any group with; admins manage all.
// A viewer may only assign servers to groups in their allowed list. Admins can assign anything.
function validateViewerGroupIds(allowedIds, groupIds) {
  if (!Array.isArray(groupIds) || groupIds.length === 0) {
    return { ok: false, msg: "Must assign at least one group (viewers cannot create ungrouped servers)" };
  }
  if (!Array.isArray(allowedIds)) {
    return { ok: false, msg: "No allowed groups for this user" };
  }
  const bad = groupIds.filter(g => !allowedIds.includes(parseInt(g)));
  if (bad.length) {
    return { ok: false, msg: "You don't have access to group(s): " + bad.join(",") };
  }
  return { ok: true };
}

app.get("/api/admin/servers", requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM status_servers ORDER BY sort_order, created_at");
    // Load all group memberships once and bucket by server id
    const [mapRows] = await db.query("SELECT server_id, group_id FROM status_server_group_map");
    const groupsByServer = {};
    mapRows.forEach(m => { (groupsByServer[m.server_id] ||= []).push(m.group_id); });
    const allowed = await getUserAllowedGroupIds(req.session.userId, req.session.role);
    const filtered = (allowed === null)
      ? rows
      : rows.filter(r => {
          const ids = groupsByServer[r.id] || [];
          return ids.some(gid => allowed.includes(gid));
        });
    res.json(filtered.map(r => {
      const defChecks = typeof r.checks === "string" ? JSON.parse(r.checks) : r.checks;
      // Merge live cert info from the in-memory serverStatus so the admin list
      // can show "SSL 180d" style badges next to each HTTP check.
      const liveChecks = serverStatus[r.id]?.checks || [];
      const mergedChecks = (defChecks || []).map(dc => {
        if (dc.type !== "http") return dc;
        const match = liveChecks.find(lc => lc.type === "http" && lc.url === dc.url);
        if (match && match.cert) return { ...dc, cert: match.cert };
        return dc;
      });
      return {
        ...r,
        group_ids: groupsByServer[r.id] || [],
        tags:   typeof r.tags   === "string" ? JSON.parse(r.tags)   : r.tags,
        checks: mergedChecks,
        overall: serverStatus[r.id]?.overall || "pending"
      };
    }));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/admin/servers", requireAuth, async (req, res) => {
  const { name, host, description, tags, checks, group_ids, poll_interval_sec } = req.body;
  if (!name || !host) return res.status(400).json({ error:"name and host are required" });
  const wantGroups = Array.isArray(group_ids) ? group_ids.map(g => parseInt(g)).filter(Number.isFinite) : [];
  const interval = Math.max(10, Math.min(3600, parseInt(poll_interval_sec) || 30));
  // Viewers must put new servers into at least one of their allowed groups
  if (req.session.role !== "admin") {
    const allowed = await getUserAllowedGroupIds(req.session.userId, req.session.role);
    const v = validateViewerGroupIds(allowed, wantGroups);
    if (!v.ok) return res.status(v.msg.startsWith("Must assign") ? 400 : 403).json({ error: v.msg });
  }
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"") + "-" + Date.now();
  try {
    await db.query(
      "INSERT INTO status_servers (id, name, host, description, tags, checks, poll_interval_sec) VALUES (?,?,?,?,?,?,?)",
      [id, name, host, description||"", JSON.stringify(tags||[]), JSON.stringify(checks||[{type:"ping"}]), interval]
    );
    await setServerGroupIds(id, wantGroups);
    await loadConfig();
    addLog({ level:"info", server:"admin", message:`Added: ${name} (${host}) by ${req.session.username}` });
    res.json({ ok:true, id });
  } catch(err) {
    res.status(500).json({ error:err.message });
  }
});

app.put("/api/admin/servers/:id", requireAuth, async (req, res) => {
  const { name, host, description, tags, checks, group_ids, poll_interval_sec } = req.body;
  if (!name || !host) return res.status(400).json({ error:"name and host are required" });
  const wantGroups = Array.isArray(group_ids) ? group_ids.map(g => parseInt(g)).filter(Number.isFinite) : [];
  const interval = Math.max(10, Math.min(3600, parseInt(poll_interval_sec) || 30));
  try {
    // Viewers: can only edit servers they currently share a group with, and they can only
    // add/remove groups THEY own. Groups on the server they don't own are preserved.
    // Admins are unrestricted.
    let finalGroups = wantGroups;
    if (req.session.role !== "admin") {
      const [existRows] = await db.query("SELECT id FROM status_servers WHERE id=?", [req.params.id]);
      if (!existRows.length) return res.status(404).json({ error:"Server not found" });
      const existingGroups = await getServerGroupIds(req.params.id);
      const allowed = await getUserAllowedGroupIds(req.session.userId, req.session.role);
      if (!Array.isArray(allowed) || !existingGroups.some(gid => allowed.includes(gid))) {
        return res.status(403).json({ error:"You don't have access to this server" });
      }
      // Every group the viewer REQUESTED to add must be in their allowed list
      const invalidRequested = wantGroups.filter(g => !allowed.includes(g));
      if (invalidRequested.length) {
        return res.status(403).json({ error:"You don't have access to group(s): " + invalidRequested.join(",") });
      }
      // Preserve groups the viewer doesn't own (protected from accidental removal)
      const preserved = existingGroups.filter(g => !allowed.includes(g));
      // Merge: viewer-controlled set + preserved set (de-duplicated)
      const merged = new Set([...wantGroups, ...preserved]);
      finalGroups = Array.from(merged);
      // The viewer must leave the server in AT LEAST ONE of their own groups
      // (otherwise they've effectively removed themselves from it — silent ownership loss)
      if (!finalGroups.some(g => allowed.includes(g))) {
        return res.status(400).json({ error:"Server must remain in at least one of your allowed groups" });
      }
    }
    const [result] = await db.query(
      "UPDATE status_servers SET name=?, host=?, description=?, tags=?, checks=?, poll_interval_sec=?, updated_at=NOW() WHERE id=?",
      [name, host, description||"", JSON.stringify(tags||[]), JSON.stringify(checks||[]), interval, req.params.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error:"Server not found" });
    // Admins with undefined group_ids leave groups alone; otherwise replace the full set.
    if (req.session.role !== "admin" || Array.isArray(group_ids)) {
      await setServerGroupIds(req.params.id, finalGroups);
    }
    await loadConfig();
    addLog({ level:"info", server:"admin", message:`Updated: ${name} (${host}) by ${req.session.username}` });
    res.json({ ok:true });
  } catch(err) {
    res.status(500).json({ error:err.message });
  }
});

app.delete("/api/admin/servers/:id", requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query("SELECT name FROM status_servers WHERE id=?", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error:"Server not found" });
    await db.query("DELETE FROM status_server_group_map WHERE server_id=?", [req.params.id]);
    await db.query("DELETE FROM status_servers WHERE id=?", [req.params.id]);
    delete serverStatus[req.params.id];
    await loadConfig();
    addLog({ level:"warn", server:"admin", message:`Removed: ${rows[0].name}` });
    // Each client gets their own filtered subset (same per-client filter as pollAll)
    const all = Object.values(serverStatus);
    sseClients.filter(r=>!r.writableEnded).forEach(r => {
      r.write(`data: ${JSON.stringify(filterServersForSseClient(r, all))}\n\n`);
    });
    res.json({ ok:true });
  } catch(err) {
    res.status(500).json({ error:err.message });
  }
});


// -- User Management (admin only) ----------------------------------------------
// Helper: get the set of group IDs a user is allowed to view.
// Returns null for admins (= unrestricted), an empty array if no grants, otherwise an array of ids.
async function getUserAllowedGroupIds(userId, role) {
  if (role === "admin") return null;
  const [rows] = await db.query("SELECT group_id FROM status_user_groups WHERE user_id=?", [userId]);
  return rows.map(r => r.group_id);
}

app.get("/api/admin/users", requireAdmin, async (req, res) => {
  const [users] = await db.query("SELECT id, username, role, created_at FROM status_users ORDER BY created_at");
  // Pull all user→group mappings in one query and bucket them
  const [maps] = await db.query("SELECT user_id, group_id FROM status_user_groups");
  const byUser = {};
  maps.forEach(m => { (byUser[m.user_id] ||= []).push(m.group_id); });
  res.json(users.map(u => ({ ...u, allowed_group_ids: byUser[u.id] || [] })));
});

// Replace a user's group grants with the given list. Used by both POST and PUT.
async function setUserGroupGrants(userId, groupIds) {
  await db.query("DELETE FROM status_user_groups WHERE user_id=?", [userId]);
  if (Array.isArray(groupIds) && groupIds.length) {
    const values = groupIds.map(gid => [userId, parseInt(gid)]).filter(([, g]) => Number.isFinite(g));
    if (values.length) {
      await db.query("INSERT INTO status_user_groups (user_id, group_id) VALUES ?", [values]);
    }
  }
}

app.post("/api/admin/users", requireAdmin, async (req, res) => {
  const { username, password, role, allowed_group_ids } = req.body;
  if (!username || !password) return res.status(400).json({ error:"Username and password required" });
  if (!["admin","viewer"].includes(role)) return res.status(400).json({ error:"Role must be admin or viewer" });
  if (password.length < 8) return res.status(400).json({ error:"Password must be at least 8 characters" });
  try {
    const hash = await bcrypt.hash(password, 10);
    const [result] = await db.query("INSERT INTO status_users (username, password_hash, role) VALUES (?,?,?)", [username, hash, role]);
    // Only viewers get explicit group grants — admins see everything anyway
    if (role === "viewer" && Array.isArray(allowed_group_ids)) {
      await setUserGroupGrants(result.insertId, allowed_group_ids);
    }
    addLog({ level:"info", server:"admin", message:`Created user: ${username} (${role})` });
    res.json({ ok:true });
  } catch(err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ error:"Username already exists" });
    res.status(500).json({ error:err.message });
  }
});

app.put("/api/admin/users/:id", requireAdmin, async (req, res) => {
  const { username, role, password, allowed_group_ids } = req.body;
  if (!username) return res.status(400).json({ error:"Username required" });
  if (!["admin","viewer"].includes(role)) return res.status(400).json({ error:"Invalid role" });
  // Prevent removing admin role from yourself
  if (parseInt(req.params.id) === req.session.userId && role !== "admin") {
    return res.status(400).json({ error:"Cannot remove admin role from your own account" });
  }
  try {
    if (password) {
      if (password.length < 8) return res.status(400).json({ error:"Password must be at least 8 characters" });
      const hash = await bcrypt.hash(password, 10);
      await db.query("UPDATE status_users SET username=?, role=?, password_hash=? WHERE id=?", [username, role, hash, req.params.id]);
    } else {
      await db.query("UPDATE status_users SET username=?, role=? WHERE id=?", [username, role, req.params.id]);
    }
    // Only viewers can have explicit group restrictions; admins always see all
    if (role === "viewer" && Array.isArray(allowed_group_ids)) {
      await setUserGroupGrants(parseInt(req.params.id), allowed_group_ids);
    } else if (role === "admin") {
      // Promoting a user to admin clears any prior viewer restrictions
      await db.query("DELETE FROM status_user_groups WHERE user_id=?", [req.params.id]);
    }
    addLog({ level:"info", server:"admin", message:`Updated user: ${username} (${role})` });
    res.json({ ok:true });
  } catch(err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ error:"Username already exists" });
    res.status(500).json({ error:err.message });
  }
});

app.delete("/api/admin/users/:id", requireAdmin, async (req, res) => {
  if (parseInt(req.params.id) === req.session.userId) {
    return res.status(400).json({ error:"Cannot delete your own account" });
  }
  try {
    const [rows] = await db.query("SELECT username FROM status_users WHERE id=?", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error:"User not found" });
    // Ensure at least one admin remains
    const [admins] = await db.query("SELECT COUNT(*) as cnt FROM status_users WHERE role='admin'");
    const [targetRole] = await db.query("SELECT role FROM status_users WHERE id=?", [req.params.id]);
    if (targetRole[0].role === "admin" && admins[0].cnt <= 1) {
      return res.status(400).json({ error:"Cannot delete the last admin account" });
    }
    await db.query("DELETE FROM status_user_groups WHERE user_id=?", [req.params.id]);
    await db.query("DELETE FROM status_users WHERE id=?", [req.params.id]);
    addLog({ level:"warn", server:"admin", message:`Deleted user: ${rows[0].username}` });
    res.json({ ok:true });
  } catch(err) {
    res.status(500).json({ error:err.message });
  }
});

// -- Webhook Management (admin only) -------------------------------------------
// Helper: viewer can manage a webhook iff its group_id is in their allowed list.
async function userCanManageWebhook(req, hookGroupId) {
  if (req.session.role === "admin") return true;
  if (!hookGroupId) return false;     // global webhooks are admin-only
  const allowed = await getUserAllowedGroupIds(req.session.userId, req.session.role);
  return Array.isArray(allowed) && allowed.includes(parseInt(hookGroupId));
}

app.get("/api/admin/webhooks", requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM status_webhooks ORDER BY created_at");
    const allowed = await getUserAllowedGroupIds(req.session.userId, req.session.role);
    const filtered = (allowed === null) ? rows : rows.filter(r => r.group_id && allowed.includes(r.group_id));
    res.json(filtered);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/webhooks", requireAuth, async (req, res) => {
  const { name, url, enabled, fire_on_down, fire_on_recovery, format, group_id } = req.body;
  if (!name || !url) return res.status(400).json({ error:"Name and URL required" });
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error:"URL must start with http:// or https://" });
  const fmt = ["auto","generic","discord","slack"].includes(format) ? format : "auto";
  // Viewers must scope the webhook to one of their allowed groups; admin can omit (= global)
  let groupIdToStore = null;
  if (req.session.role !== "admin") {
    if (!group_id) return res.status(400).json({ error: "Must assign a group (viewers cannot create global webhooks)" });
    const allowed = await getUserAllowedGroupIds(req.session.userId, req.session.role);
    if (!Array.isArray(allowed) || !allowed.includes(parseInt(group_id))) {
      return res.status(403).json({ error: "You don't have access to that group" });
    }
    groupIdToStore = parseInt(group_id);
  } else if (group_id) {
    groupIdToStore = parseInt(group_id);
  }
  try {
    const [r] = await db.query(
      "INSERT INTO status_webhooks (name, url, enabled, fire_on_down, fire_on_recovery, format, group_id) VALUES (?,?,?,?,?,?,?)",
      [name, url, enabled ? 1 : 0, fire_on_down ? 1 : 0, fire_on_recovery ? 1 : 0, fmt, groupIdToStore]
    );
    addLog({ level:"info", server:"admin", message:`Added webhook: ${name} by ${req.session.username}` });
    res.json({ ok:true, id: r.insertId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/admin/webhooks/:id", requireAuth, async (req, res) => {
  const { name, url, enabled, fire_on_down, fire_on_recovery, format, group_id } = req.body;
  if (!name || !url) return res.status(400).json({ error:"Name and URL required" });
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error:"URL must start with http:// or https://" });
  const fmt = ["auto","generic","discord","slack"].includes(format) ? format : "auto";
  try {
    const [existing] = await db.query("SELECT group_id FROM status_webhooks WHERE id=?", [req.params.id]);
    if (!existing.length) return res.status(404).json({ error:"Webhook not found" });
    if (!(await userCanManageWebhook(req, existing[0].group_id))) {
      return res.status(403).json({ error:"You don't have access to this webhook" });
    }
    // Determine target group_id (viewers can only move within their groups; admins unrestricted)
    let newGroupId = existing[0].group_id;
    if (req.session.role === "admin") {
      newGroupId = group_id ? parseInt(group_id) : null;
    } else if (group_id !== undefined) {
      if (!group_id) return res.status(400).json({ error:"Cannot remove group ownership as a viewer" });
      const allowed = await getUserAllowedGroupIds(req.session.userId, req.session.role);
      if (!Array.isArray(allowed) || !allowed.includes(parseInt(group_id))) {
        return res.status(403).json({ error:"Webhook must remain in one of your allowed groups" });
      }
      newGroupId = parseInt(group_id);
    }
    const [r] = await db.query(
      "UPDATE status_webhooks SET name=?, url=?, enabled=?, fire_on_down=?, fire_on_recovery=?, format=?, group_id=? WHERE id=?",
      [name, url, enabled ? 1 : 0, fire_on_down ? 1 : 0, fire_on_recovery ? 1 : 0, fmt, newGroupId, req.params.id]
    );
    if (r.affectedRows === 0) return res.status(404).json({ error:"Webhook not found" });
    addLog({ level:"info", server:"admin", message:`Updated webhook: ${name} by ${req.session.username}` });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/admin/webhooks/:id", requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query("SELECT name, group_id FROM status_webhooks WHERE id=?", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error:"Webhook not found" });
    if (!(await userCanManageWebhook(req, rows[0].group_id))) {
      return res.status(403).json({ error:"You don't have access to this webhook" });
    }
    await db.query("DELETE FROM status_webhooks WHERE id=?", [req.params.id]);
    addLog({ level:"warn", server:"admin", message:`Removed webhook: ${rows[0].name} by ${req.session.username}` });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/webhooks/:id/test", requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM status_webhooks WHERE id=?", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error:"Webhook not found" });
    if (!(await userCanManageWebhook(req, rows[0].group_id))) {
      return res.status(403).json({ error:"You don't have access to this webhook" });
    }
    const h = rows[0];
    const fmt = h.format === "auto" ? detectFormat(h.url) : h.format;
    const body = buildWebhookPayload(fmt, {
      server:   "Test Server",
      host:     "127.0.0.1",
      status:   "down",
      previous: "up",
      cause:    "This is a test event from Status Monitor",
      time:     new Date().toISOString(),
      isRecovery: false
    });
    try {
      const result = await postWebhook(h.url, body);
      addLog({ level:"info", server:"webhook", message:`Test sent for "${h.name}" (HTTP ${result.status})` });
      res.json({ ok:true, status: result.status, format: fmt });
    } catch(e) {
      addLog({ level:"warn", server:"webhook", message:`Test failed for "${h.name}": ${e.message}` });
      res.status(502).json({ error: e.message });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// -- Groups (Dashboards) admin -------------------------------------------------
function slugify(s) {
  return String(s||"").toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

// Viewers need to see their allowed groups so the server form's group picker can populate.
// Server counts and server_ids come from the many-to-many map table.
app.get("/api/admin/groups", requireAuth, async (req, res) => {
  try {
    const [allGroups] = await db.query("SELECT * FROM status_groups ORDER BY created_at");
    const [counts]    = await db.query("SELECT group_id, COUNT(*) AS cnt FROM status_server_group_map GROUP BY group_id");
    const cmap = Object.fromEntries(counts.map(c => [c.group_id, c.cnt]));
    const [assigns] = await db.query("SELECT server_id, group_id FROM status_server_group_map");
    const idsByGroup = {};
    assigns.forEach(a => { (idsByGroup[a.group_id] ||= []).push(a.server_id); });
    // Filter to viewer's allowed groups (admin = unrestricted)
    const allowed = await getUserAllowedGroupIds(req.session.userId, req.session.role);
    const visible = (allowed === null) ? allGroups : allGroups.filter(g => allowed.includes(g.id));
    res.json(visible.map(g => ({ ...g, server_count: cmap[g.id] || 0, server_ids: idsByGroup[g.id] || [] })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Validate a logo data URL: must start with data:image/, must be under 256KB
function validateLogoImage(s) {
  if (!s) return null;
  if (typeof s !== "string") return null;
  if (!/^data:image\/(png|jpeg|jpg|svg\+xml|webp|gif);base64,/i.test(s)) {
    throw new Error("logo_image must be a data:image/* base64 URL");
  }
  if (s.length > 256 * 1024) {
    throw new Error("logo_image too large (max 256 KB; please resize the image)");
  }
  return s;
}

// Validate a hex color string. Accepts "#RRGGBB" or "#RGB". Empty/null returns null.
function cleanHexColor(s) {
  if (!s) return null;
  if (typeof s !== "string") return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed)) {
    throw new Error("Color must be a hex value like #ff0000");
  }
  return trimmed;
}

// Validate a custom domain string. Lower-cased, trimmed, basic hostname shape. Empty → null.
function cleanCustomDomain(s) {
  if (!s) return null;
  const v = String(s).trim().toLowerCase();
  if (!v) return null;
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(v)) {
    throw new Error("Must be a hostname like status.example.com");
  }
  return v;
}

app.post("/api/admin/groups", requireAdmin, async (req, res) => {
  const { name, slug, description, logo_text, logo_image, logo_size, accent_color, bg_color, default_theme, custom_domain, server_ids } = req.body;
  if (!name) return res.status(400).json({ error: "Name is required" });
  const finalSlug = slugify(slug || name);
  if (!finalSlug) return res.status(400).json({ error: "Slug is required" });
  let cleanLogo, cleanBg, cleanDomain;
  try { cleanLogo = validateLogoImage(logo_image); }
  catch(e) { return res.status(400).json({ error: e.message }); }
  try { cleanBg = cleanHexColor(bg_color); }
  catch(e) { return res.status(400).json({ error: "Background color: " + e.message }); }
  try { cleanDomain = cleanCustomDomain(custom_domain); }
  catch(e) { return res.status(400).json({ error: "Custom domain: " + e.message }); }
  const cleanTheme = (default_theme === "light") ? "light" : "dark";
  // Logo size: clamp to a safe display range; fall back to the 42px default.
  const cleanLogoSize = Math.max(20, Math.min(120, parseInt(logo_size) || 42));
  try {
    const [result] = await db.query(
      "INSERT INTO status_groups (slug, name, description, logo_text, logo_image, logo_size, accent_color, bg_color, default_theme, custom_domain) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [finalSlug, name, description || "", logo_text || "", cleanLogo, cleanLogoSize, accent_color || "#2a7fff", cleanBg, cleanTheme, cleanDomain]
    );
    const newId = result.insertId;
    if (Array.isArray(server_ids) && server_ids.length) {
      // Add each server to this group (many-to-many — does NOT remove them from other groups)
      const rows = server_ids.map(sid => [sid, newId]);
      await db.query("INSERT IGNORE INTO status_server_group_map (server_id, group_id) VALUES ?", [rows]);
      await loadConfig();
    }
    addLog({ level:"info", server:"admin", message:`Group created: ${name} (/${finalSlug})` });
    res.json({ ok:true, id: newId, slug: finalSlug });
  } catch(err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "Slug already in use" });
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/admin/groups/:id", requireAdmin, async (req, res) => {
  const { name, slug, description, logo_text, logo_image, logo_size, accent_color, bg_color, default_theme, custom_domain, server_ids } = req.body;
  if (!name) return res.status(400).json({ error: "Name is required" });
  const finalSlug = slugify(slug || name);
  if (!finalSlug) return res.status(400).json({ error: "Slug is required" });
  const gid = parseInt(req.params.id);
  // Empty string from form means "clear the logo"; null/undefined means "leave alone"
  const isClearing = logo_image === "";
  let cleanLogo = null;
  if (!isClearing) {
    try { cleanLogo = validateLogoImage(logo_image); }
    catch(e) { return res.status(400).json({ error: e.message }); }
  }
  let cleanBg, cleanDomain;
  try { cleanBg = cleanHexColor(bg_color); }
  catch(e) { return res.status(400).json({ error: "Background color: " + e.message }); }
  try { cleanDomain = cleanCustomDomain(custom_domain); }
  catch(e) { return res.status(400).json({ error: "Custom domain: " + e.message }); }
  const cleanTheme = (default_theme === "light") ? "light" : "dark";
  const cleanLogoSize = Math.max(20, Math.min(120, parseInt(logo_size) || 42));
  try {
    const [result] = await db.query(
      "UPDATE status_groups SET slug=?, name=?, description=?, logo_text=?, logo_image=?, logo_size=?, accent_color=?, bg_color=?, default_theme=?, custom_domain=? WHERE id=?",
      [finalSlug, name, description || "", logo_text || "", cleanLogo, cleanLogoSize, accent_color || "#2a7fff", cleanBg, cleanTheme, cleanDomain, gid]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: "Group not found" });
    if (Array.isArray(server_ids)) {
      // Replace THIS group's server set — remove any server from this group that's not in the new list,
      // add any new ones. Does NOT affect those servers' membership in OTHER groups.
      await db.query("DELETE FROM status_server_group_map WHERE group_id=?", [gid]);
      if (server_ids.length) {
        const rows = server_ids.map(sid => [sid, gid]);
        await db.query("INSERT INTO status_server_group_map (server_id, group_id) VALUES ?", [rows]);
      }
      await loadConfig();
    }
    addLog({ level:"info", server:"admin", message:`Group updated: ${name} (/${finalSlug})` });
    res.json({ ok:true, slug: finalSlug });
  } catch(err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "Slug already in use" });
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/admin/groups/:id", requireAdmin, async (req, res) => {
  const gid = parseInt(req.params.id);
  try {
    const [rows] = await db.query("SELECT name FROM status_groups WHERE id=?", [gid]);
    if (!rows.length) return res.status(404).json({ error: "Group not found" });
    // Remove all server mappings to this group (many-to-many aware)
    await db.query("DELETE FROM status_server_group_map WHERE group_id=?", [gid]);
    await db.query("DELETE FROM status_groups WHERE id=?", [gid]);
    await loadConfig();
    addLog({ level:"warn", server:"admin", message:`Group deleted: ${rows[0].name}` });
    res.json({ ok:true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// -- Omada Controllers admin ---------------------------------------------------
// Helper: viewers can write a controller iff its group_id is in their allowed list.
// Returns true if the user is allowed to manage the given controller row.
async function userCanManageOmadaCtrl(req, ctrlGroupId) {
  if (req.session.role === "admin") return true;
  if (!ctrlGroupId) return false;     // global controllers are admin-only
  const allowed = await getUserAllowedGroupIds(req.session.userId, req.session.role);
  return Array.isArray(allowed) && allowed.includes(parseInt(ctrlGroupId));
}

// List controllers — admin sees all; viewer sees only those in their allowed groups
app.get("/api/admin/omada-controllers", requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT id, name, base_url, client_id, omadac_id, verify_tls, mode, group_id, last_error, created_at FROM status_omada_controllers ORDER BY created_at"
    );
    const allowed = await getUserAllowedGroupIds(req.session.userId, req.session.role);
    const filtered = (allowed === null) ? rows : rows.filter(r => r.group_id && allowed.includes(r.group_id));
    res.json(filtered);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Create controller — auto-discovers omadacId, tests auth, stores everything
app.post("/api/admin/omada-controllers", requireAuth, async (req, res) => {
  const { name, base_url, client_id, client_secret, verify_tls, group_id } = req.body;
  if (!name || !base_url || !client_id || !client_secret) {
    return res.status(400).json({ error: "name, base_url, client_id and client_secret are required" });
  }
  // Viewers must scope the controller to one of their allowed groups; admin may omit (= global)
  let groupIdToStore = null;
  if (req.session.role !== "admin") {
    if (!group_id) return res.status(400).json({ error: "Must assign a group (viewers cannot create global controllers)" });
    const allowed = await getUserAllowedGroupIds(req.session.userId, req.session.role);
    if (!Array.isArray(allowed) || !allowed.includes(parseInt(group_id))) {
      return res.status(403).json({ error: "You don't have access to that group" });
    }
    groupIdToStore = parseInt(group_id);
  } else if (group_id) {
    groupIdToStore = parseInt(group_id);
  }
  const url = String(base_url).replace(/\/$/, "");
  const vtls = verify_tls !== false;
  try {
    const info = await omadaGetInfo(url, vtls);
    const omadacId = info.omadacId || info.omadacid;
    if (!omadacId) throw new Error("/api/info returned no omadacId");
    const [result] = await db.query(
      "INSERT INTO status_omada_controllers (name, base_url, client_id, client_secret, omadac_id, verify_tls, group_id) VALUES (?,?,?,?,?,?,?)",
      [name, url, client_id, client_secret, omadacId, vtls ? 1 : 0, groupIdToStore]
    );
    const newId = result.insertId;
    const ctrlForAuth = { id: newId, base_url: url, client_id, client_secret, omadac_id: omadacId, verify_tls: vtls };
    try {
      await omadaGetToken(ctrlForAuth);
      const mode = await detectOmadaMode(ctrlForAuth);
      await db.query("UPDATE status_omada_controllers SET mode=? WHERE id=?", [mode, newId]);
      addLog({ level:"info", server:"omada", message:`Controller added: ${name} (${omadacId}, mode=${mode}) by ${req.session.username}` });
      res.json({ ok:true, id:newId, omadac_id:omadacId, mode, controllerVer: info.controllerVer });
    } catch(authErr) {
      await db.query("UPDATE status_omada_controllers SET last_error=? WHERE id=?", [authErr.message, newId]);
      addLog({ level:"warn", server:"omada", message:`Controller saved but auth failed: ${name} - ${authErr.message}` });
      res.json({ ok:true, id:newId, omadac_id:omadacId, warning:`Saved, but auth failed: ${authErr.message}` });
    }
  } catch(e) {
    addLog({ level:"warn", server:"omada", message:`Could not contact controller "${name}": ${e.message}` });
    res.status(400).json({ error: `Cannot reach controller: ${e.message}` });
  }
});

app.put("/api/admin/omada-controllers/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const { name, base_url, client_id, client_secret, verify_tls, group_id } = req.body;
  if (!name || !base_url || !client_id) {
    return res.status(400).json({ error: "name, base_url and client_id are required" });
  }
  const url = String(base_url).replace(/\/$/, "");
  const vtls = verify_tls !== false;
  try {
    const [rows] = await db.query("SELECT * FROM status_omada_controllers WHERE id=?", [id]);
    if (!rows.length) return res.status(404).json({ error: "Controller not found" });
    const existing = rows[0];
    // Permission: viewers can only edit controllers in their groups
    if (!(await userCanManageOmadaCtrl(req, existing.group_id))) {
      return res.status(403).json({ error: "You don't have access to this controller" });
    }
    // Determine the new group_id. Viewers can only move it within their allowed groups
    // (and it must remain group-scoped — viewers can't make it global). Admins are unrestricted.
    let newGroupId = existing.group_id;
    if (req.session.role === "admin") {
      newGroupId = group_id ? parseInt(group_id) : null;
    } else if (group_id !== undefined) {
      if (!group_id) return res.status(400).json({ error: "Cannot remove group ownership as a viewer" });
      const allowed = await getUserAllowedGroupIds(req.session.userId, req.session.role);
      if (!Array.isArray(allowed) || !allowed.includes(parseInt(group_id))) {
        return res.status(403).json({ error: "Controller must remain in one of your allowed groups" });
      }
      newGroupId = parseInt(group_id);
    }
    // If client_secret is blank, keep the existing one
    const finalSecret = (client_secret && client_secret.length) ? client_secret : existing.client_secret;
    // Re-discover omadacId in case the URL changed
    let omadacId = existing.omadac_id;
    try {
      const info = await omadaGetInfo(url, vtls);
      omadacId = info.omadacId || info.omadacid || omadacId;
    } catch(e) { /* keep old, surface error below */ }
    await db.query(
      "UPDATE status_omada_controllers SET name=?, base_url=?, client_id=?, client_secret=?, omadac_id=?, verify_tls=?, group_id=?, last_error=NULL WHERE id=?",
      [name, url, client_id, finalSecret, omadacId, vtls ? 1 : 0, newGroupId, id]
    );
    delete omadaTokens[id];
    const ctrlForAuth = { id, base_url:url, client_id, client_secret:finalSecret, omadac_id:omadacId, verify_tls:vtls };
    try {
      await omadaGetToken(ctrlForAuth);
      const mode = await detectOmadaMode(ctrlForAuth);
      await db.query("UPDATE status_omada_controllers SET mode=? WHERE id=?", [mode, id]);
      addLog({ level:"info", server:"omada", message:`Controller updated: ${name} (mode=${mode}) by ${req.session.username}` });
      res.json({ ok:true, mode });
    } catch(authErr) {
      await db.query("UPDATE status_omada_controllers SET last_error=? WHERE id=?", [authErr.message, id]);
      res.json({ ok:true, warning:`Saved, but auth failed: ${authErr.message}` });
    }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/admin/omada-controllers/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const [rows] = await db.query("SELECT name, group_id FROM status_omada_controllers WHERE id=?", [id]);
    if (!rows.length) return res.status(404).json({ error: "Controller not found" });
    if (!(await userCanManageOmadaCtrl(req, rows[0].group_id))) {
      return res.status(403).json({ error: "You don't have access to this controller" });
    }
    await db.query("DELETE FROM status_omada_controllers WHERE id=?", [id]);
    delete omadaTokens[id];
    addLog({ level:"warn", server:"omada", message:`Controller removed: ${rows[0].name} by ${req.session.username}` });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// List sites for a controller — viewers can browse only their own controllers' sites
app.get("/api/admin/omada-controllers/:id/sites", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const [rows] = await db.query("SELECT * FROM status_omada_controllers WHERE id=?", [id]);
    if (!rows.length) return res.status(404).json({ error: "Controller not found" });
    if (!(await userCanManageOmadaCtrl(req, rows[0].group_id))) {
      return res.status(403).json({ error: "You don't have access to this controller" });
    }
    const sites = await omadaListSites(rows[0]);
    res.json(sites);
  } catch(e) {
    res.status(502).json({ error: e.message });
  }
});

// Viewer change-password (viewers can change their own password)
app.post("/api/change-password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error:"Both fields required" });
  if (newPassword.length < 8) return res.status(400).json({ error:"Password must be at least 8 characters" });
  try {
    const [rows] = await db.query("SELECT * FROM status_users WHERE id = ?", [req.session.userId]);
    if (!rows.length) return res.status(404).json({ error:"User not found" });
    const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error:"Current password incorrect" });
    const hash = await bcrypt.hash(newPassword, 10);
    await db.query("UPDATE status_users SET password_hash = ? WHERE id = ?", [hash, req.session.userId]);
    addLog({ level:"info", server:"auth", message:`Password changed: ${rows[0].username}` });
    res.json({ ok:true });
  } catch(err) {
    res.status(500).json({ error:err.message });
  }
});


// -- Public Status API ---------------------------------------------------------

// Gate per-server endpoints with three tiers (many-to-many aware):
//   admin     → always allowed
//   viewer    → allowed iff the server's group set intersects their granted groups
//   public    → allowed iff the server belongs to ANY group (visible on a public dashboard)
async function allowGroupedOrAuth(req, res, next) {
  const id = req.params.id;
  const s  = serverStatus[id];
  // Admins: pass through
  if (req.session && req.session.role === "admin") return next();
  const serverGroupIds = (s && Array.isArray(s.group_ids)) ? s.group_ids : [];
  // Viewers: must share at least one group with the server
  if (req.session && req.session.userId) {
    if (!serverGroupIds.length) return res.status(403).json({ error: "Forbidden" });
    try {
      const allowed = await getUserAllowedGroupIds(req.session.userId, req.session.role);
      if (Array.isArray(allowed) && serverGroupIds.some(gid => allowed.includes(gid))) return next();
      return res.status(403).json({ error: "Forbidden" });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }
  // Public: server must be in any group
  if (serverGroupIds.length) return next();
  res.status(401).json({ error: "Unauthorized" });
}

// Uptime % for a server over a period
app.get("/api/public/uptime/:id", allowGroupedOrAuth, async (req, res) => {
  try {
    const id = req.params.id;
    // Count all checks for this server (not just ping). Servers monitored only by
    // omada_gateway, http, tcp, etc. used to show no uptime data because the old
    // query was hard-filtered to check_type='ping'.
    const calc = async (hours) => {
      const [rows] = await db.query(
        `SELECT COUNT(*) as total, SUM(ok) as up_count
         FROM status_history
         WHERE server_id=?
         AND checked_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)`,
        [id, hours]
      );
      const total = rows[0].total || 0;
      const up    = rows[0].up_count || 0;
      return total === 0 ? null : Math.round((up / total) * 1000) / 10;
    };
    const [h24, d7, d30] = await Promise.all([calc(24), calc(168), calc(720)]);
    res.json({ h24, d7, d30 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Response time history � last 24h bucketed by hour
app.get("/api/public/response/:id", allowGroupedOrAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT
         DATE_FORMAT(checked_at, '%Y-%m-%d %H:00:00') as hour,
         ROUND(AVG(response_ms)) as avg_ms,
         MIN(response_ms) as min_ms,
         MAX(response_ms) as max_ms,
         COUNT(*) as checks,
         SUM(ok) as up_count
       FROM status_history
       WHERE server_id=? AND response_ms IS NOT NULL
       AND checked_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
       GROUP BY hour
       ORDER BY hour ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Heartbeat � last 90 check results (any check type)
app.get("/api/public/heartbeat/:id", allowGroupedOrAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT ok, checked_at, detail, response_ms
       FROM status_history
       WHERE server_id=?
       ORDER BY checked_at DESC LIMIT 90`,
      [req.params.id]
    );
    res.json(rows.reverse());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Incidents for a server
app.get("/api/public/incidents/:id", allowGroupedOrAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT * FROM status_incidents
       WHERE server_id=?
       ORDER BY started_at DESC LIMIT 20`,
      [req.params.id]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Master server list — auth required.
// Admins see ALL servers (including any without group membership). Viewers see only servers
// whose group set intersects with their allowed groups.
app.get("/api/public/servers", requireAuth, async (req, res) => {
  try {
    const allowed = await getUserAllowedGroupIds(req.session.userId, req.session.role);
    let list = Object.values(serverStatus);
    if (allowed !== null) {
      const allowedSet = new Set(allowed);
      list = list.filter(s => Array.isArray(s.group_ids) && s.group_ids.some(gid => allowedSet.has(gid)));
    }
    const servers = list.map(s => ({
      id: s.id, name: s.name, host: s.host,
      description: s.description, tags: s.tags, group_ids: s.group_ids || [],
      checks: s.checks || [],                  // includes cert info for HTTPS checks
      overall: s.overall, lastChecked: s.lastChecked,
      uptimeHistory: s.uptimeHistory
    }));
    res.json(servers);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Single dashboard (group) — public, returns group meta + filtered servers
// (servers whose group_ids array CONTAINS this group)
app.get("/api/public/group/:slug", async (req, res) => {
  try {
    const [groups] = await db.query("SELECT * FROM status_groups WHERE slug=?", [req.params.slug]);
    if (!groups.length) return res.status(404).json({ error: "Group not found" });
    const g = groups[0];
    const servers = Object.values(serverStatus)
      .filter(s => Array.isArray(s.group_ids) && s.group_ids.includes(g.id))
      .map(s => ({
        id: s.id, name: s.name, host: s.host,
        description: s.description, tags: s.tags, group_ids: s.group_ids,
        checks: s.checks || [],              // includes cert info for HTTPS checks
        overall: s.overall, lastChecked: s.lastChecked,
        uptimeHistory: s.uptimeHistory
      }));
    res.json({ group: g, servers });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// -- Badge API -----------------------------------------------------------------
// Shields.io-style SVG badges for embedding in READMEs, docs, dashboards, etc.
// Auth: same gate as other public endpoints — server must be in a group (public),
//       or the request must be from a logged-in viewer/admin.

function makeBadge(label, value, color) {
  // Approximate character width for DejaVu Sans 11px
  const charW = 6.5;
  const pad   = 10;
  const lw = Math.ceil(label.length * charW) + pad * 2;
  const vw = Math.ceil(value.length * charW) + pad * 2;
  const tw = lw + vw;
  const lx = (lw / 2 + 1).toFixed(1);
  const vx = (lw + vw / 2).toFixed(1);
  // Escape XML special chars
  const esc = s => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${tw}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}">
<title>${esc(label)}: ${esc(value)}</title>
<linearGradient id="s" x2="0" y2="100%">
  <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
  <stop offset="1" stop-opacity=".1"/>
</linearGradient>
<clipPath id="r"><rect width="${tw}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)">
  <rect width="${lw}" height="20" fill="#555"/>
  <rect x="${lw}" width="${vw}" height="20" fill="${color}"/>
  <rect width="${tw}" height="20" fill="url(#s)"/>
</g>
<g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
  <text x="${lx}" y="15" fill="#010101" fill-opacity=".3">${esc(label)}</text>
  <text x="${lx}" y="14">${esc(label)}</text>
  <text x="${vx}" y="15" fill="#010101" fill-opacity=".3">${esc(value)}</text>
  <text x="${vx}" y="14">${esc(value)}</text>
</g>
</svg>`;
}

function sendBadge(res, label, value, color) {
  res.set("Content-Type",  "image/svg+xml");
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.send(makeBadge(label, value, color));
}

// Status badge: up / down / degraded
app.get("/api/badge/:id/status", allowGroupedOrAuth, (req, res) => {
  const s = serverStatus[req.params.id];
  if (!s) return res.status(404).json({ error: "Server not found" });
  const overall = s.overall || "unknown";
  const colorMap = { up:"#44cc11", down:"#e05d44", degraded:"#dfb317", pending:"#9f9f9f", unknown:"#9f9f9f" };
  const label = overall === "up"
    ? (req.query.upLabel   || "status")
    : (req.query.downLabel || "status");
  const value = overall === "up"
    ? (req.query.upValue   || "up")
    : (req.query.downValue || overall);
  sendBadge(res, label, value, colorMap[overall] || "#9f9f9f");
});

// Uptime badge: percentage over a time window (?duration=24h|7d|30d)
app.get("/api/badge/:id/uptime", allowGroupedOrAuth, async (req, res) => {
  try {
    const raw   = req.query.duration || "24h";
    const hours = raw === "7d" ? 168 : raw === "30d" ? 720 : 24;
    const label = req.query.label || `uptime ${raw}`;
    const [rows] = await db.query(
      `SELECT COUNT(*) AS total, SUM(ok) AS up_count
       FROM status_history
       WHERE server_id=? AND checked_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)`,
      [req.params.id, hours]
    );
    const total = parseInt(rows[0].total) || 0;
    const up    = parseInt(rows[0].up_count) || 0;
    if (total === 0) return sendBadge(res, label, "N/A", "#9f9f9f");
    const pct   = Math.round((up / total) * 1000) / 10;
    const color = pct >= 99 ? "#44cc11" : pct >= 95 ? "#dfb317" : "#e05d44";
    sendBadge(res, label, `${pct}%`, color);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Response time badge: latest ping or HTTP check result
app.get("/api/badge/:id/ping", allowGroupedOrAuth, (req, res) => {
  const s = serverStatus[req.params.id];
  if (!s) return res.status(404).json({ error: "Server not found" });
  const label  = req.query.label || "response";
  const check  = s.checks.find(c => c.response_ms != null);
  const ms     = check?.response_ms;
  const value  = ms != null ? `${ms}ms` : "N/A";
  const color  = ms == null ? "#9f9f9f" : ms < 150 ? "#44cc11" : ms < 400 ? "#dfb317" : "#e05d44";
  sendBadge(res, label, value, color);
});

// SSL cert expiry badge: days until certificate expires
app.get("/api/badge/:id/cert-exp", allowGroupedOrAuth, (req, res) => {
  const s = serverStatus[req.params.id];
  if (!s) return res.status(404).json({ error: "Server not found" });
  const label    = req.query.label || "cert exp";
  const httpChk  = s.checks.find(c => (c.type === "http" || c.type === "https") && c.cert?.valid_to);
  if (!httpChk) return sendBadge(res, label, "N/A", "#9f9f9f");
  const days  = Math.ceil((new Date(httpChk.cert.valid_to) - Date.now()) / 86400000);
  const value = days < 0 ? "expired" : `${days}d`;
  const warnDays = parseInt(req.query.warnDays) || 14;
  const downDays = parseInt(req.query.downDays) || 7;
  const color = days < 0 ? "#e05d44" : days <= downDays ? "#e05d44" : days <= warnDays ? "#dfb317" : "#44cc11";
  sendBadge(res, label, value, color);
});

// All EJS page responses: tell the browser not to cache the HTML (CSS is inlined
// in the template, so stale HTML = stale CSS). Prevents "my fix isn't showing up"
// after a rebuild when the browser re-uses a cached page.
app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api/")) {
    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
  }
  next();
});

// -- Page routes (EJS templates) ----------------------------------------------
const DEFAULT_BRANDING = {
  groupSlug:    null,
  groupName:    "Status.Monitor",
  groupSubtitle: "",
  accentColor:  "#2a7fff",
  bgColor:      null,
  logoText:     "",
  logoImage:    null,
  logoSize:     42,
  defaultTheme: "dark",
  pageTitle:    "System Status"
};

// Custom-domain middleware: if the request's Host header matches any group's custom_domain,
// render that dashboard as if /dashboard/<slug> was requested. Runs BEFORE the auth gates
// so visitors to e.g. status.myanthemcoffee.com see the Anthem dashboard without a login redirect.
app.use(async (req, res, next) => {
  // Only intercept top-level page GETs — never API routes, never /dashboard/<slug> (already works),
  // never /admin / /login / /static.
  if (req.method !== "GET") return next();
  if (req.path.startsWith("/api/") || req.path.startsWith("/admin") || req.path.startsWith("/login") || req.path.startsWith("/dashboard/")) return next();
  const host = (req.hostname || "").toLowerCase();
  if (!host) return next();
  try {
    const [rows] = await db.query("SELECT * FROM status_groups WHERE LOWER(custom_domain)=?", [host]);
    if (rows.length) {
      const g = rows[0];
      return res.render("index", {
        adminHref:    null,
        groupSlug:    g.slug,
        groupName:    g.name,
        groupSubtitle: g.description || "",
        accentColor:  g.accent_color || "#2a7fff",
        bgColor:      g.bg_color || null,
        logoText:     g.logo_text || "",
        logoImage:    g.logo_image || null,
        logoSize:     g.logo_size || 42,
        defaultTheme: g.default_theme || "dark",
        pageTitle:    `${g.name} — Status`
      });
    }
  } catch(e) { /* silent — fall through to normal routing */ }
  next();
});

// Authed master views: show all servers (across all groups + ungrouped)
app.get("/",       requireAuthPage, (req, res) => res.render("index", { adminHref: "/admin", ...DEFAULT_BRANDING }));
app.get("/status", requireAuthPage, (req, res) => res.render("index", { adminHref: "/", ...DEFAULT_BRANDING }));
app.get("/admin",  requireAuthPage, (req, res) => res.render("admin"));
app.get("/login",  (req, res) => res.render("login"));

// Per-group dashboard
app.get("/dashboard/:slug", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM status_groups WHERE slug=?", [req.params.slug]);
    if (!rows.length) return res.status(404).render("404", { slug: req.params.slug });
    const g = rows[0];
    res.render("index", {
      adminHref:    null,                  // Public dashboards hide the Admin link
      groupSlug:    g.slug,
      groupName:    g.name,
      groupSubtitle: g.description || "",
      accentColor:  g.accent_color || "#2a7fff",
      bgColor:      g.bg_color || null,
      logoText:     g.logo_text || "",
      logoImage:    g.logo_image || null,
      logoSize:     g.logo_size || 42,
      defaultTheme: g.default_theme || "dark",
      pageTitle:    `${g.name} — Status`
    });
  } catch(e) {
    res.status(500).send("Server error");
  }
});

// Legacy .html URLs → permanent redirect to clean paths
app.get("/status.html", (req, res) => res.redirect(301, "/status"));
app.get("/admin.html",  (req, res) => res.redirect(301, "/admin"));
app.get("/login.html",  (req, res) => res.redirect(301, "/login"));

// Catch-all: redirect any non-API non-page route to /login (authed users will then bounce to /)
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Not found" });
  }
  res.redirect("/login");
});

// -- Boot ----------------------------------------------------------------------
(async () => {
  await initDB();
  await loadConfig();
  await pollAll(true);  // force everything on startup
  // Tick every 5 seconds — pollAll() picks only servers that are DUE based on their
  // own poll_interval_sec. This lets fast servers (20s) and slow ones (5 min) coexist.
  const TICK = 5000;
  setInterval(async () => { await loadConfig(); await pollAll(); }, TICK);
  // Listen on dual-stack (::) so both IPv4 and IPv6 clients connect with no fallback delay.
  // Without this, "localhost" resolves to ::1, the connection attempt fails, and the client
  // waits ~200ms before retrying on 127.0.0.1 — adding 200ms latency to every request.
  app.listen(PORT, "::", () => {
    addLog({ level:"info", server:"system", message:`Server started on :${PORT} (dual-stack), interval ${CHECK_INTERVAL/1000}s` });
  });
})();