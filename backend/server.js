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
const nodemailer   = require("nodemailer");
const helmet       = require("helmet");
const rateLimit    = require("express-rate-limit");
const pino         = require("pino");
const pinoHttp     = require("pino-http");
const { Agent: UndiciAgent } = require("undici"); // for Omada TLS dispatcher

const app  = express();

// -- Structured logger (pino) ------------------------------------------------
// JSON logs in production (easy to ship to Loki / Datadog / CloudWatch),
// colorised pretty-printed lines in development. LOG_LEVEL env overrides.
const logger = pino(
  process.env.NODE_ENV === "production"
    ? { level: process.env.LOG_LEVEL || "info" }
    : {
        level: process.env.LOG_LEVEL || "info",
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" }
        }
      }
);

// Trust the first reverse-proxy hop (Caddy/nginx). Required for correct
// req.ip (rate limiting) and req.secure (HTTPS-aware session cookies).
app.set("trust proxy", 1);

// HTTP request logging. Noisy health/SSE endpoints are skipped so logs
// stay useful; everything else gets method, path, status, latency.
app.use(pinoHttp({
  logger,
  autoLogging: {
    ignore: (req) =>
      req.url === "/healthz" ||
      req.url === "/api/events" ||
      req.url === "/api/log-events" ||
      req.url.startsWith("/api/badge/")
  },
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  serializers: {
    req: (req) => ({ method: req.method, url: req.url, ip: req.remoteAddress }),
    res: (res) => ({ status: res.statusCode })
  }
}));

// Security headers. CSP is disabled intentionally: the EJS templates rely
// on inline scripts/styles that would break without a major refactor. All
// other helmet defaults (X-Content-Type-Options, Referrer-Policy,
// Strict-Transport-Security, X-Frame-Options, etc.) are kept on.
app.use(helmet({
  contentSecurityPolicy:    false,
  crossOriginEmbedderPolicy: false,  // would block Cloudflare Turnstile script
  crossOriginResourcePolicy: { policy: "cross-origin" }  // allow badge SVGs to be embedded
}));

// Rate limiters — brute-force defense on auth endpoints.
// Keyed on req.ip (correct thanks to trust proxy above).
const loginLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             10,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: "Too many login attempts — try again in 15 minutes." }
});
const setupLimiter = rateLimit({
  windowMs:        60 * 60 * 1000,
  max:             3,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: "Too many setup attempts." }
});

const { version: APP_VERSION } = require("./package.json");
const APP_OWNER     = process.env.APP_OWNER         || "Richard Applegate";
const APP_CONTACT   = process.env.APP_CONTACT_EMAIL || "admin@richardapplegate.io";
const APP_HOME_URL  = process.env.APP_HOME_URL      || "/";
const EXTERNAL_URL  = (process.env.EXTERNAL_URL || "").replace(/\/+$/, "");  // optional fallback when no custom_domain
const GITHUB_REPO   = "X4Applegate/status-server";
const PORT          = process.env.PORT              || 3000;
const CONFIG_PATH   = process.env.CONFIG_PATH    || "/config/servers.json";
const CHECK_INTERVAL= parseInt(process.env.CHECK_INTERVAL || "30000");
const LOG_MAX       = 500;

// -- DB config (from env) ------------------------------------------------------
const DB_HOST = process.env.DB_HOST     || "mariadb";
const DB_PORT = parseInt(process.env.DB_PORT || "3306");
const DB_USER = process.env.DB_USER     || "root";
const DB_PASS = process.env.DB_PASSWORD || "";
const DB_NAME = process.env.DB_NAME     || "status_monitor";

const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-secret-in-production";
const IS_PROD        = process.env.NODE_ENV === "production";

// -- Config validation (fail fast on broken prod deploys) --------------------
(function validateEnv() {
  const warnings = [], errors = [];
  if (SESSION_SECRET === "change-this-secret-in-production") {
    (IS_PROD ? errors : warnings).push(
      "SESSION_SECRET is still the default — set a unique random value (48+ chars) in docker-compose.yml"
    );
  } else if (SESSION_SECRET.length < 32) {
    warnings.push("SESSION_SECRET is shorter than 32 characters; 48+ random chars recommended");
  }
  if (IS_PROD && !process.env.DB_PASSWORD) {
    errors.push("DB_PASSWORD must be set in production");
  }
  warnings.forEach(w => console.warn(`[warn] config: ${w}`));
  if (errors.length) {
    errors.forEach(e => console.error(`[error] config: ${e}`));
    console.error("Refusing to start with invalid configuration.");
    process.exit(1);
  }
})();

// -- SMTP config (for email webhook notifications) ----------------------------
// Loaded from DB settings table (web UI); env vars are fallback for first-run setups.
let smtpConfig = {
  host:   process.env.SMTP_HOST   || "",
  port:   parseInt(process.env.SMTP_PORT || "587"),
  user:   process.env.SMTP_USER   || "",
  pass:   process.env.SMTP_PASS   || "",
  from:   process.env.SMTP_FROM   || process.env.SMTP_USER || "",
  secure: (process.env.SMTP_SECURE || "false") === "true"
};
let smtpTransport = null;

function rebuildSmtpTransport() {
  if (smtpConfig.host) {
    smtpTransport = nodemailer.createTransport({
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: smtpConfig.secure,
      auth: smtpConfig.user ? { user: smtpConfig.user, pass: smtpConfig.pass } : undefined
    });
  } else {
    smtpTransport = null;
  }
}
rebuildSmtpTransport();

async function loadSmtpFromDb() {
  if (!db) return;
  try {
    const [rows] = await db.query("SELECT key_name, value FROM status_settings WHERE key_name LIKE 'smtp_%'");
    if (!rows.length) return;
    const m = {};
    rows.forEach(r => { m[r.key_name] = r.value; });
    if (m.smtp_host) {
      smtpConfig = {
        host:   m.smtp_host || "",
        port:   parseInt(m.smtp_port || "587"),
        user:   m.smtp_user || "",
        pass:   m.smtp_pass || "",
        from:   m.smtp_from || m.smtp_user || "",
        secure: m.smtp_secure === "true"
      };
      rebuildSmtpTransport();
    }
  } catch(e) { /* settings table may not exist yet */ }
}

// -- Cloudflare Turnstile (login bot/spam protection) -------------------------
// Loaded from DB settings table. Admin enters their own Cloudflare Site Key +
// Secret Key in the settings tab; we verify login submissions against Cloudflare.
let turnstileConfig = { enabled: false, site_key: "", secret_key: "" };

async function loadTurnstileFromDb() {
  if (!db) return;
  try {
    const [rows] = await db.query("SELECT key_name, value FROM status_settings WHERE key_name LIKE 'turnstile_%'");
    const m = {};
    rows.forEach(r => { m[r.key_name] = r.value; });
    turnstileConfig = {
      enabled:    m.turnstile_enabled === "true",
      site_key:   m.turnstile_site_key   || "",
      secret_key: m.turnstile_secret_key || ""
    };
  } catch(e) { /* settings table may not exist yet */ }
}

async function verifyTurnstile(token, remoteIp) {
  if (!turnstileConfig.enabled) return { ok: true };
  if (!turnstileConfig.secret_key) return { ok: false, error: "Turnstile is enabled but not configured" };
  if (!token) return { ok: false, error: "Captcha verification required" };
  try {
    const params = new URLSearchParams();
    params.append("secret", turnstileConfig.secret_key);
    params.append("response", token);
    if (remoteIp) params.append("remoteip", remoteIp);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:   params.toString(),
      signal: AbortSignal.timeout(8000)
    });
    const data = await r.json();
    if (data.success) return { ok: true };
    return { ok: false, error: "Captcha verification failed" };
  } catch(e) {
    return { ok: false, error: "Captcha verification unreachable" };
  }
}

// -- Global safety net ---------------------------------------------------------
// Catch any unhandled promise rejection or exception so one bug can't kill the poll
// loop. We log and keep running — much better UX than a crash-restart loop.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandledRejection");
});
process.on("uncaughtException", (err) => {
  logger.error({ err }, "uncaughtException");
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
// Inject configurable vars into every EJS template automatically
app.use((req, res, next) => {
  res.locals.APP_OWNER    = APP_OWNER;
  res.locals.APP_CONTACT  = APP_CONTACT;
  res.locals.APP_HOME_URL = APP_HOME_URL;
  next();
});

// -- Middleware ----------------------------------------------------------------
// 1 MB limit lets group logo data URLs (max 256KB after our validation) fit comfortably
app.use(express.json({ limit: "1mb" }));

// Ensure all /api routes return JSON and are never cached
app.use("/api", (req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  next();
});
// Persist sessions in MariaDB so restarts/redeploys don't log everyone out.
// Creates a `sessions` table automatically on first connect (createDatabaseTable: true).
// Uses its own small connection (connectionLimit: 2) separate from the main pool
// so session reads/writes never queue behind heavy monitoring queries.
const MySQLStore  = require("express-mysql-session")(session);
const sessionStore = new MySQLStore({
  host:                    DB_HOST,
  port:                    DB_PORT,
  user:                    DB_USER,
  password:                DB_PASS,
  database:                DB_NAME,
  clearExpired:            true,
  checkExpirationInterval: 15 * 60 * 1000,  // prune expired rows every 15 min
  expiration:              24 * 60 * 60 * 1000, // match cookie maxAge
  createDatabaseTable:     true,
  connectionLimit:         2,
  endConnectionOnClose:    true
});
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    secure:   "auto",       // Secure flag set automatically when req is HTTPS (via X-Forwarded-Proto)
    httpOnly: true,
    sameSite: "lax",
    maxAge:   24 * 60 * 60 * 1000 // 24h
  }
}));

// -- Health check (Docker HEALTHCHECK / reverse proxy probe) -----------------
// Lightweight liveness+DB ping. Returns 200 when the DB pool responds to
// SELECT 1, 503 otherwise. No auth. No session. Not logged to the system log.
app.get("/healthz", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (!db) return res.status(503).json({ ok: false, db: "not-initialized" });
    await db.query("SELECT 1");
    res.json({
      ok:      true,
      version: APP_VERSION,
      uptime:  Math.floor(process.uptime()),
      db:      "ok"
    });
  } catch (e) {
    res.status(503).json({ ok: false, db: "down" });
  }
});

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

// -- Event log ---------------------------------------------------------------
// Dual-purpose: drives the admin UI live log stream (in-memory ring buffer +
// SSE fanout) and also emits structured JSON via pino for container logs /
// log aggregators.
function addLog(entry) {
  const record = { id: Date.now() + Math.random(), ts: new Date().toISOString(), ...entry };
  eventLog.push(record);
  if (eventLog.length > LOG_MAX) eventLog.shift();
  const payload = JSON.stringify(record);
  logClients = logClients.filter(r => !r.writableEnded);
  logClients.forEach(r => r.write(`data: ${payload}\n\n`));
  const level = entry.level === "error" ? "error" : entry.level === "warn" ? "warn" : "info";
  logger[level]({ server: entry.server || undefined }, entry.message);
}

// -- Audit log -----------------------------------------------------------------
// Fire-and-forget structured record of significant user actions. Never throws
// — if the DB write fails we log a warning but don't interrupt the request.
async function addAuditLog({ userId, username, action, resourceType, resourceId, resourceName, detail, ip }) {
  try {
    if (!db) return;
    await db.query(
      `INSERT INTO status_audit_log
         (user_id, username, action, resource_type, resource_id, resource_name, detail, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId || null, username || null, action,
       resourceType || null, resourceId != null ? String(resourceId) : null,
       resourceName || null, detail || null, ip || null]
    );
  } catch(e) {
    logger.warn({ err: e.message }, "audit log write failed");
  }
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
        connectionLimit: 10,
        timezone: "local"
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
  try {
    await db.query("ALTER TABLE status_servers ADD COLUMN category VARCHAR(100) DEFAULT NULL");
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

  // Many-to-many: Omada controller ↔ groups (replaces the single group_id column)
  await db.query(`
    CREATE TABLE IF NOT EXISTS status_omada_controller_groups (
      controller_id INT NOT NULL,
      group_id      INT NOT NULL,
      PRIMARY KEY (controller_id, group_id),
      INDEX idx_ctrl  (controller_id),
      INDEX idx_group (group_id)
    )
  `);
  // One-time migration: seed the map table from the legacy group_id column
  try {
    const [legacy] = await db.query("SELECT id, group_id FROM status_omada_controllers WHERE group_id IS NOT NULL");
    if (legacy.length) {
      const vals = legacy.map(r => [r.id, r.group_id]);
      await db.query("INSERT IGNORE INTO status_omada_controller_groups (controller_id, group_id) VALUES ?", [vals]);
    }
  } catch(e) { /* already migrated */ }

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
  try {
    await db.query("ALTER TABLE status_groups ADD COLUMN privacy_text MEDIUMTEXT DEFAULT NULL");
  } catch(e) { /* column already exists */ }
  try {
    await db.query("ALTER TABLE status_groups ADD COLUMN terms_text MEDIUMTEXT DEFAULT NULL");
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
      format           ENUM('auto','generic','discord','slack','email') NOT NULL DEFAULT 'auto',
      group_id         INT          DEFAULT NULL,
      created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Upgrade-safe: add group_id column so per-group ownership works on existing installs
  try {
    await db.query("ALTER TABLE status_webhooks ADD COLUMN group_id INT DEFAULT NULL");
  } catch(e) { /* column already exists */ }
  // Upgrade-safe: add 'email' to format enum for existing installs
  try {
    await db.query("ALTER TABLE status_webhooks MODIFY COLUMN format ENUM('auto','generic','discord','slack','email') NOT NULL DEFAULT 'auto'");
  } catch(e) { /* already updated */ }

  // Settings table — key-value store for app-wide config (SMTP, etc.)
  await db.query(`
    CREATE TABLE IF NOT EXISTS status_settings (
      key_name   VARCHAR(64) PRIMARY KEY,
      value      TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS status_audit_log (
      id           BIGINT AUTO_INCREMENT PRIMARY KEY,
      ts           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      user_id      INT,
      username     VARCHAR(128),
      action       VARCHAR(64)  NOT NULL,
      resource_type VARCHAR(64),
      resource_id  VARCHAR(128),
      resource_name VARCHAR(255),
      detail       TEXT,
      ip           VARCHAR(64),
      INDEX idx_audit_ts     (ts),
      INDEX idx_audit_user   (user_id),
      INDEX idx_audit_action (action)
    )
  `);

  // Load SMTP config from DB (overrides env vars if set)
  await loadSmtpFromDb();
  await loadTurnstileFromDb();

  // No longer auto-creates admin — first user signs up via /login

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
      category:          r.category || "",
      poll_interval_sec: r.poll_interval_sec || 30,
      group_ids:         groupsByServer[r.id] || [],
      tags:              typeof r.tags   === "string" ? JSON.parse(r.tags)   : (r.tags   || []),
      checks:            typeof r.checks === "string" ? JSON.parse(r.checks) : (r.checks || [])
    }));

    // Seed uptimeHistory from database for servers that don't have it yet (e.g. after restart)
    const needsHistory = serverConfig.filter(s => !serverStatus[s.id] || !serverStatus[s.id].uptimeHistory || !serverStatus[s.id].uptimeHistory.length);
    if (needsHistory.length) {
      try {
        const [histRows] = await db.query(
          `SELECT server_id, MIN(ok) AS ok, checked_at
           FROM status_history
           WHERE checked_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
           GROUP BY server_id, checked_at
           ORDER BY checked_at DESC`
        );
        const histByServer = {};
        for (const r of histRows) {
          (histByServer[r.server_id] ||= []).push(!!r.ok);
        }
        for (const sid of Object.keys(histByServer)) {
          histByServer[sid] = histByServer[sid].reverse().slice(-20);
        }
        for (const s of needsHistory) {
          if (histByServer[s.id]) {
            if (!serverStatus[s.id]) {
              serverStatus[s.id] = { id:s.id, name:s.name, host:s.host, description:s.description, category:s.category, group_ids:s.group_ids, tags:s.tags, checks:[], overall:"pending", lastChecked:null, uptimeHistory: histByServer[s.id] };
            } else {
              serverStatus[s.id].uptimeHistory = histByServer[s.id];
            }
          }
        }
      } catch(e) { /* proceed without history */ }
    }

    serverConfig.forEach(s => {
      if (!serverStatus[s.id]) {
        serverStatus[s.id] = { id:s.id, name:s.name, host:s.host, description:s.description, category:s.category, group_ids:s.group_ids, tags:s.tags, checks:[], overall:"pending", lastChecked:null, uptimeHistory:[] };
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
      // Keep one decimal for sub-ms pings so we don't store 0
      const raw = match ? parseFloat(match[2]) : null;
      const ms  = raw !== null ? (raw < 1 ? Math.round(raw * 10) / 10 : Math.round(raw)) : null;
      resolve({ type:"ping", ok:true, response_ms: ms, detail: ms !== null ? `${ms}ms` : "ok" });
    });
  });
}

function formatUptime(seconds) {
  if (!seconds || seconds < 0) return null;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Parse Omada uptime — can be a number (seconds or ms) or a string like "11day(s) 21h 57m 13s"
function parseOmadaUptime(val) {
  if (val == null) return null;
  if (typeof val === "number") return val > 1e9 ? Math.round(val / 1000) : val;
  if (typeof val === "string") {
    const d = parseInt(val.match(/(\d+)\s*day/i)?.[1] || 0);
    const h = parseInt(val.match(/(\d+)h/i)?.[1] || 0);
    const m = parseInt(val.match(/(\d+)m/i)?.[1] || 0);
    const total = d * 86400 + h * 3600 + m * 60;
    return total > 0 ? total : null;
  }
  return null;
}

function tcpCheck(host, port, timeout=3000) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let done = false;
    const t0 = Date.now();
    const finish = (ok, detail, ms=null) => { if(done)return; done=true; socket.destroy(); resolve({type:"tcp",port,ok,response_ms:ms,detail}); };
    socket.setTimeout(timeout);
    socket.on("connect", () => finish(true,  `port ${port} open`, Date.now()-t0));
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
    const t0 = Date.now();
    const req = lib.get(parsedUrl.toString(), reqOpts, res => {
      const response_ms = Date.now() - t0;
      const ok = res.statusCode === expectedStatus;
      const result = { type:"http", url, ok, response_ms, detail:`HTTP ${res.statusCode}` };
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
        } catch(e) { logger.warn({ url, err: e.message }, "httpCheck cert parse error"); }
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

  const t0 = Date.now();
  return Promise.race([
    resolver(String(hostname).trim())
      .then(values => {
        const response_ms = Date.now() - t0;
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
        return { type:"dns", ok:true, response_ms, detail:`${type} ${hostname} → ${values.slice(0, 3).join(", ")}${values.length>3?"…":""}` };
      })
      .catch(err => ({ type:"dns", ok:false, detail:`${type} ${hostname}: ${err.code || err.message}` })),
    new Promise(resolve => setTimeout(
      () => resolve({ type:"dns", ok:false, detail:`${type} ${hostname}: timeout` }),
      timeout
    ))
  ]);
}

// -- Omada Open API client -----------------------------------------------------
const omadaTokens = {}; // { controllerId: { accessToken, expiresAt } }

// Returns an undici dispatcher that skips TLS verification for self-signed
// Omada controller certs, or undefined (default dispatcher = verify TLS).
function omadaDispatcher(verifyTls) {
  return verifyTls ? undefined : new UndiciAgent({ connect: { rejectUnauthorized: false } });
}

// Hit /api/info on a controller to discover its omadacId. No auth required.
async function omadaGetInfo(baseUrl, verifyTls) {
  const url = `${baseUrl.replace(/\/$/, "")}/api/info`;
  const r = await fetch(url, { dispatcher: omadaDispatcher(verifyTls), signal: AbortSignal.timeout(8000) });
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
    body, dispatcher: omadaDispatcher(controller.verify_tls), signal: AbortSignal.timeout(8000)
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
    headers:    { Authorization: `AccessToken=${token}` },
    dispatcher: omadaDispatcher(controller.verify_tls),
    signal:     AbortSignal.timeout(8000)
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
    headers:    { Authorization: `AccessToken=${token}` },
    dispatcher: omadaDispatcher(controller.verify_tls),
    signal:     AbortSignal.timeout(8000)
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
async function omadaGatewayCheck(controllerId, siteId, customerId, siteName, customerName, host) {
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
    const apiStart = Date.now();
    const devices = await omadaListDevices(ctrl, siteId, customerId, siteName, customerName);
    const apiResponseMs = Date.now() - apiStart;

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
    let omadaOk = gateway.status === 1 || gateway.status === 11;
    const name  = gateway.name || gateway.deviceName || "Gateway";
    const model = gateway.model || gateway.modelName || gateway.product || null;
    const uptimeSec = parseOmadaUptime(gateway.uptimeLong ?? gateway.uptime ?? null);
    const uptimeStr = uptimeSec ? ` · up ${formatUptime(uptimeSec)}` : "";
    const modelStr  = model ? `${model} ` : "";
    const wanIp     = gateway.publicIp || null;
    const wanStr    = wanIp ? ` · WAN ${wanIp}` : "";

    // Use the Omada controller API response time as the meaningful latency metric.
    // (Pinging the gateway's LAN IP doesn't work — those private IPs aren't routable
    // from outside the customer's network.)
    const ok = omadaOk;
    const detail = ok
      ? `${modelStr}connected${uptimeStr}${wanStr}`
      : `${name} offline (status ${gateway.status})`;

    return { type:"omada_gateway", ok, detail, response_ms: apiResponseMs };
  } catch(e) {
    return { type:"omada_gateway", ok:false, detail: e.message };
  }
}

const _lteShapeLogged = new Set();
async function omadaLteCheck(controllerId, siteId, customerId, siteName, customerName, lteProbeIp) {
  try {
    const [rows] = await db.query("SELECT * FROM status_omada_controllers WHERE id=?", [controllerId]);
    if (!rows.length) return { type:"omada_lte", ok:false, detail:"controller not found" };
    const ctrl = rows[0];

    // Step 1: find the gateway device using the same robust logic as omadaGatewayCheck
    const devices = await omadaListDevices(ctrl, siteId, customerId, siteName, customerName);
    const isGw = (d) => {
      const t  = (d.type || d.deviceType || "").toString().toLowerCase();
      const m  = (d.model || d.modelName || d.product || "").toString().toUpperCase();
      const dn = (d.deviceName || "").toString().toLowerCase();
      return t==="gateway" || t.includes("gateway") || t.includes("router")
          || dn.includes("gateway") || /^ER\d/.test(m) || d.type===0;
    };
    const gwDevice = devices.find(isGw);
    if (!gwDevice) return { type:"omada_lte", ok:false, detail:"no gateway found in site" };

    // Step 2: try multiple endpoint + auth-mode combos to find one with cellular/WAN data.
    const mac = gwDevice.mac;
    let gw = gwDevice; // fallback: use device-list object
    const probes = [
      // path                                         authFn
      [`/sites/${siteId}/gateways/${mac}`,            omadaMspApiGet],
      [`/sites/${siteId}/gateways/${mac}`,            omadaApiGet],
      [`/sites/${siteId}/gateways?pageSize=10&page=1`,omadaMspApiGet],
      [`/sites/${siteId}/gateways?pageSize=10&page=1`,omadaApiGet],
      [`/sites/${siteId}/devices/${mac}`,             omadaMspApiGet],
      [`/sites/${siteId}/devices/${mac}`,             omadaApiGet],
      [`/sites/${siteId}/gateways/${mac}/portStats`,  omadaMspApiGet],
      [`/sites/${siteId}/gateways/${mac}/portStats`,  omadaApiGet],
    ];
    const lteKey = `lte:${controllerId}:${siteId}`;
    const logOnce = !_lteShapeLogged.has(lteKey);
    for (const [path, fn] of probes) {
      try {
        const r = await fn(ctrl, path);
        const obj = Array.isArray(r) ? (r.find(g => g.mac === mac) || r[0]) : (r.data ? (Array.isArray(r.data) ? (r.data.find(g=>g.mac===mac)||r.data[0]) : r.data) : r);
        if (logOnce) addLog({ level:"info", server:"omada", message:`LTE probe ${path}: keys=${obj?Object.keys(obj).join(","):"null"}` });
        if (obj && (obj.wanPortStatus || obj.wanPorts || obj.portStatus || obj.cellularInfo || obj.lteInfo || obj.fourGInfo)) {
          gw = obj;
          break;
        }
        if (obj && obj.mac === mac) gw = obj;
      } catch(e) {
        if (logOnce) addLog({ level:"info", server:"omada", message:`LTE probe ${path}: ${e.message}` });
      }
    }

    // Log final gateway object shape once
    if (logOnce) {
      _lteShapeLogged.add(lteKey);
      addLog({ level:"info", server:"omada", message:`LTE final shape (${gw.model||gw.mac}): ${JSON.stringify(gw)}` });
    }

    // Hunt for a cellular/4G WAN port across multiple possible field names
    const wanPorts = gw.wanPortStatus || gw.wanStatus || gw.portStatus || gw.wanPorts || [];
    const isCellular = p => {
      const n = (p.portName || p.name || p.type || "").toString().toLowerCase();
      const m = (p.medium || p.portType || p.linkType || "").toString().toLowerCase();
      return n.includes("cell") || n.includes("lte") || n.includes("4g") || n.includes("3g")
          || m.includes("cell") || m.includes("lte") || m.includes("4g") || m.includes("3g")
          || n.includes("wan2") && (m.includes("modem") || m.includes("usb"));
    };

    const cell = Array.isArray(wanPorts) ? wanPorts.find(isCellular) : null;

    // Also check top-level cellular fields (some firmware puts them directly on the gw object)
    const topLteField = gw.cellularInfo || gw.lteInfo || gw.fourGInfo || null;

    if (!cell && !topLteField) {
      // API doesn't expose cellular data on this controller firmware.
      // If a probe_ip is configured on the check, ping it directly as a proxy for LTE health.
      // Otherwise fall back to: gateway is up → LTE hardware is powered on → report ok.
      if (lteProbeIp) {
        const p = await pingCheck(lteProbeIp);
        return { type:"omada_lte", ok:p.ok, response_ms:p.response_ms,
          detail: p.ok ? `LTE reachable · ${lteProbeIp}${p.response_ms!=null?" · "+p.response_ms+"ms":""}` : `LTE unreachable · ${lteProbeIp}` };
      }
      const gwUp = gwDevice.status === 1 || gwDevice.status === 11;
      return { type:"omada_lte", ok:gwUp,
        detail: gwUp ? "LTE backup ready · gateway up (cellular API unavailable)" : "gateway down" };
    }

    const src = cell || topLteField;
    const connected = src.online ?? src.connected ?? src.internetState === 1 ?? false;
    const netType   = src.networkType || src.connectType || src.signalType || "LTE";
    const signal    = src.signalLevel ?? src.rssi ?? src.rsrp ?? null;
    const signalStr = signal != null ? ` · ${signal}dBm` : "";
    const carrier   = src.isp || src.carrier || src.operatorName || null;
    const carrierStr= carrier ? ` · ${carrier}` : "";
    const wanIp     = src.ip || src.wanIp || null;
    const ipStr     = wanIp ? ` · ${wanIp}` : "";

    // "Standby" means the link is up but not the active WAN — still healthy
    const standby = !connected && (src.mode === "backup" || src.wanMode === "backup" || src.standby === true);
    const ok = connected || standby;
    const stateStr = connected ? "connected" : standby ? "standby" : "disconnected";

    const detail = `${netType} ${stateStr}${signalStr}${carrierStr}${ipStr}`;
    return { type:"omada_lte", ok, detail };
  } catch(e) {
    return { type:"omada_lte", ok:false, detail: e.message };
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
      if (c.type==="omada_gateway") return await omadaGatewayCheck(c.controller_id, c.site_id, c.customer_id, c.site_name, c.customer_name, def.host);
      if (c.type==="omada_lte")     return await omadaLteCheck(c.controller_id, c.site_id, c.customer_id, c.site_name, c.customer_name, c.probe_ip || null);
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
      // Prefer an explicit response_ms field; fall back to parsing the detail string
      // for backwards compatibility with any check that still embeds ms in detail.
      let ms = ch.response_ms != null ? ch.response_ms : null;
      if (ms === null && ch.ok && ch.detail) {
        const match = ch.detail.match(/(\d+)\s*ms/);
        if (match) ms = parseInt(match[1]);
      }
      const label = ch.type === "ping"          ? "ping"
                  : ch.type === "tcp"           ? `tcp:${ch.port}`
                  : ch.type === "udp"           ? `udp:${ch.port}`
                  : ch.type === "http"          ? "http"
                  : ch.type === "dns"           ? `dns:${(ch.record_type||"A").toUpperCase()}`
                  : ch.type === "omada_gateway" ? "omada_gateway"
                  : ch.type === "omada_lte"     ? "omada_lte"
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
function fmtWebhookTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { year:"numeric", month:"short", day:"2-digit", hour:"numeric", minute:"2-digit", second:"2-digit", hour12:true, timeZoneName:"short" });
}

function buildWebhookPayload(format, evt) {
  // evt: { server, host, status, previous, cause, checks, time, isRecovery, isTest, dashboardUrl, webhookName }
  const displayTime = fmtWebhookTime(evt.time);
  const emoji = evt.isTest ? "🧪" : evt.isRecovery ? "✅" : (evt.status === "down" ? "🚨" : "🟠");
  const statusLabel = evt.isTest ? "Test" : evt.isRecovery ? "Recovered" : (evt.status === "down" ? "Down" : "Degraded");
  const statusEmoji = evt.isTest ? "🧪" : evt.isRecovery ? "🟢" : (evt.status === "down" ? "🔴" : "🟠");
  const verb  = evt.isTest ? "— Test Alert" : evt.isRecovery ? "Recovered" : (evt.status === "down" ? "is DOWN" : "is DEGRADED");
  const title = `${emoji} Service ${verb}`;

  if (format === "discord") {
    const fields = [
      { name: "Service:", value: evt.server, inline: true },
      { name: "Status:", value: `${statusEmoji} ${statusLabel}`, inline: true },
      { name: "Target:", value: evt.host, inline: true },
      { name: "Time:", value: displayTime, inline: true }
    ];
    // Alert details from individual checks
    const checkDetails = Array.isArray(evt.checks) && evt.checks.length
      ? evt.checks.filter(c => !c.ok || evt.isRecovery || evt.isTest).map(c => {
          const label = c.type === "ping" ? "PING" : c.type === "tcp" ? `TCP :${c.port}` : c.type === "udp" ? `UDP :${c.port}` : c.type.toUpperCase();
          return `${c.ok ? "✅" : "❌"} ${label}: ${c.detail}`;
        }).join("\n")
      : null;
    if (checkDetails || evt.cause) {
      fields.push({ name: "⚠️ Alert Details:", value: "```\n" + (checkDetails || evt.cause) + "\n```", inline: false });
    }
    if (evt.dashboardUrl) {
      fields.push({ name: "Dashboard:", value: `[${evt.dashboardUrl}](${evt.dashboardUrl})`, inline: false });
    }
    const embed = {
      title,
      color: evt.isTest ? 0x5865f2 : evt.isRecovery ? 0x10e88a : (evt.status === "down" ? 0xff3d5a : 0xff8c2a),
      fields,
      timestamp: evt.time
    };
    if (evt.dashboardUrl) embed.url = evt.dashboardUrl;
    if (evt.webhookName) embed.footer = { text: `Added by ${evt.webhookName}` };
    return { embeds: [embed] };
  }

  // Slack + generic use simpler text format
  const lines = [
    `**Server:** ${evt.server}`,
    `**Host:** ${evt.host}`,
    `**Status:** ${statusEmoji} ${statusLabel}`,
    evt.cause ? `**Cause:** ${evt.cause}` : null,
    `**Time:** ${displayTime}`,
    evt.dashboardUrl ? `**Dashboard:** ${evt.dashboardUrl}` : null
  ].filter(Boolean).join("\n");

  if (format === "slack") {
    const color = evt.isTest ? "#5865f2" : evt.isRecovery ? "#10e88a" : (evt.status === "down" ? "#ff3d5a" : "#ff8c2a");
    // Build check details for the alert details block
    const checkDetails = Array.isArray(evt.checks) && evt.checks.length
      ? evt.checks.filter(c => !c.ok || evt.isRecovery || evt.isTest).map(c => {
          const label = c.type === "ping" ? "PING" : c.type === "tcp" ? `TCP :${c.port}` : c.type === "udp" ? `UDP :${c.port}` : c.type.toUpperCase();
          return `${label}: ${c.detail}`;
        }).join("\n")
      : null;
    const blocks = [
      { type: "header", text: { type: "plain_text", text: `${emoji} Service ${verb}`, emoji: true } },
      { type: "section", fields: [
        { type: "mrkdwn", text: `*Service:*\n${evt.server}` },
        { type: "mrkdwn", text: `*Status:*\n${statusEmoji} ${statusLabel}` }
      ]},
      { type: "section", fields: [
        { type: "mrkdwn", text: `*Target:*\n${evt.host}` },
        { type: "mrkdwn", text: `*Time:*\n${displayTime}` }
      ]}
    ];
    if (checkDetails || evt.cause) {
      blocks.push(
        { type: "section", text: { type: "mrkdwn", text: ":warning: *Alert Details:*" } },
        { type: "section", text: { type: "mrkdwn", text: "```" + (checkDetails || evt.cause) + "```" } }
      );
    }
    if (evt.dashboardUrl) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Dashboard:*\n<${evt.dashboardUrl}>` } });
    }
    if (evt.webhookName) {
      blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `Added by ${evt.webhookName}` }] });
    }
    return {
      text: `${emoji} Service ${verb}: ${evt.server} (${evt.host})`,
      attachments: [{ color, blocks }]
    };
  }
  if (format === "email") {
    const subject = `${emoji} ${evt.server} ${verb}`;
    const checkDetails = Array.isArray(evt.checks) && evt.checks.length
      ? evt.checks.filter(c => !c.ok || evt.isRecovery || evt.isTest).map(c => {
          const label = c.type === "ping" ? "PING" : c.type === "tcp" ? `TCP :${c.port}` : c.type === "udp" ? `UDP :${c.port}` : c.type.toUpperCase();
          return `${c.ok ? "✅" : "❌"} ${label}: ${c.detail}`;
        }).join("\n")
      : null;
    const html = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;background:#0d1117;border:1px solid #30363d;border-radius:12px;overflow:hidden">
        <div style="background:${evt.isTest ? '#5865f2' : evt.isRecovery ? '#10e88a' : evt.status === 'down' ? '#ff3d5a' : '#ff8c2a'};padding:20px 24px">
          <h1 style="margin:0;font-size:20px;font-weight:700;color:#fff">${emoji} Service ${verb}</h1>
        </div>
        <div style="padding:24px">
          <table style="width:100%;border-collapse:collapse;font-size:14px;color:#c9d1d9">
            <tr><td style="padding:8px 0;color:#8b949e;width:100px"><strong>Service:</strong></td><td style="padding:8px 0">${evt.server}</td></tr>
            <tr><td style="padding:8px 0;color:#8b949e"><strong>Status:</strong></td><td style="padding:8px 0">${statusEmoji} ${statusLabel}</td></tr>
            <tr><td style="padding:8px 0;color:#8b949e"><strong>Target:</strong></td><td style="padding:8px 0;font-family:monospace">${evt.host}</td></tr>
            <tr><td style="padding:8px 0;color:#8b949e"><strong>Time:</strong></td><td style="padding:8px 0">${displayTime}</td></tr>
          </table>
          ${checkDetails || evt.cause ? `
          <div style="margin-top:16px">
            <div style="font-size:13px;font-weight:600;color:#8b949e;margin-bottom:8px">⚠️ Alert Details</div>
            <pre style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px;font-size:12px;color:#c9d1d9;white-space:pre-wrap;margin:0">${checkDetails || evt.cause}</pre>
          </div>` : ""}
          ${evt.dashboardUrl ? `
          <div style="margin-top:20px">
            <a href="${evt.dashboardUrl}" style="display:inline-block;padding:10px 20px;background:#238636;color:#fff;text-decoration:none;border-radius:6px;font-size:13px;font-weight:600">View Dashboard</a>
          </div>` : ""}
        </div>
        ${evt.webhookName ? `<div style="padding:12px 24px;border-top:1px solid #30363d;font-size:11px;color:#484f58">Sent by ${evt.webhookName}</div>` : ""}
      </div>`;
    const text = `${emoji} ${evt.server} ${verb}\n\nService: ${evt.server}\nStatus: ${statusLabel}\nTarget: ${evt.host}\nTime: ${displayTime}\n${checkDetails || evt.cause ? "\nAlert Details:\n" + (checkDetails || evt.cause) : ""}${evt.dashboardUrl ? "\n\nDashboard: " + evt.dashboardUrl : ""}`;
    return { _email: true, subject, html, text };
  }
  // generic
  return {
    event: evt.isTest ? "webhook.test" : evt.isRecovery ? "server.recovered" : "server.down",
    server: evt.server,
    host: evt.host,
    status: evt.status,
    previous: evt.previous,
    cause: evt.cause || null,
    time: evt.time,
    dashboard_url: evt.dashboardUrl || null
  };
}

function detectFormat(url) {
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(url)) return "email";
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

async function sendEmailAlert(to, payload) {
  if (!smtpTransport) throw new Error("SMTP not configured — set it up in Manage → Settings");
  await smtpTransport.sendMail({
    from: smtpConfig.from || smtpConfig.user || "monitor@example.com",
    to,
    subject: payload.subject,
    text: payload.text,
    html: payload.html
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
  // Look up group info (slug + custom_domain) for dashboard links
  {
    // Collect group IDs to look up slugs for
    const groupIdSet = new Set();
    for (const h of hooks) { if (h.group_id) groupIdSet.add(h.group_id); }
    if (evt.serverGroupIds) evt.serverGroupIds.forEach(gid => groupIdSet.add(gid));
    let groupInfoMap = {};
    if (groupIdSet.size) {
      try {
        const [slugRows] = await db.query("SELECT id, slug, custom_domain FROM status_groups WHERE id IN (?)", [Array.from(groupIdSet)]);
        for (const r of slugRows) groupInfoMap[r.id] = { slug: r.slug, custom_domain: r.custom_domain };
      } catch(e) { /* proceed without links */ }
    }
    evt._groupInfoMap = groupInfoMap;
  }

  for (const h of hooks) {
    if (evt.isRecovery && !h.fire_on_recovery) continue;
    if (!evt.isRecovery && !h.fire_on_down)    continue;
    // Resolve dashboard link: use custom_domain if set, otherwise EXTERNAL_URL + slug as fallback
    let hookDashboardUrl = null;
    if (evt._groupInfoMap) {
      const gid = h.group_id || (evt.serverGroupIds && evt.serverGroupIds.length ? evt.serverGroupIds[0] : null);
      const info = gid ? evt._groupInfoMap[gid] : null;
      if (info && info.custom_domain) {
        hookDashboardUrl = `https://${info.custom_domain}`;
      } else if (info && EXTERNAL_URL) {
        hookDashboardUrl = `${EXTERNAL_URL}/dashboard/${info.slug}`;
      }
    }
    const fmt  = h.format === "auto" ? detectFormat(h.url) : h.format;
    const body = buildWebhookPayload(fmt, { ...evt, dashboardUrl: hookDashboardUrl, webhookName: h.name });
    // Fire-and-forget with one retry
    (async () => {
      try {
        if (body._email) {
          await sendEmailAlert(h.url, body);
        } else {
          await postWebhook(h.url, body);
        }
        addLog({ level:"info", server:"webhook", message:`Sent "${h.name}" for ${evt.server} (${evt.isRecovery?"recovery":evt.status})` });
      } catch(e1) {
        addLog({ level:"warn", server:"webhook", message:`Webhook "${h.name}" attempt 1 failed: ${e1.message}` });
        await new Promise(r => setTimeout(r, 1500));
        try {
          if (body._email) {
            await sendEmailAlert(h.url, body);
          } else {
            await postWebhook(h.url, body);
          }
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
        const interval = Math.max(5, def.poll_interval_sec || 30) * 1000;
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
          checks:          checks.map(c => ({ type: c.type, port: c.port, ok: c.ok, detail: c.detail, response_ms: c.response_ms })),
          time:            now,
          isRecovery,
          serverGroupIds:  def.group_ids || []
        }).catch(() => {});
      }
    }

    serverStatus[def.id] = { id:def.id, name:def.name, host:def.host, description:def.description||"", category:def.category||"", group_ids:def.group_ids||[], tags:def.tags||[], checks, overall, lastChecked:now, uptimeHistory:history };
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
  if (role === "admin") {
    // Fresh install: no servers yet → send admin straight to management panel
    try {
      const [cnt] = await db.query("SELECT COUNT(*) AS c FROM status_servers");
      if (cnt[0].c === 0) return "/admin?welcome=1";
    } catch(_) {}
    return "/";
  }
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

app.post("/api/login", loginLimiter, async (req, res) => {
  const { username, password, turnstile_token } = req.body;
  if (!username || !password) return res.status(400).json({ error:"Username and password required" });
  try {
    if (turnstileConfig.enabled) {
      const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;
      const cap = await verifyTurnstile(turnstile_token, ip);
      if (!cap.ok) {
        addLog({ level:"warn", server:"auth", message:`Login blocked by Turnstile for ${username}: ${cap.error}` });
        return res.status(400).json({ error: cap.error, turnstile_failed: true });
      }
    }
    const [rows] = await db.query("SELECT * FROM status_users WHERE username = ?", [username]);
    if (!rows.length) {
      addAuditLog({ action:"login.failed", username, detail:"user not found", ip: req.ip });
      return res.status(401).json({ error:"Invalid credentials" });
    }
    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid) {
      addAuditLog({ userId: rows[0].id, username, action:"login.failed", detail:"wrong password", ip: req.ip });
      return res.status(401).json({ error:"Invalid credentials" });
    }
    req.session.userId   = rows[0].id;
    req.session.username = rows[0].username;
    req.session.role     = rows[0].role;
    addLog({ level:"info", server:"auth", message:`Login: ${username} (${rows[0].role})` });
    addAuditLog({ userId: rows[0].id, username, action:"login", detail: rows[0].role, ip: req.ip });
    const redirect = await computeLoginRedirect(rows[0].id, rows[0].role);
    res.json({ ok:true, username: rows[0].username, role: rows[0].role, redirect });
  } catch(err) {
    res.status(500).json({ error:err.message });
  }
});

// Check if setup is needed (no users exist yet)
app.get("/api/setup-status", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT COUNT(*) as cnt FROM status_users");
    res.json({ needsSetup: rows[0].cnt === 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// First-time signup — only works when no users exist
app.post("/api/setup", setupLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });
  if (username.length < 3) return res.status(400).json({ error: "Username must be at least 3 characters" });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  try {
    const [users] = await db.query("SELECT COUNT(*) as cnt FROM status_users");
    if (users[0].cnt > 0) return res.status(403).json({ error: "Setup already completed — use the login form" });
    const hash = await bcrypt.hash(password, 10);
    const [result] = await db.query("INSERT INTO status_users (username, password_hash, role) VALUES (?, ?, 'admin')", [username, hash]);
    req.session.userId   = result.insertId;
    req.session.username = username;
    req.session.role     = "admin";
    addLog({ level:"info", server:"system", message:`First admin account created: ${username}` });
    addAuditLog({ userId: result.insertId, username, action:"user.setup", detail:"initial admin created", ip: req.ip });
    res.json({ ok: true, redirect: "/admin?welcome=1" });
  } catch(e) {
    if (e.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "Username already exists" });
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/logout", (req, res) => {
  const user   = req.session.username || "unknown";
  const userId = req.session.userId;
  const ip     = req.ip;
  req.session.destroy(() => {
    addLog({ level:"info", server:"auth", message:`Logout: ${user}` });
    addAuditLog({ userId, username: user, action:"logout", ip });
    res.json({ ok:true });
  });
});

// -- Version check -------------------------------------------------------------
let _versionCache = { latest: null, checkedAt: 0 };

async function fetchLatestVersion() {
  const ONE_HOUR = 3600000;
  if (Date.now() - _versionCache.checkedAt < ONE_HOUR && _versionCache.latest) {
    return _versionCache.latest;
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { "User-Agent": "applegate-monitor-version-check" },
      signal:  AbortSignal.timeout(8000)
    });
    if (!res.ok) return _versionCache.latest;
    const data = await res.json();
    const tag = (data.tag_name || "").replace(/^v/, "");
    if (tag) { _versionCache.latest = tag; _versionCache.checkedAt = Date.now(); }
  } catch(e) { /* network unavailable — keep cached value */ }
  return _versionCache.latest;
}

app.get("/api/version", requireAdmin, async (req, res) => {
  const latest = await fetchLatestVersion();
  res.json({
    current: APP_VERSION,
    latest:  latest || APP_VERSION,
    update_available: latest ? latest !== APP_VERSION : false,
    release_url: `https://github.com/${GITHUB_REPO}/releases/latest`
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
    addAuditLog({ userId: req.session.userId, username: req.session.username, action:"password.change", resourceType:"user", resourceId: req.session.userId, resourceName: rows[0].username, ip: req.ip });
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

// Audit log — admin-only, paginated, filterable by action prefix
app.get("/api/audit-log", requireAdmin, async (req, res) => {
  try {
    const limit  = Math.min(Math.max(1, parseInt(req.query.limit)  || 100), 500);
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const action = req.query.action || "";   // e.g. "server" filters server.*
    const userId = req.query.user_id ? parseInt(req.query.user_id) : null;
    const where  = [];
    const params = [];
    if (action) { where.push("action LIKE ?"); params.push(action + "%"); }
    if (userId) { where.push("user_id = ?");   params.push(userId); }
    const clause = where.length ? "WHERE " + where.join(" AND ") : "";
    const [[{ total }]] = await db.query(`SELECT COUNT(*) as total FROM status_audit_log ${clause}`, params);
    const [rows] = await db.query(
      `SELECT * FROM status_audit_log ${clause} ORDER BY ts DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    res.json({ entries: rows, total, limit, offset });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
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
  const { name, host, description, category, tags, checks, group_ids, poll_interval_sec } = req.body;
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
      "INSERT INTO status_servers (id, name, host, description, category, tags, checks, poll_interval_sec) VALUES (?,?,?,?,?,?,?,?)",
      [id, name, host, description||"", (category||"").trim() || null, JSON.stringify(tags||[]), JSON.stringify(checks||[{type:"ping"}]), interval]
    );
    await setServerGroupIds(id, wantGroups);
    await loadConfig();
    addLog({ level:"info", server:"admin", message:`Added: ${name} (${host}) by ${req.session.username}` });
    addAuditLog({ userId: req.session.userId, username: req.session.username, action:"server.create", resourceType:"server", resourceId: id, resourceName: name, detail: host, ip: req.ip });
    res.json({ ok:true, id });
  } catch(err) {
    res.status(500).json({ error:err.message });
  }
});

app.put("/api/admin/servers/:id", requireAuth, async (req, res) => {
  const { name, host, description, category, tags, checks, group_ids, poll_interval_sec } = req.body;
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
      "UPDATE status_servers SET name=?, host=?, description=?, category=?, tags=?, checks=?, poll_interval_sec=?, updated_at=NOW() WHERE id=?",
      [name, host, description||"", (category||"").trim() || null, JSON.stringify(tags||[]), JSON.stringify(checks||[]), interval, req.params.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error:"Server not found" });
    // Admins with undefined group_ids leave groups alone; otherwise replace the full set.
    if (req.session.role !== "admin" || Array.isArray(group_ids)) {
      await setServerGroupIds(req.params.id, finalGroups);
    }
    await loadConfig();
    addLog({ level:"info", server:"admin", message:`Updated: ${name} (${host}) by ${req.session.username}` });
    addAuditLog({ userId: req.session.userId, username: req.session.username, action:"server.update", resourceType:"server", resourceId: req.params.id, resourceName: name, detail: host, ip: req.ip });
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
    addAuditLog({ userId: req.session.userId, username: req.session.username, action:"server.delete", resourceType:"server", resourceId: req.params.id, resourceName: rows[0].name, ip: req.ip });
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

// -- Settings (SMTP, etc.) ---------------------------------------------------
app.get("/api/admin/settings/smtp", requireAdmin, async (req, res) => {
  try {
    res.json({
      host:   smtpConfig.host,
      port:   smtpConfig.port,
      user:   smtpConfig.user,
      pass:   smtpConfig.pass ? "********" : "",  // never expose actual password
      from:   smtpConfig.from,
      secure: smtpConfig.secure,
      configured: !!smtpTransport
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/settings/smtp", requireAdmin, async (req, res) => {
  const { host, port, user, pass, from, secure } = req.body;
  try {
    const newPort = parseInt(port) || 587;
    const newSecure = !!secure;
    // Only update password if a real value (not the masked placeholder) was sent
    const finalPass = (pass && pass !== "********") ? pass : smtpConfig.pass;
    const settings = [
      ["smtp_host", host || ""],
      ["smtp_port", String(newPort)],
      ["smtp_user", user || ""],
      ["smtp_pass", finalPass || ""],
      ["smtp_from", from || ""],
      ["smtp_secure", newSecure ? "true" : "false"]
    ];
    for (const [k, v] of settings) {
      await db.query("INSERT INTO status_settings (key_name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)", [k, v]);
    }
    smtpConfig = { host: host || "", port: newPort, user: user || "", pass: finalPass || "", from: from || "", secure: newSecure };
    rebuildSmtpTransport();
    addLog({ level:"info", server:"admin", message:`SMTP settings updated by ${req.session.username}` });
    res.json({ ok:true, configured: !!smtpTransport });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Public — login page reads this to know whether to render the Turnstile widget.
// Only exposes the site key (safe for client-side); never the secret.
app.get("/api/turnstile-config", (req, res) => {
  res.json({
    enabled:  !!(turnstileConfig.enabled && turnstileConfig.site_key),
    site_key: turnstileConfig.enabled ? (turnstileConfig.site_key || "") : ""
  });
});

app.get("/api/admin/settings/turnstile", requireAdmin, async (req, res) => {
  res.json({
    enabled:    turnstileConfig.enabled,
    site_key:   turnstileConfig.site_key,
    secret_key: turnstileConfig.secret_key ? "********" : ""
  });
});

app.post("/api/admin/settings/turnstile", requireAdmin, async (req, res) => {
  const { enabled, site_key, secret_key } = req.body;
  try {
    const newEnabled  = !!enabled;
    const newSiteKey  = (site_key || "").trim();
    const finalSecret = (secret_key && secret_key !== "********") ? secret_key.trim() : turnstileConfig.secret_key;
    if (newEnabled && (!newSiteKey || !finalSecret)) {
      return res.status(400).json({ error: "Site Key and Secret Key are both required to enable Turnstile" });
    }
    const settings = [
      ["turnstile_enabled",    newEnabled ? "true" : "false"],
      ["turnstile_site_key",   newSiteKey],
      ["turnstile_secret_key", finalSecret || ""]
    ];
    for (const [k, v] of settings) {
      await db.query("INSERT INTO status_settings (key_name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)", [k, v]);
    }
    turnstileConfig = { enabled: newEnabled, site_key: newSiteKey, secret_key: finalSecret || "" };
    addLog({ level:"info", server:"admin", message:`Turnstile ${newEnabled ? "enabled" : "disabled"} by ${req.session.username}` });
    res.json({ ok: true, enabled: turnstileConfig.enabled });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/settings/smtp/test", requireAdmin, async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: "Recipient email required" });
  if (!smtpTransport) return res.status(400).json({ error: "SMTP not configured — save your settings first" });
  try {
    await smtpTransport.sendMail({
      from: smtpConfig.from || smtpConfig.user || "monitor@example.com",
      to,
      subject: "🧪 Applegate Monitor — SMTP Test",
      text: "This is a test email from Applegate Monitor. If you received this, your SMTP settings are working correctly!",
      html: `<div style="font-family:sans-serif;padding:24px;background:#0d1117;color:#c9d1d9;border-radius:12px;max-width:480px;margin:0 auto"><h2 style="color:#10e88a;margin:0 0 12px">✅ SMTP Test Successful</h2><p>Your Applegate Monitor SMTP settings are working correctly. You'll now receive email alerts when servers go down.</p></div>`
    });
    addLog({ level:"info", server:"admin", message:`SMTP test email sent to ${to} by ${req.session.username}` });
    res.json({ ok: true });
  } catch(e) {
    addLog({ level:"warn", server:"admin", message:`SMTP test failed: ${e.message}` });
    res.status(500).json({ error: e.message });
  }
});

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
    addAuditLog({ userId: req.session.userId, username: req.session.username, action:"user.create", resourceType:"user", resourceId: result.insertId, resourceName: username, detail: role, ip: req.ip });
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
    addAuditLog({ userId: req.session.userId, username: req.session.username, action:"user.update", resourceType:"user", resourceId: req.params.id, resourceName: username, detail: role, ip: req.ip });
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
    addAuditLog({ userId: req.session.userId, username: req.session.username, action:"user.delete", resourceType:"user", resourceId: req.params.id, resourceName: rows[0].username, ip: req.ip });
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
  const isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(url);
  if (!isEmail && !/^https?:\/\//i.test(url)) return res.status(400).json({ error:"URL must start with http:// or https:// (or be an email address)" });
  const fmt = ["auto","generic","discord","slack","email"].includes(format) ? format : "auto";
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
  const isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(url);
  if (!isEmail && !/^https?:\/\//i.test(url)) return res.status(400).json({ error:"URL must start with http:// or https:// (or be an email address)" });
  const fmt = ["auto","generic","discord","slack","email"].includes(format) ? format : "auto";
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
    // Resolve dashboard link: use custom_domain if set, otherwise EXTERNAL_URL + slug
    let dashboardUrl = null;
    if (h.group_id) {
      try {
        const [slugRows] = await db.query("SELECT slug, custom_domain FROM status_groups WHERE id=?", [h.group_id]);
        if (slugRows.length && slugRows[0].custom_domain) {
          dashboardUrl = `https://${slugRows[0].custom_domain}`;
        } else if (slugRows.length && EXTERNAL_URL) {
          dashboardUrl = `${EXTERNAL_URL}/dashboard/${slugRows[0].slug}`;
        }
      } catch(e) { /* proceed without link */ }
    }
    const fmt = h.format === "auto" ? detectFormat(h.url) : h.format;
    const body = buildWebhookPayload(fmt, {
      server:   "Test Server",
      host:     "127.0.0.1",
      status:   "test",
      previous: "test",
      cause:    "This is a test event from Status Monitor — no actual issue detected",
      time:     new Date().toISOString(),
      isRecovery: false,
      isTest:   true,
      dashboardUrl
    });
    try {
      if (body._email) {
        await sendEmailAlert(h.url, body);
        addLog({ level:"info", server:"webhook", message:`Test email sent for "${h.name}" to ${h.url}` });
        res.json({ ok:true, status: 200, format: fmt });
      } else {
        const result = await postWebhook(h.url, body);
        addLog({ level:"info", server:"webhook", message:`Test sent for "${h.name}" (HTTP ${result.status})` });
        res.json({ ok:true, status: result.status, format: fmt });
      }
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
  const { name, slug, description, logo_text, logo_image, logo_size, accent_color, bg_color, default_theme, custom_domain, server_ids, privacy_text, terms_text } = req.body;
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
      "INSERT INTO status_groups (slug, name, description, logo_text, logo_image, logo_size, accent_color, bg_color, default_theme, custom_domain, privacy_text, terms_text) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      [finalSlug, name, description || "", logo_text || "", cleanLogo, cleanLogoSize, accent_color || "#2a7fff", cleanBg, cleanTheme, cleanDomain, privacy_text || null, terms_text || null]
    );
    const newId = result.insertId;
    if (Array.isArray(server_ids) && server_ids.length) {
      // Add each server to this group (many-to-many — does NOT remove them from other groups)
      const rows = server_ids.map(sid => [sid, newId]);
      await db.query("INSERT IGNORE INTO status_server_group_map (server_id, group_id) VALUES ?", [rows]);
      await loadConfig();
    }
    addLog({ level:"info", server:"admin", message:`Group created: ${name} (/${finalSlug})` });
    addAuditLog({ userId: req.session.userId, username: req.session.username, action:"group.create", resourceType:"group", resourceId: newId, resourceName: name, detail: `/${finalSlug}`, ip: req.ip });
    res.json({ ok:true, id: newId, slug: finalSlug });
  } catch(err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "Slug already in use" });
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/admin/groups/:id", requireAuth, async (req, res) => {
  const gid = parseInt(req.params.id);
  // Viewers may only edit groups they are assigned to
  if (req.session.role !== "admin") {
    const allowed = await getUserAllowedGroupIds(req.session.userId, req.session.role);
    if (!Array.isArray(allowed) || !allowed.includes(gid))
      return res.status(403).json({ error: "Forbidden – you can only edit your own dashboards" });
  }
  const { name, slug, description, logo_text, logo_image, logo_size, accent_color, bg_color, default_theme, custom_domain, privacy_text, terms_text } = req.body;
  // Only admins may change server assignments
  const server_ids = req.session.role === "admin" ? req.body.server_ids : undefined;
  if (!name) return res.status(400).json({ error: "Name is required" });
  const finalSlug = slugify(slug || name);
  if (!finalSlug) return res.status(400).json({ error: "Slug is required" });
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
      "UPDATE status_groups SET slug=?, name=?, description=?, logo_text=?, logo_image=?, logo_size=?, accent_color=?, bg_color=?, default_theme=?, custom_domain=?, privacy_text=?, terms_text=? WHERE id=?",
      [finalSlug, name, description || "", logo_text || "", cleanLogo, cleanLogoSize, accent_color || "#2a7fff", cleanBg, cleanTheme, cleanDomain, privacy_text || null, terms_text || null, gid]
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
    addAuditLog({ userId: req.session.userId, username: req.session.username, action:"group.update", resourceType:"group", resourceId: gid, resourceName: name, detail: `/${finalSlug}`, ip: req.ip });
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
    addAuditLog({ userId: req.session.userId, username: req.session.username, action:"group.delete", resourceType:"group", resourceId: gid, resourceName: rows[0].name, ip: req.ip });
    res.json({ ok:true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// -- Omada Controllers admin ---------------------------------------------------
// Helper: load group_ids array for a list of controller ids from the map table
async function omadaLoadGroupIds(controllerIds) {
  if (!controllerIds.length) return {};
  const [rows] = await db.query(
    "SELECT controller_id, group_id FROM status_omada_controller_groups WHERE controller_id IN (?)",
    [controllerIds]
  );
  const map = {};
  for (const r of rows) (map[r.controller_id] ||= []).push(r.group_id);
  return map;
}

// Helper: viewers can manage a controller iff any of its group_ids overlap with their allowed list.
async function userCanManageOmadaCtrl(req, ctrlGroupIds) {
  if (req.session.role === "admin") return true;
  if (!Array.isArray(ctrlGroupIds) || !ctrlGroupIds.length) return false;
  const allowed = await getUserAllowedGroupIds(req.session.userId, req.session.role);
  return Array.isArray(allowed) && ctrlGroupIds.some(gid => allowed.includes(gid));
}

// List controllers — admin sees all; viewer sees only those sharing at least one allowed group
app.get("/api/admin/omada-controllers", requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT id, name, base_url, client_id, omadac_id, verify_tls, mode, last_error, created_at FROM status_omada_controllers ORDER BY created_at"
    );
    const groupMap = await omadaLoadGroupIds(rows.map(r => r.id));
    const withGroups = rows.map(r => ({ ...r, group_ids: groupMap[r.id] || [] }));
    const allowed = await getUserAllowedGroupIds(req.session.userId, req.session.role);
    const filtered = (allowed === null)
      ? withGroups
      : withGroups.filter(r => r.group_ids.some(gid => allowed.includes(gid)));
    res.json(filtered);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Create controller — auto-discovers omadacId, tests auth, stores everything
app.post("/api/admin/omada-controllers", requireAuth, async (req, res) => {
  const { name, base_url, client_id, client_secret, verify_tls, group_ids } = req.body;
  if (!name || !base_url || !client_id || !client_secret) {
    return res.status(400).json({ error: "name, base_url, client_id and client_secret are required" });
  }
  // Normalize group_ids to a clean int array
  let cleanGroupIds = Array.isArray(group_ids) ? group_ids.map(Number).filter(Boolean) : [];
  // Viewers must scope to at least one of their allowed groups
  if (req.session.role !== "admin") {
    if (!cleanGroupIds.length) return res.status(400).json({ error: "Must assign at least one group" });
    const allowed = await getUserAllowedGroupIds(req.session.userId, req.session.role);
    if (!Array.isArray(allowed) || !cleanGroupIds.every(gid => allowed.includes(gid))) {
      return res.status(403).json({ error: "You don't have access to one or more of those groups" });
    }
  }
  const url = String(base_url).replace(/\/$/, "");
  const vtls = verify_tls !== false;
  try {
    const info = await omadaGetInfo(url, vtls);
    const omadacId = info.omadacId || info.omadacid;
    if (!omadacId) throw new Error("/api/info returned no omadacId");
    const [result] = await db.query(
      "INSERT INTO status_omada_controllers (name, base_url, client_id, client_secret, omadac_id, verify_tls) VALUES (?,?,?,?,?,?)",
      [name, url, client_id, client_secret, omadacId, vtls ? 1 : 0]
    );
    const newId = result.insertId;
    // Write group associations
    if (cleanGroupIds.length) {
      await db.query(
        "INSERT IGNORE INTO status_omada_controller_groups (controller_id, group_id) VALUES ?",
        [cleanGroupIds.map(gid => [newId, gid])]
      );
    }
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
  const { name, base_url, client_id, client_secret, verify_tls, group_ids } = req.body;
  if (!name || !base_url || !client_id) {
    return res.status(400).json({ error: "name, base_url and client_id are required" });
  }
  const url = String(base_url).replace(/\/$/, "");
  const vtls = verify_tls !== false;
  try {
    const [rows] = await db.query("SELECT * FROM status_omada_controllers WHERE id=?", [id]);
    if (!rows.length) return res.status(404).json({ error: "Controller not found" });
    const existing = rows[0];
    const existingGroupMap = await omadaLoadGroupIds([id]);
    const existingGroupIds = existingGroupMap[id] || [];
    if (!(await userCanManageOmadaCtrl(req, existingGroupIds))) {
      return res.status(403).json({ error: "You don't have access to this controller" });
    }
    let cleanGroupIds = Array.isArray(group_ids) ? group_ids.map(Number).filter(Boolean) : existingGroupIds;
    if (req.session.role !== "admin") {
      if (!cleanGroupIds.length) return res.status(400).json({ error: "Must keep at least one group as a viewer" });
      const allowed = await getUserAllowedGroupIds(req.session.userId, req.session.role);
      if (!Array.isArray(allowed) || !cleanGroupIds.every(gid => allowed.includes(gid))) {
        return res.status(403).json({ error: "Controller must remain in your allowed groups" });
      }
    }
    const finalSecret = (client_secret && client_secret.length) ? client_secret : existing.client_secret;
    let omadacId = existing.omadac_id;
    try {
      const info = await omadaGetInfo(url, vtls);
      omadacId = info.omadacId || info.omadacid || omadacId;
    } catch(e) { /* keep old */ }
    await db.query(
      "UPDATE status_omada_controllers SET name=?, base_url=?, client_id=?, client_secret=?, omadac_id=?, verify_tls=?, last_error=NULL WHERE id=?",
      [name, url, client_id, finalSecret, omadacId, vtls ? 1 : 0, id]
    );
    // Replace group associations
    await db.query("DELETE FROM status_omada_controller_groups WHERE controller_id=?", [id]);
    if (cleanGroupIds.length) {
      await db.query(
        "INSERT IGNORE INTO status_omada_controller_groups (controller_id, group_id) VALUES ?",
        [cleanGroupIds.map(gid => [id, gid])]
      );
    }
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
    const [rows] = await db.query("SELECT name FROM status_omada_controllers WHERE id=?", [id]);
    if (!rows.length) return res.status(404).json({ error: "Controller not found" });
    const groupMap = await omadaLoadGroupIds([id]);
    if (!(await userCanManageOmadaCtrl(req, groupMap[id] || []))) {
      return res.status(403).json({ error: "You don't have access to this controller" });
    }
    await db.query("DELETE FROM status_omada_controller_groups WHERE controller_id=?", [id]);
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
    const groupMap = await omadaLoadGroupIds([id]);
    if (!(await userCanManageOmadaCtrl(req, groupMap[id] || []))) {
      return res.status(403).json({ error: "You don't have access to this controller" });
    }
    const sites = await omadaListSites(rows[0]);
    res.json(sites);
  } catch(e) {
    res.status(502).json({ error: e.message });
  }
});

// Viewer change-password (viewers can change their own password)
app.post("/api/change-password", requireAuth, loginLimiter, async (req, res) => {
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
    addAuditLog({ userId: req.session.userId, username: req.session.username, action:"password.change", resourceType:"user", resourceId: req.session.userId, resourceName: rows[0].username, ip: req.ip });
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
    // Group by poll cycle (checked_at) so servers with multiple check types
    // (ping + tcp + http etc.) still produce one dot per poll, not one per check.
    const [rows] = await db.query(
      `SELECT MIN(ok) AS ok, checked_at,
              GROUP_CONCAT(detail SEPARATOR ', ') AS detail,
              AVG(response_ms) AS response_ms
       FROM status_history
       WHERE server_id=?
       GROUP BY checked_at
       ORDER BY checked_at DESC LIMIT 180`,
      [req.params.id]
    );
    // MIN(ok): if any check failed (0), the dot is "down"
    // AVG(response_ms): average across check types for the tooltip
    res.json(rows.reverse().map(r => ({
      ok: !!r.ok,
      checked_at: r.checked_at,
      detail: r.detail,
      response_ms: r.response_ms != null ? Math.round(r.response_ms) : null
    })));
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
      description: s.description, category: s.category || "", tags: s.tags, group_ids: s.group_ids || [],
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
        description: s.description, category: s.category || "", tags: s.tags, group_ids: s.group_ids,
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

// ── PWA support ──────────────────────────────────────────────────────────────

// Minimal service worker — satisfies Chrome/Android installability requirement.
// Does not cache anything; all requests pass through to the network so live
// status data is never stale. The SW exists purely to unlock the browser's
// "Add to Home Screen" / install prompt.
app.get("/sw.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Cache-Control", "no-cache");
  res.send(`self.addEventListener("install",  e => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(clients.claim()));
self.addEventListener("fetch",    e => e.respondWith(fetch(e.request)));`);
});

// Group icon — used by manifest.json and as apple-touch-icon.
// Returns the group's stored logo_image (decoded from its base64 data URL)
// or a generated SVG icon built from the group's initials + accent color.
app.get("/api/icon/:slug", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT logo_image, logo_text, name, accent_color, bg_color FROM status_groups WHERE slug=?",
      [req.params.slug]
    );
    if (!rows.length) return res.status(404).send("Not found");
    const g = rows[0];
    if (g.logo_image && g.logo_image.startsWith("data:")) {
      const m = g.logo_image.match(/^data:(image\/[^;]+);base64,(.+)$/s);
      if (m) {
        res.setHeader("Content-Type", m[1]);
        res.setHeader("Cache-Control", "public, max-age=3600");
        return res.end(Buffer.from(m[2], "base64"));
      }
    }
    // Fallback: generate SVG from initials
    const initials = (g.logo_text || g.name || "?").substring(0, 2).toUpperCase();
    const accent   = g.accent_color || "#2a7fff";
    const bg       = g.bg_color     || "#060c18";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" rx="96" fill="${bg}"/>
  <rect x="24" y="24" width="464" height="464" rx="72" fill="${accent}" opacity="0.18"/>
  <text x="256" y="348" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="240" font-weight="700" fill="${accent}" text-anchor="middle">${initials}</text>
</svg>`;
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.end(svg);
  } catch(e) { res.status(500).send("Error"); }
});

// Per-group Web App Manifest — powers the "Add to Home Screen" / install prompt
// on both Android (Chrome) and iOS (Safari). Branding matches the group's theme.
app.get("/dashboard/:slug/manifest.json", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM status_groups WHERE slug=?", [req.params.slug]);
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    const g = rows[0];
    let iconType = "image/svg+xml";
    if (g.logo_image) {
      const m = g.logo_image.match(/^data:(image\/[^;]+);base64,/);
      if (m) iconType = m[1];
    }
    const shortName = g.name.length > 14 ? g.name.substring(0, 14).trimEnd() + "…" : g.name;
    res.setHeader("Content-Type", "application/manifest+json");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({
      name:             g.name,
      short_name:       shortName,
      description:      g.description || `${g.name} status dashboard`,
      start_url:        `/dashboard/${g.slug}`,
      scope:            `/dashboard/${g.slug}`,
      display:          "standalone",
      orientation:      "portrait-primary",
      theme_color:      g.accent_color || "#2a7fff",
      background_color: g.bg_color     || "#060c18",
      icons: [
        { src: `/api/icon/${g.slug}`, sizes: "any", type: iconType, purpose: "any"      },
        { src: `/api/icon/${g.slug}`, sizes: "any", type: iconType, purpose: "maskable" }
      ]
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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
  groupName:    "Applegate Monitor",
  groupSubtitle: "",
  accentColor:  "#2a7fff",
  bgColor:      null,
  logoText:     "",
  logoImage:    null,
  logoSize:     42,
  defaultTheme: "dark",
  pageTitle:    "System Status",
  privacyUrl:   "/privacy",
  termsUrl:     "/terms",
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
      // Serve group-specific privacy/terms pages on the custom domain.
      // Must render directly (not redirect) — redirecting to /privacy on the same custom
      // domain would re-enter this middleware and loop infinitely.
      if (req.path === "/privacy") {
        return g.privacy_text
          ? res.render("group-legal", { g, type: "privacy", content: g.privacy_text })
          : res.render("privacy");
      }
      if (req.path === "/terms") {
        return g.terms_text
          ? res.render("group-legal", { g, type: "terms", content: g.terms_text })
          : res.render("terms");
      }
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
        pageTitle:    `${g.name} — Status`,
        privacyUrl:   g.privacy_text ? "/privacy" : null,
        termsUrl:     g.terms_text   ? "/terms"   : null,
      });
    }
  } catch(e) { /* silent — fall through to normal routing */ }
  next();
});

// Authed master views: show all servers (across all groups + ungrouped)
app.get("/",       requireAuthPage, (req, res) => res.render("index", { adminHref: "/admin", ...DEFAULT_BRANDING }));
app.get("/status", requireAuthPage, (req, res) => res.render("index", { adminHref: "/", ...DEFAULT_BRANDING }));
app.get("/admin",  requireAuthPage, (req, res) => res.render("admin"));
app.get("/login",   (req, res) => res.render("login"));
app.get("/privacy", (req, res) => res.render("privacy"));
app.get("/terms",   (req, res) => res.render("terms"));

// Per-group dashboard
app.get("/dashboard/:slug", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM status_groups WHERE slug=?", [req.params.slug]);
    if (!rows.length) return res.status(404).render("404", { slug: req.params.slug });
    const g = rows[0];
    res.render("index", {
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
      pageTitle:    `${g.name} — Status`,
      privacyUrl:   g.privacy_text ? `/dashboard/${g.slug}/privacy` : "/privacy",
      termsUrl:     g.terms_text   ? `/dashboard/${g.slug}/terms`   : "/terms",
    });
  } catch(e) {
    res.status(500).send("Server error");
  }
});

// Per-group privacy and terms pages
app.get("/dashboard/:slug/privacy", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM status_groups WHERE slug=?", [req.params.slug]);
    if (!rows.length) return res.status(404).render("404", { slug: req.params.slug });
    const g = rows[0];
    return g.privacy_text
      ? res.render("group-legal", { g, type: "privacy", content: g.privacy_text })
      : res.render("privacy");
  } catch(e) { res.status(500).send("Server error"); }
});

app.get("/dashboard/:slug/terms", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM status_groups WHERE slug=?", [req.params.slug]);
    if (!rows.length) return res.status(404).render("404", { slug: req.params.slug });
    const g = rows[0];
    return g.terms_text
      ? res.render("group-legal", { g, type: "terms", content: g.terms_text })
      : res.render("terms");
  } catch(e) { res.status(500).send("Server error"); }
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

// -- Error handler (last resort) ---------------------------------------------
// Express 4: the 4-arg signature is what marks this as an error handler.
// Any `next(err)` or thrown error that bubbles out of a route lands here.
// We log server-side and return a generic message so stack traces never
// leak to the browser.
app.use((err, req, res, next) => {
  const msg = (err && err.message) || String(err);
  addLog({ level:"error", server:"system", message:`Unhandled error on ${req.method} ${req.path}: ${msg}` });
  if (res.headersSent) return next(err);
  if (req.path && req.path.startsWith("/api/")) {
    return res.status(500).json({ error: "Internal server error" });
  }
  res.status(500).send("Internal server error");
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
  const httpServer = app.listen(PORT, "::", () => {
    addLog({ level:"info", server:"system", message:`Server started on :${PORT} (dual-stack), interval ${CHECK_INTERVAL/1000}s` });
  });

  // Graceful shutdown. Container orchestrators send SIGTERM; Ctrl-C sends
  // SIGINT. We stop accepting new connections, end SSE streams, close the
  // DB pool, then exit. A 10s hard-kill guards against hung drains.
  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    addLog({ level:"info", server:"system", message:`Shutdown requested (${signal}); draining...` });
    httpServer.close(() => {
      [...sseClients, ...logClients].forEach(r => { try { r.end(); } catch(_) {} });
      const dbClose = db ? db.end().catch(() => {}) : Promise.resolve();
      dbClose.finally(() => process.exit(0));
    });
    setTimeout(() => {
      logger.error("Shutdown timeout reached — forcing exit");
      process.exit(1);
    }, 10_000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
})();