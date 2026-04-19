const express      = require("express");
const { exec }     = require("child_process");
const net          = require("net");
const http         = require("http");
const https        = require("https");
const fs           = require("fs");
const path         = require("path");
const crypto       = require("crypto");
const dns          = require("dns").promises;
const mysql        = require("mysql2/promise");
const bcrypt       = require("bcryptjs");
const session      = require("express-session");
const nodemailer   = require("nodemailer");
const helmet       = require("helmet");
const rateLimit    = require("express-rate-limit");
const pino         = require("pino");
const pinoHttp     = require("pino-http");
const { Agent: UndiciAgent } = require("undici"); // for Omada TLS dispatcher
const { OAuth2Client } = require("google-auth-library");

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
  contentSecurityPolicy:    false, // codeql[js/insecure-helmet-configuration] - intentionally disabled; EJS inline scripts/styles require a full CSP refactor
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
// General API rate limiter — applied to all /api/* routes to prevent abuse.
const apiLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             500,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: "Too many requests — slow down and try again shortly." }
});
// Page / public route limiter — covers non-API routes that still hit the DB.
const pageLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             300,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         "Too many requests — slow down."
});

const { version: APP_VERSION } = require("./package.json");
const APP_OWNER     = process.env.APP_OWNER         || "Richard Applegate";
const APP_CONTACT   = process.env.APP_CONTACT_EMAIL || "admin@richardapplegate.io";
const APP_HOME_URL  = process.env.APP_HOME_URL      || "/";
const EXTERNAL_URL  = (process.env.EXTERNAL_URL || "").replace(/\/+$/, "");  // optional fallback when no custom_domain
const GITHUB_REPO   = "X4Applegate/status-server";

// Google OAuth — configured via Admin → Settings (stored in DB)
const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || `${EXTERNAL_URL}/auth/google/callback`;
let googleOAuthConfig = { enabled: false, client_id: "", client_secret: "" };
let googleOAuth = null;

function rebuildGoogleOAuthClient() {
  googleOAuth = (googleOAuthConfig.enabled && googleOAuthConfig.client_id && googleOAuthConfig.client_secret)
    ? new OAuth2Client(googleOAuthConfig.client_id, googleOAuthConfig.client_secret, GOOGLE_CALLBACK_URL)
    : null;
}

async function loadGoogleOAuthFromDb() {
  if (!db) return;
  try {
    const [rows] = await db.query("SELECT key_name, value FROM status_settings WHERE key_name LIKE 'google_oauth_%'");
    const m = {};
    rows.forEach(r => { m[r.key_name] = r.value; });
    googleOAuthConfig = {
      enabled:       m.google_oauth_enabled === "true",
      client_id:     m.google_oauth_client_id     || "",
      client_secret: m.google_oauth_client_secret || ""
    };
    rebuildGoogleOAuthClient();
  } catch(e) { /* settings table may not exist yet */ }
}
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

// -- Mapbox (map tiles for authenticated users only) --------------------------
// Token is served only to logged-in users via /api/mapbox-token. The public
// /dashboard/<slug> pages never see it.
let mapboxConfig = { token: "" };

async function loadMapboxFromDb() {
  if (!db) return;
  try {
    const [rows] = await db.query("SELECT value FROM status_settings WHERE key_name='mapbox_token'");
    mapboxConfig = { token: (rows[0] && rows[0].value) || "" };
  } catch(e) { /* settings table may not exist yet */ }
}

// -- Weekly uptime report -----------------------------------------------------
// Persists admin preferences in status_settings. The scheduler checks hourly
// and fires once per ISO week on Monday ≥09:00 UTC.
let weeklyReportConfig = { enabled: false, recipients: [], lastSentAt: null };

async function loadWeeklyReportFromDb() {
  if (!db) return;
  try {
    const [rows] = await db.query("SELECT key_name, value FROM status_settings WHERE key_name LIKE 'weekly_report_%'");
    const m = {};
    rows.forEach(r => { m[r.key_name] = r.value; });
    weeklyReportConfig = {
      enabled:    m.weekly_report_enabled === "true",
      recipients: (m.weekly_report_recipients || "").split(/[\s,;]+/).map(s => s.trim()).filter(Boolean),
      lastSentAt: m.weekly_report_last_sent_at || null
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
// Alert debounce: hold DOWN alerts for 5 min; cancel if server recovers first
const pendingDownAlerts = new Map(); // serverId → { timer, evt }
const sentDownAlerts    = new Set(); // serverIds whose down-alert was actually fired
// Maintenance window cache: serverId → array of { id, title, start_time, end_time, notes }
// Refreshed every 60s and after any CRUD write. Checking a Set/Map is cheap enough to do
// on every runChecks() call.
let maintenanceCache = new Map();
let serverConfig = [];
let eventLog     = [];
// Liveness marker for /health — updated at the end of each pollAll() pass.
let lastPollAt   = 0;
const startedAt  = Date.now();

// Returns true if the given serverId is currently inside an active maintenance window.
function isUnderMaintenance(serverId) {
  const windows = maintenanceCache.get(String(serverId));
  if (!windows || !windows.length) return false;
  const now = Date.now();
  return windows.some(w => {
    const s = new Date(w.start_time).getTime();
    const e = new Date(w.end_time).getTime();
    return now >= s && now <= e;
  });
}

async function refreshMaintenanceCache() {
  try {
    // Only pull windows that haven't ended yet — past windows are historical, we keep them
    // in the DB for audit but don't need them in the hot-path cache.
    const [rows] = await db.query(
      "SELECT id, server_id, title, notes, start_time, end_time FROM status_maintenance_windows WHERE end_time >= NOW()"
    );
    const next = new Map();
    for (const r of rows) {
      const key = String(r.server_id);
      if (!next.has(key)) next.set(key, []);
      next.get(key).push(r);
    }
    maintenanceCache = next;
  } catch (e) {
    // Don't crash the monitor loop just because the cache refresh failed
    console.error("[maint] cache refresh failed:", e.message);
  }
}

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
app.use(session({ // codeql[js/missing-token-validation] - CSRF mitigated via Cloudflare Turnstile on auth forms + sameSite=lax session cookie
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

// Apply general rate limiting to all /api/* routes.
app.use("/api/", apiLimiter);

// -- Health endpoint ---------------------------------------------------------
// Unauthenticated probe for load balancers / uptime monitors. Returns 200 when
// DB is reachable and the poll loop has run within the last 2 minutes, else 503.
// Pass ?strict=1 to additionally require serverConfig.length > 0 (useful to keep
// a replica out of rotation until it has fully loaded its config).
// Response is tiny JSON and never cached.
app.get("/health", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const strict = req.query.strict === "1" || req.query.strict === "true";
  const body = {
    ok:          true,
    version:     require("./package.json").version,
    uptime_s:    Math.floor((Date.now() - startedAt) / 1000),
    db:          "unknown",
    last_poll_s: lastPollAt ? Math.floor((Date.now() - lastPollAt) / 1000) : null,
    servers:     Array.isArray(serverConfig) ? serverConfig.length : 0
  };
  // DB probe — 2s timeout so a hung DB never blocks the health check
  try {
    const probe = db
      ? await Promise.race([
          db.query("SELECT 1"),
          new Promise((_, r) => setTimeout(() => r(new Error("db timeout")), 2000))
        ]).then(() => true).catch(() => false)
      : false;
    body.db = probe ? "ok" : "down";
    if (!probe) body.ok = false;
  } catch(e) { body.db = "down"; body.ok = false; }
  // Poll-loop staleness: up to 2 poll intervals (default 30s each = 60s) plus slack
  if (body.last_poll_s !== null && body.last_poll_s > 120) {
    body.ok = false;
    body.reason = "poll_loop_stalled";
  }
  if (strict && body.servers === 0) {
    body.ok = false;
    body.reason = body.reason || "no_servers_loaded";
  }
  res.status(body.ok ? 200 : 503).json(body);
});

// -- Shared validation helpers -----------------------------------------------

/**
 * Linear-time email sanity check (bounded quantifiers prevent ReDoS).
 * Not a full RFC-5321 parser — just keeps obviously invalid values out of the DB.
 */
function isValidEmail(s) {
  if (typeof s !== "string" || s.length > 320) return false;
  return /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{1,63}$/.test(s);
}

// Human-readable duration string — "2m 14s", "1h 05m", "3d 4h". Used in incident
// update messages ("restored after 2m 14s") and on the public incident page.
function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60)    return `${s}s`;
  if (s < 3600)  return `${Math.floor(s/60)}m ${s%60}s`;
  if (s < 86400) {
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
    return `${h}h ${String(m).padStart(2,"0")}m`;
  }
  const d = Math.floor(s/86400), h = Math.floor((s%86400)/3600);
  return `${d}d ${h}h`;
}

function isPrivateOrLocalIp(host) {
  if (net.isIP(host) === 4) {
    if (host === "127.0.0.1" || host === "0.0.0.0") return true;
    const p = host.split(".").map(n => parseInt(n, 10));
    if (p[0] === 10) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    return false;
  }
  if (net.isIP(host) === 6) {
    const h = host.toLowerCase();
    return h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:");
  }
  return false;
}

async function assertAllowedControllerHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host) throw new Error("Invalid hostname in controller URL");
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error("Controller hostname is not allowed");
  }

  const allowlist = String(process.env.OMADA_CONTROLLER_HOST_ALLOWLIST || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length > 0) {
    const ok = allowlist.some(entry => host === entry || host.endsWith(`.${entry}`));
    if (!ok) throw new Error("Controller hostname not in allow-list");
  }

  if (isPrivateOrLocalIp(host)) throw new Error("Controller IP is not allowed");

  try {
    const records = await dns.lookup(host, { all: true });
    if (!records || records.length === 0) throw new Error("No DNS records found");
    for (const rec of records) {
      if (rec && rec.address && isPrivateOrLocalIp(rec.address)) {
        throw new Error("Controller resolves to a private/local address");
      }
    }
  } catch (e) {
    if (e && e.message && e.message.includes("private/local")) throw e;
    throw new Error("Controller hostname could not be validated");
  }
}

/**
 * Parse, validate, and reconstruct a controller base URL from its components only.
 * Accepts only http/https. Returns a clean origin string (protocol + host + port)
 * built from parsed fields — never from the raw input — so downstream fetch() calls
 * receive a value that cannot carry attacker-controlled path/query segments.
 */
async function sanitizeBaseUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new Error("Invalid controller URL"); }
  // Only http/https allowed — pick protocol from a fixed allow-list
  const proto = parsed.protocol === "https:" ? "https:" : parsed.protocol === "http:" ? "http:" : null;
  if (!proto) throw new Error("Controller URL must use http:// or https://");

  const rawHost = (parsed.hostname || "").toLowerCase();
  if (!rawHost) throw new Error("Invalid hostname in controller URL");
  if (rawHost === "localhost") throw new Error("Controller URL hostname is not allowed");

  // Reject private/local IP literals to prevent SSRF into internal networks.
  const isIpv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(rawHost);
  if (isIpv4) {
    const oct = rawHost.split(".").map(n => parseInt(n, 10));
    const valid = oct.length === 4 && oct.every(n => Number.isInteger(n) && n >= 0 && n <= 255);
    if (!valid) throw new Error("Invalid IPv4 hostname in controller URL");
    const [a, b] = oct;
    if (
      a === 127 ||                 // loopback
      a === 10 ||                  // private
      (a === 172 && b >= 16 && b <= 31) || // private
      (a === 192 && b === 168) ||  // private
      (a === 169 && b === 254) ||  // link-local
      a === 0                      // invalid/current network
    ) {
      throw new Error("Controller URL points to a disallowed private/local address");
    }
  }

  // Basic IPv6 local-range checks (URL.hostname is de-bracketed).
  if (rawHost.includes(":")) {
    if (rawHost === "::1" || rawHost.startsWith("fe80:") || rawHost.startsWith("fc") || rawHost.startsWith("fd")) {
      throw new Error("Controller URL points to a disallowed private/local address");
    }
  }

  // Whitelist-filter each DNS label to [a-zA-Z0-9-] — explicit character-class
  // replacement that CodeQL's taint analysis recognises as breaking the SSRF taint chain.
  const hostname = parsed.hostname
    .split(".")
    .map(label => label.replace(/[^a-zA-Z0-9\-]/g, ""))
    .filter(Boolean)
    .join(".");
  if (!hostname) throw new Error("Invalid hostname in controller URL");
  await assertAllowedControllerHost(hostname);
  // Coerce port to a plain integer so no string taint carries through
  const port = parsed.port ? `:${parseInt(parsed.port, 10)}` : "";
  return `${proto}//${hostname}${port}`;
}

/**
 * Reconstruct a full URL (origin + path + query) from parsed components only.
 * Breaks the CodeQL taint chain so user-supplied input never flows directly
 * into an outgoing request. Path segments are encoded to prevent traversal.
 */
function sanitizeRequestUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new Error("Invalid URL"); }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("URL must use http:// or https://");
  }
  const port = parsed.port ? `:${parsed.port}` : "";
  const origin = `${parsed.protocol}//${parsed.hostname}${port}`;
  // Re-encode each path segment to neutralise any traversal sequences ("../")
  const safePath = parsed.pathname
    .split("/")
    .map(seg => encodeURIComponent(decodeURIComponent(seg)))
    .join("/");
  const safeSearch = parsed.search; // query string kept as-is; already encoded by URL parser
  return `${origin}${safePath}${safeSearch}`;
}

/**
 * Sanitize a value used as a single URL path segment (e.g. a location ID).
 * Allows only characters that appear in Square / API IDs — alphanumeric, hyphen,
 * underscore. Rejects anything that could be used for path traversal.
 */
function sanitizePathSegment(value) {
  const str = String(value || "").trim();
  if (!/^[A-Za-z0-9_\-]+$/.test(str)) throw new Error(`Invalid path segment: "${str}"`);
  return str;
}

/**
 * Sanitize a hostname or IP used in a shell command (ping) or TCP connection.
 * Allows only characters valid in DNS names and IPv4/IPv6 literals.
 */
function sanitizeHost(raw) {
  const str = String(raw || "").trim();
  if (!/^[A-Za-z0-9.\-:\[\]]+$/.test(str) || str.length > 253) {
    throw new Error(`Invalid host: "${str}"`);
  }
  return str;
}

// -- Health check (Docker HEALTHCHECK / reverse proxy probe) -----------------
// Lightweight liveness+DB ping. Returns 200 when the DB pool responds to
// SELECT 1, 503 otherwise. No auth. No session. Not logged to the system log.
app.get("/healthz", pageLimiter, async (req, res) => {
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
      password_hash VARCHAR(255) DEFAULT NULL,
      role          ENUM('admin','viewer') NOT NULL DEFAULT 'viewer',
      first_name    VARCHAR(100) DEFAULT NULL,
      last_name     VARCHAR(100) DEFAULT NULL,
      email         VARCHAR(255) DEFAULT NULL,
      google_id     VARCHAR(100) DEFAULT NULL,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Add role column if upgrading from older version
  try {
    await db.query("ALTER TABLE status_users ADD COLUMN role ENUM('admin','viewer') NOT NULL DEFAULT 'viewer'");
  } catch(e) { /* column already exists, ignore */ }
  try {
    await db.query("ALTER TABLE status_users ADD COLUMN first_name VARCHAR(100) DEFAULT NULL");
  } catch(e) { /* column already exists */ }
  try {
    await db.query("ALTER TABLE status_users ADD COLUMN last_name VARCHAR(100) DEFAULT NULL");
  } catch(e) { /* column already exists */ }
  try {
    await db.query("ALTER TABLE status_users ADD COLUMN email VARCHAR(255) DEFAULT NULL");
  } catch(e) { /* column already exists */ }
  try {
    await db.query("ALTER TABLE status_users ADD COLUMN google_id VARCHAR(100) DEFAULT NULL");
  } catch(e) { /* column already exists */ }
  try {
    await db.query("ALTER TABLE status_users MODIFY COLUMN password_hash VARCHAR(255) DEFAULT NULL");
  } catch(e) { /* already nullable */ }

  await db.query(`
    CREATE TABLE IF NOT EXISTS status_servers (
      id                VARCHAR(150) PRIMARY KEY,
      name              VARCHAR(255) NOT NULL,
      host              VARCHAR(255) NOT NULL,
      description       TEXT,
      category          VARCHAR(100) DEFAULT NULL,
      sub_category      VARCHAR(100) DEFAULT NULL,
      tags              JSON,
      checks            JSON,
      sort_order        INT DEFAULT 0,
      poll_interval_sec INT NOT NULL DEFAULT 30,
      failure_threshold INT NOT NULL DEFAULT 1,
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
  try {
    await db.query("ALTER TABLE status_servers ADD COLUMN sub_category VARCHAR(100) DEFAULT NULL");
  } catch(e) { /* column already exists */ }
  try {
    await db.query("ALTER TABLE status_servers ADD COLUMN failure_threshold INT NOT NULL DEFAULT 1");
  } catch(e) { /* column already exists */ }
  // Runbook: free-form markdown that on-call can read on the detail panel when a
  // server is down. Kept as TEXT (up to ~64KB) — long enough for multi-step playbooks,
  // short enough to keep the single-row payload cheap.
  try {
    await db.query("ALTER TABLE status_servers ADD COLUMN runbook TEXT DEFAULT NULL");
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

  // Additive incident columns for the public incident page:
  //   title  — optional custom headline (falls back to server_name + cause)
  //   status — investigating → identified → monitoring → resolved
  //   impact — minor / major / critical
  //   public — 1 = show on public incident page, 0 = hidden
  // All default to sensible values so existing auto-detected incidents keep working.
  try { await db.query("ALTER TABLE status_incidents ADD COLUMN title VARCHAR(200) DEFAULT NULL"); } catch(e) {}
  try { await db.query("ALTER TABLE status_incidents ADD COLUMN status ENUM('investigating','identified','monitoring','resolved') NOT NULL DEFAULT 'investigating'"); } catch(e) {}
  try { await db.query("ALTER TABLE status_incidents ADD COLUMN impact ENUM('minor','major','critical') NOT NULL DEFAULT 'minor'"); } catch(e) {}
  try { await db.query("ALTER TABLE status_incidents ADD COLUMN public TINYINT(1) NOT NULL DEFAULT 1"); } catch(e) {}

  // Dashboard banners — persistent announcement bars shown at the top of the
  // public dashboard. group_id NULL means global (shows on every dashboard);
  // a numeric group_id scopes the banner to one group. Time window (starts_at /
  // ends_at) is optional; NULL endpoints mean "always" on that side. dismissible
  // controls whether visitors can hide it for their session.
  await db.query(`
    CREATE TABLE IF NOT EXISTS status_banners (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      group_id     INT NULL,
      title        VARCHAR(200) DEFAULT NULL,
      message      TEXT NOT NULL,
      severity     ENUM('info','warning','critical','success') NOT NULL DEFAULT 'info',
      link_url     VARCHAR(500) DEFAULT NULL,
      link_text    VARCHAR(100) DEFAULT NULL,
      active       TINYINT(1) NOT NULL DEFAULT 1,
      dismissible  TINYINT(1) NOT NULL DEFAULT 1,
      starts_at    DATETIME NULL DEFAULT NULL,
      ends_at      DATETIME NULL DEFAULT NULL,
      created_by   INT NULL,
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_group (group_id),
      INDEX idx_active (active, starts_at, ends_at)
    )
  `);

  // Timeline of operator-authored updates for an incident.
  // Each status transition (investigating → identified, etc.) appends one row.
  // The message field supports plain text / minimal markdown — rendered escaped on the public page.
  await db.query(`
    CREATE TABLE IF NOT EXISTS status_incident_updates (
      id           BIGINT AUTO_INCREMENT PRIMARY KEY,
      incident_id  BIGINT NOT NULL,
      status       ENUM('investigating','identified','monitoring','resolved') NOT NULL,
      message      TEXT NOT NULL,
      created_by   INT NULL,
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_incident (incident_id, created_at)
    )
  `);

  // Maintenance windows: planned downtime that suppresses alerts.
  // One row per server per window — if you want a multi-server window, create N rows.
  await db.query(`
    CREATE TABLE IF NOT EXISTS status_maintenance_windows (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      server_id    VARCHAR(150) NOT NULL,
      title        VARCHAR(200) NOT NULL,
      notes        TEXT,
      start_time   DATETIME NOT NULL,
      end_time     DATETIME NOT NULL,
      created_by   INT NULL,
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_server (server_id),
      INDEX idx_window (start_time, end_time)
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
    CREATE TABLE IF NOT EXISTS status_square_accounts (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      name           VARCHAR(150) NOT NULL,
      application_id VARCHAR(255) DEFAULT '',
      access_token   VARCHAR(255) NOT NULL,
      environment    VARCHAR(16)  NOT NULL DEFAULT 'production',
      created_by     INT DEFAULT NULL,
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  try {
    await db.query("ALTER TABLE status_square_accounts ADD COLUMN application_id VARCHAR(255) DEFAULT ''");
  } catch(e) { /* column already exists */ }
  try {
    await db.query("ALTER TABLE status_square_accounts ADD COLUMN created_by INT DEFAULT NULL");
  } catch(e) { /* column already exists */ }
  // Many-to-many: Square accounts can be assigned to multiple groups, and viewers assigned
  // to any of those groups can see/use the account in their server checks.
  await db.query(`
    CREATE TABLE IF NOT EXISTS status_square_account_groups (
      account_id INT NOT NULL,
      group_id   INT NOT NULL,
      PRIMARY KEY (account_id, group_id),
      FOREIGN KEY (account_id) REFERENCES status_square_accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (group_id)   REFERENCES status_groups(id)          ON DELETE CASCADE
    )
  `);

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

  // Beta: public status page toggle per group
  try {
    await db.query("ALTER TABLE status_groups ADD COLUMN public_enabled TINYINT(1) NOT NULL DEFAULT 0");
  } catch(e) { /* column already exists */ }

  // Beta: email subscriptions — allow public visitors to opt in to down/recovery alerts
  await db.query(`
    CREATE TABLE IF NOT EXISTS status_email_subscriptions (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      email             VARCHAR(255) NOT NULL,
      group_id          INT NOT NULL,
      notify_down       TINYINT(1) NOT NULL DEFAULT 1,
      notify_recovery   TINYINT(1) NOT NULL DEFAULT 1,
      unsubscribe_token VARCHAR(64) NOT NULL,
      confirmed         TINYINT(1) NOT NULL DEFAULT 1,
      created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_email_group (email, group_id),
      FOREIGN KEY (group_id) REFERENCES status_groups(id) ON DELETE CASCADE
    )
  `);

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
  // Upgrade-safe: extend format enum as new integrations are added
  try {
    await db.query("ALTER TABLE status_webhooks MODIFY COLUMN format ENUM('auto','generic','discord','slack','email','teams','telegram','pushover') NOT NULL DEFAULT 'auto'");
  } catch(e) { /* already updated */ }

  // Beta: DB-backed server pins — persists across devices when logged in
  await db.query(`
    CREATE TABLE IF NOT EXISTS status_pinned_servers (
      user_id   INT NOT NULL,
      server_id VARCHAR(64) NOT NULL,
      pinned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, server_id),
      FOREIGN KEY (user_id) REFERENCES status_users(id) ON DELETE CASCADE
    )
  `);

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

  await db.query(`
    CREATE TABLE IF NOT EXISTS status_api_keys (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      name         VARCHAR(150) NOT NULL,
      key_hash     VARCHAR(64)  NOT NULL UNIQUE,
      key_prefix   VARCHAR(12)  NOT NULL,
      scope        VARCHAR(20)  NOT NULL DEFAULT 'read',
      last_used_at TIMESTAMP    NULL DEFAULT NULL,
      created_by   INT          NOT NULL,
      created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Beta: geographic coordinates for map view
  try {
    await db.query("ALTER TABLE status_servers ADD COLUMN lat DECIMAL(10,7) DEFAULT NULL");
  } catch(e) { /* column already exists */ }
  try {
    await db.query("ALTER TABLE status_servers ADD COLUMN lng DECIMAL(10,7) DEFAULT NULL");
  } catch(e) { /* column already exists */ }
  try {
    await db.query("ALTER TABLE status_servers ADD COLUMN location_address VARCHAR(500) DEFAULT NULL");
  } catch(e) { /* column already exists */ }

  // Load SMTP config from DB (overrides env vars if set)
  await loadSmtpFromDb();
  await loadTurnstileFromDb();
  await loadGoogleOAuthFromDb();
  await loadMapboxFromDb();
  await loadWeeklyReportFromDb();

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
      sub_category:      r.sub_category || "",
      runbook:           r.runbook || "",
      poll_interval_sec: r.poll_interval_sec || 30,
      failure_threshold: Math.max(1, Math.min(10, r.failure_threshold || 1)),
      group_ids:         groupsByServer[r.id] || [],
      tags:              typeof r.tags   === "string" ? JSON.parse(r.tags)   : (r.tags   || []),
      checks:            typeof r.checks === "string" ? JSON.parse(r.checks) : (r.checks || []),
      lat: r.lat != null ? parseFloat(r.lat) : null,
      lng: r.lng != null ? parseFloat(r.lng) : null,
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
              serverStatus[s.id] = { id:s.id, name:s.name, host:s.host, description:s.description, category:s.category, sub_category:s.sub_category, group_ids:s.group_ids, tags:s.tags, checks:[], overall:"pending", lastChecked:null, uptimeHistory: histByServer[s.id], lat:s.lat||null, lng:s.lng||null };
            } else {
              serverStatus[s.id].uptimeHistory = histByServer[s.id];
            }
          }
        }
      } catch(e) { /* proceed without history */ }
    }

    serverConfig.forEach(s => {
      if (!serverStatus[s.id]) {
        serverStatus[s.id] = { id:s.id, name:s.name, host:s.host, description:s.description, category:s.category, sub_category:s.sub_category, runbook:s.runbook||"", group_ids:s.group_ids, tags:s.tags, checks:[], overall:"pending", lastChecked:null, uptimeHistory:[], lat:s.lat||null, lng:s.lng||null };
      } else {
        // Keep group_ids + runbook in sync on existing entries
        serverStatus[s.id].group_ids = s.group_ids;
        serverStatus[s.id].runbook   = s.runbook || "";
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
    let safeHost;
    try { safeHost = sanitizeHost(host); } catch(e) {
      return resolve({ type:"ping", ok:false, detail:`Invalid host: ${e.message}` });
    }
    exec(`ping -c 2 -W 2 ${safeHost}`, (err, stdout) => {
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

function httpCheck(url, expectedStatus=200, timeout=5000, showCert=true, contains="", notContains="") {
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
    // Reconstruct from parsed components only — breaks taint chain so no raw user
    // input flows into the outgoing request (SSRF / path-traversal hardening).
    let safeUrl;
    try { safeUrl = sanitizeRequestUrl(url); } catch(e) {
      return resolve({ type:"http", url, ok:false, detail:`invalid URL: ${e.message}` });
    }
    const lib = isHttps ? https : http;
    // Use the no-cache agent for HTTPS so each poll triggers a fresh TLS handshake
    // (required for getPeerCertificate() to return actual cert data every time).
    const reqOpts = { timeout };
    if (isHttps) reqOpts.agent = httpsNoCacheAgent;
    const t0 = Date.now();
    // Only read the body when a keyword match is actually configured — keeps the
    // hot path identical for users who don't use content matching.
    const wantsBody = !!(contains || notContains);
    // Cap body buffering at 1 MB so a misbehaving upstream can't balloon memory.
    const MAX_BODY = 1024 * 1024;
    const req = lib.get(safeUrl, reqOpts, res => {
      const response_ms = Date.now() - t0;
      const statusOk = res.statusCode === expectedStatus;
      const result = { type:"http", url, ok: statusOk, response_ms, detail:`HTTP ${res.statusCode}` };
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
      if (!wantsBody) {
        resolve(result);
        res.resume();
        return;
      }
      // Body-matching path: buffer up to MAX_BODY bytes, then match.
      let size = 0;
      const chunks = [];
      res.on("data", chunk => {
        if (size >= MAX_BODY) return;
        size += chunk.length;
        chunks.push(chunk);
      });
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8", 0, Math.min(size, MAX_BODY));
        const hasContains    = contains    ? body.includes(contains)    : true;
        const hasNotContains = notContains ? !body.includes(notContains) : true;
        if (!hasContains) {
          result.ok = false;
          result.detail = `HTTP ${res.statusCode} · missing "${contains.slice(0,40)}"`;
        } else if (!hasNotContains) {
          result.ok = false;
          result.detail = `HTTP ${res.statusCode} · forbidden "${notContains.slice(0,40)}"`;
        } else if (statusOk && (contains || notContains)) {
          // Preserve cert-warning detail if already set, otherwise annotate match.
          if (result.detail === `HTTP ${res.statusCode}`) {
            result.detail = `HTTP ${res.statusCode} · content OK`;
          }
        }
        resolve(result);
      });
      res.on("error", e => resolve({ type:"http", url, ok:false, detail:`body read: ${e.message}` }));
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
  const safeBase = await sanitizeBaseUrl(baseUrl);
  const url = `${safeBase}/api/info`;
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
  const safeBase = await sanitizeBaseUrl(controller.base_url);
  const url = `${safeBase}/openapi/authorize/token?grant_type=client_credentials`;
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
  const safeBase  = await sanitizeBaseUrl(controller.base_url);
  const safeId    = sanitizePathSegment(controller.omadac_id);
  // Sanitize each path segment to prevent traversal; preserve query string as-is
  const [pathOnly, queryString] = path.split("?");
  const safePath  = pathOnly.split("/").map(seg => seg.replace(/[^A-Za-z0-9\-_.:@!$&'()*+,;=~]/g, "")).join("/");
  const token = await omadaGetToken(controller);
  const url   = `${safeBase}/openapi/v1/${safeId}${safePath}${queryString ? "?" + queryString : ""}`;
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
  const safeBase = await sanitizeBaseUrl(controller.base_url);
  const mspId    = sanitizePathSegment(controller.omadac_id);
  // Sanitize each path segment to prevent traversal; preserve query string as-is
  const [pathOnly, queryString] = path.split("?");
  const safePath = pathOnly.split("/").map(seg => seg.replace(/[^A-Za-z0-9\-_.:@!$&'()*+,;=~]/g, "")).join("/");
  const token = await omadaGetToken(controller);
  const url   = `${safeBase}/openapi/v1/msp/${mspId}${safePath}${queryString ? "?" + queryString : ""}`;
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
async function omadaDeviceCheck(controllerId, siteId, customerId, siteName, customerName, deviceMac, deviceName) {
  try {
    const [rows] = await db.query("SELECT * FROM status_omada_controllers WHERE id=?", [controllerId]);
    if (!rows.length) return { type:"omada_device", ok:false, detail:"controller not found" };
    const ctrl = rows[0];
    const apiStart = Date.now();
    const devices = await omadaListDevices(ctrl, siteId, customerId, siteName, customerName);
    const apiResponseMs = Date.now() - apiStart;

    const device = devices.find(d => (d.mac || "").toLowerCase() === (deviceMac || "").toLowerCase());
    if (!device) {
      return { type:"omada_device", ok:false, detail:`${deviceName || deviceMac} not found in site` };
    }

    const ok    = device.status === 1 || device.status === 11;
    const model = device.model || device.modelName || device.product || null;
    const uptimeSec  = parseOmadaUptime(device.uptimeLong ?? device.uptime ?? null);
    const uptimeStr  = uptimeSec ? ` · up ${formatUptime(uptimeSec)}` : "";
    const modelStr   = model ? `${model} ` : "";
    const clientNum  = device.clientNum ?? device.clients ?? device.numClient ?? device.numClients ?? null;
    const clientStr  = clientNum != null ? ` · ${clientNum} client${clientNum === 1 ? "" : "s"}` : "";
    const detail = ok
      ? `${modelStr}connected${uptimeStr}${clientStr}`
      : `${deviceName || model || "Device"} offline (status ${device.status})`;

    return { type:"omada_device", ok, detail, response_ms: apiResponseMs };
  } catch(e) {
    return { type:"omada_device", ok:false, detail: e.message };
  }
}

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

async function squarePosCheck(accountId, locationId, deviceId, timeout=8000, inlineToken="") {
  const t0 = Date.now();
  try {
    let accessToken = inlineToken;
    let baseUrl = "https://connect.squareup.com";
    if (accountId) {
      const [rows] = await db.query("SELECT access_token, environment FROM status_square_accounts WHERE id=?", [accountId]);
      if (!rows.length) return { type:"square_pos", ok:false, detail:"Square account not found" };
      accessToken = rows[0].access_token;
      baseUrl = rows[0].environment === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
    }
    if (!accessToken) return { type:"square_pos", ok:false, detail:"No access token configured" };
    // Sanitize locationId — Square IDs are uppercase alphanumeric; reject anything
    // that could be used for path traversal or query injection.
    let safeLocationId;
    try { safeLocationId = sanitizePathSegment(locationId); } catch(e) {
      return { type:"square_pos", ok:false, detail:`Invalid location ID: ${e.message}` };
    }
    const headers = {
      "Authorization": `Bearer ${accessToken}`,
      "Square-Version": "2024-01-17",
      "Content-Type": "application/json"
    };
    // 1 — Location status
    const locRes = await fetch(`${baseUrl}/v2/locations/${safeLocationId}`, {
      headers, signal: AbortSignal.timeout(timeout)
    });
    if (!locRes.ok) {
      return { type:"square_pos", ok:false, detail:`Location API HTTP ${locRes.status}` };
    }
    const locData = await locRes.json();
    const loc = locData.location || {};
    const locationActive = loc.status === "ACTIVE";

    // 2 — Device status
    const devRes = await fetch(`${baseUrl}/v2/devices?location_id=${safeLocationId}`, {
      headers, signal: AbortSignal.timeout(timeout)
    });
    if (!devRes.ok) {
      return { type:"square_pos", ok:false, detail:`Devices API HTTP ${devRes.status}` };
    }
    const devData = await devRes.json();
    const devices = devData.devices || [];
    const locLabel = loc.name || locationId;

    // If no Terminal hardware devices are registered (e.g. iPad/mobile POS), skip device check
    if (!devices.length) {
      return { type:"square_pos", ok: locationActive, detail:`${locLabel} ${locationActive ? "ACTIVE" : "INACTIVE"}`, response_ms: Date.now()-t0 };
    }

    const targetDevices = deviceId ? devices.filter(d => d.id === deviceId || d.attributes?.serial_number === deviceId) : devices;
    const isOnline     = d => d.status?.category === "AVAILABLE" || d.status?.category === "NEEDS_ATTENTION";
    const anyOnline    = targetDevices.some(isOnline);
    const onlineCount  = targetDevices.filter(isOnline).length;
    const totalCount   = targetDevices.length;
    const anyNeedsAttn = targetDevices.some(d => d.status?.category === "NEEDS_ATTENTION");

    const ok = locationActive && anyOnline;
    const devName   = targetDevices[0]?.attributes?.name || targetDevices[0]?.attributes?.serial_number || deviceId;
    const devStatus = totalCount === 0        ? " (not found)"
      : anyNeedsAttn && onlineCount === totalCount ? " (needs attention)"
      : !anyOnline                           ? " (offline)" : "";
    const devLabel = deviceId
      ? `${devName}${devStatus}`
      : `${onlineCount}/${totalCount} device${totalCount !== 1 ? "s" : ""} online`;
    const detail = `${locLabel} ${locationActive ? "ACTIVE" : "INACTIVE"} · ${devLabel}`;

    return { type:"square_pos", ok, detail, response_ms: Date.now()-t0 };
  } catch(e) {
    return { type:"square_pos", ok:false, detail: e.message };
  }
}

// Script check — runs a user-defined command; exit 0 = up, non-zero = down.
// Uses spawn (not exec) to avoid shell injection. Command must be pre-validated
// (no shell metacharacters) at save time.
function scriptCheck(command, timeout=5000) {
  const { spawn } = require("child_process");
  return new Promise(resolve => {
    const t0 = Date.now();
    const parts = (command||"").trim().split(/\s+/);
    const [bin, ...args] = parts;
    let stdout = "", stderr = "", done = false;
    const child = spawn(bin, args, { timeout, stdio: ["ignore","pipe","pipe"] });
    child.stdout.on("data", d => { stdout += d.toString().slice(0, 500); });
    child.stderr.on("data", d => { stderr += d.toString().slice(0, 200); });
    child.on("close", code => {
      if (done) return; done = true;
      const ok = code === 0;
      const detail = (stdout.trim() || stderr.trim() || `exit ${code ?? "timeout"}`).slice(0, 255);
      resolve({ type:"script", ok, response_ms: Date.now()-t0, detail });
    });
    child.on("error", e => {
      if (done) return; done = true;
      resolve({ type:"script", ok:false, response_ms: Date.now()-t0, detail: e.message });
    });
  });
}

async function runChecks(def) {
  return Promise.all((def.checks||[{type:"ping"}]).map(async c => {
    // Wrap every check in a try/catch so one malformed check (bad URL, etc.)
    // can never crash the poll loop or leak an unhandled rejection.
    try {
      if (c.type==="ping")          return await pingCheck(def.host);
      if (c.type==="tcp")           return await tcpCheck(def.host, c.port, c.timeout);
      if (c.type==="http")          return await httpCheck(c.url, c.expectedStatus, c.timeout, c.show_cert !== false, c.contains || "", c.not_contains || "");
      if (c.type==="udp")           return await udpCheck(def.host, c.port, c.timeout);
      if (c.type==="dns")           return await dnsCheck(c.hostname || def.host, c.record_type, c.expected, c.timeout);
      if (c.type==="omada_gateway") return await omadaGatewayCheck(c.controller_id, c.site_id, c.customer_id, c.site_name, c.customer_name, def.host);
      if (c.type==="omada_lte")     return await omadaLteCheck(c.controller_id, c.site_id, c.customer_id, c.site_name, c.customer_name, c.probe_ip || null);
      if (c.type==="omada_device")  return await omadaDeviceCheck(c.controller_id, c.site_id, c.customer_id, c.site_name, c.customer_name, c.device_mac, c.device_name);
      if (c.type==="square_pos")   return await squarePosCheck(c.account_id||0, c.location_id, c.device_id||"", c.timeout, c.access_token||"");
      if (c.type==="script")       return await scriptCheck(c.command, c.timeout);
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
                  : ch.type === "omada_device"  ? `omada_device:${ch.device_name||ch.device_mac||"?"}`
                  : ch.type === "square_pos"    ? `square_pos:${ch.location_id||"?"}`
                  : ch.type === "script"        ? `script`
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
      // New incident. status defaults to 'investigating', impact to 'minor'.
      // We seed the update timeline with the initial detection message so the
      // public page always has at least one entry to show.
      const cause = checks.filter(c => !c.ok).map(c => c.detail).join(", ");
      const [ins] = await db.query(
        "INSERT INTO status_incidents (server_id, server_name, started_at, cause) VALUES (?,?,?,?)",
        [def.id, def.name, now, cause]
      );
      const detectionMsg = cause
        ? `Automated check failed: ${cause}`
        : `Automated check detected ${def.name} is not responding.`;
      await db.query(
        "INSERT INTO status_incident_updates (incident_id, status, message) VALUES (?,?,?)",
        [ins.insertId, "investigating", detectionMsg]
      );
    } else if (overall === "up" && open.length > 0) {
      // Auto-close open incident. If an operator hasn't manually moved the status
      // past "investigating" we still mark it resolved and append a recovery update.
      const dur = Math.round((now - new Date(open[0].started_at)) / 1000);
      await db.query(
        "UPDATE status_incidents SET ended_at=?, duration_s=?, status='resolved' WHERE id=?",
        [now, dur, open[0].id]
      );
      await db.query(
        "INSERT INTO status_incident_updates (incident_id, status, message) VALUES (?,?,?)",
        [open[0].id, "resolved", `Automated checks are passing again. Service restored after ${fmtDuration(dur)}.`]
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

  if (format === "teams") {
    // Microsoft Teams Incoming Webhook — legacy MessageCard format.
    // Works with the classic "Incoming Webhook" connector on any Teams channel.
    // For Adaptive Cards via Power Automate, use Generic JSON + build your own flow.
    const themeColor = evt.isTest ? "5865F2" : evt.isRecovery ? "10E88A" : (evt.status === "down" ? "FF3D5A" : "FF8C2A");
    const checkDetails = Array.isArray(evt.checks) && evt.checks.length
      ? evt.checks.filter(c => !c.ok || evt.isRecovery || evt.isTest).map(c => {
          const label = c.type === "ping" ? "PING" : c.type === "tcp" ? `TCP :${c.port}` : c.type === "udp" ? `UDP :${c.port}` : c.type.toUpperCase();
          return `${c.ok ? "✅" : "❌"} ${label}: ${c.detail}`;
        }).join("\n\n")
      : null;
    const facts = [
      { name: "Service",  value: evt.server },
      { name: "Status",   value: `${statusEmoji} ${statusLabel}` },
      { name: "Target",   value: evt.host },
      { name: "Time",     value: displayTime }
    ];
    if (checkDetails || evt.cause) {
      facts.push({ name: "Alert Details", value: checkDetails || evt.cause });
    }
    const card = {
      "@type":       "MessageCard",
      "@context":    "http://schema.org/extensions",
      themeColor,
      summary:       `${statusEmoji} ${evt.server} ${verb}`,
      sections: [{
        activityTitle:    `${emoji} Service ${verb}`,
        activitySubtitle: evt.webhookName ? `Applegate Monitor · ${evt.webhookName}` : "Applegate Monitor",
        facts,
        markdown: true
      }]
    };
    if (evt.dashboardUrl) {
      card.potentialAction = [{
        "@type": "OpenUri",
        name:    "View Dashboard",
        targets: [{ os: "default", uri: evt.dashboardUrl }]
      }];
    }
    return card;
  }

  if (format === "telegram") {
    // Telegram Bot API — sendMessage endpoint.
    // Store the webhook URL as:
    //   https://api.telegram.org/bot{TOKEN}/sendMessage?chat_id={CHAT_ID}
    // The chat_id is extracted from the query string and included in the body.
    let chatId = "";
    try { chatId = new URL(evt.hookUrl || "").searchParams.get("chat_id") || ""; } catch(_) {}
    const checkDetails = Array.isArray(evt.checks) && evt.checks.length
      ? evt.checks.filter(c => !c.ok || evt.isRecovery || evt.isTest).map(c => {
          const label = c.type === "ping" ? "PING" : c.type === "tcp" ? `TCP :${c.port}` : c.type === "udp" ? `UDP :${c.port}` : c.type.toUpperCase();
          return `${c.ok ? "✅" : "❌"} ${label}: ${c.detail}`;
        }).join("\n")
      : null;
    const lines = [
      `${emoji} <b>Service ${verb}</b>`,
      "",
      `<b>Service:</b> ${evt.server}`,
      `<b>Host:</b> ${evt.host}`,
      `<b>Status:</b> ${statusEmoji} ${statusLabel}`,
      `<b>Time:</b> ${displayTime}`
    ];
    if (checkDetails || evt.cause) {
      lines.push("", `⚠️ <b>Alert Details</b>`, `<pre>${checkDetails || evt.cause}</pre>`);
    }
    if (evt.dashboardUrl) {
      lines.push("", `📊 <a href="${evt.dashboardUrl}">View Dashboard</a>`);
    }
    if (evt.webhookName) lines.push(`\n<i>— ${evt.webhookName}</i>`);
    return {
      chat_id:                  chatId,
      text:                     lines.join("\n"),
      parse_mode:               "HTML",
      disable_web_page_preview: true
    };
  }

  if (format === "pushover") {
    // Pushover — https://pushover.net/api
    // Store the webhook URL as:
    //   https://api.pushover.net/1/messages.json?token={APP_TOKEN}&user={USER_KEY}
    // token and user are extracted from query params and included in the POST body.
    let pushToken = "", pushUser = "";
    try {
      const u = new URL(evt.hookUrl || "");
      pushToken = u.searchParams.get("token") || "";
      pushUser  = u.searchParams.get("user")  || "";
    } catch(_) {}
    const checkDetails = Array.isArray(evt.checks) && evt.checks.length
      ? evt.checks.filter(c => !c.ok || evt.isRecovery || evt.isTest).map(c => {
          const label = c.type === "ping" ? "PING" : c.type === "tcp" ? `TCP :${c.port}` : c.type === "udp" ? `UDP :${c.port}` : c.type.toUpperCase();
          return `${c.ok ? "✅" : "❌"} ${label}: ${c.detail}`;
        }).join("\n")
      : null;
    // Priority: high (1) for down, normal (0) for degraded/test, low (-1) for recovery
    const priority = evt.isRecovery ? -1 : (evt.status === "down" && !evt.isTest) ? 1 : 0;
    const msgLines = [
      `<b>Host:</b> ${evt.host}`,
      `<b>Status:</b> ${statusEmoji} ${statusLabel}`,
      `<b>Time:</b> ${displayTime}`
    ];
    if (checkDetails || evt.cause) {
      msgLines.push(`\n⚠️ <b>Alert Details</b>\n${checkDetails || evt.cause}`);
    }
    const payload = {
      token:    pushToken,
      user:     pushUser,
      title:    `${emoji} ${evt.server} ${verb}`,
      message:  msgLines.join("\n"),
      priority,
      html:     1
    };
    if (evt.dashboardUrl) {
      payload.url       = evt.dashboardUrl;
      payload.url_title = "View Dashboard";
    }
    return payload;
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
  if (/webhook\.office\.com|outlook\.office\.com\/webhook/i.test(url)) return "teams";
  if (/api\.telegram\.org\/bot/i.test(url)) return "telegram";
  if (/api\.pushover\.net/i.test(url)) return "pushover";
  return "generic";
}

async function postWebhook(url, body) {
  // Validate and reconstruct from parsed components — breaks taint chain (SSRF hardening)
  let safeUrl;
  try { safeUrl = sanitizeRequestUrl(url); } catch(e) { throw new Error("Invalid webhook URL"); }
  const r = await fetch(safeUrl, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent":   "applegate-monitor-webhook/1.0"
    },
    body:   JSON.stringify(body),
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status}${text ? ": " + text.slice(0, 200) : ""}`);
  }
  return { status: r.status };
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

// -- Weekly uptime report build/send -----------------------------------------
// Aggregates the last 7 days of status_history + status_incidents into a summary
// email. Called by the hourly scheduler (auto) and by the admin "Send Now" route.
async function buildWeeklyReport() {
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Per-server uptime + avg/p95 response time
  const [upRows] = await db.query(
    `SELECT server_id,
            COUNT(*) AS total,
            SUM(ok)  AS ok_count,
            AVG(response_ms) AS avg_ms
     FROM status_history
     WHERE checked_at >= ? AND checked_at <= ?
     GROUP BY server_id`,
    [periodStart, periodEnd]
  );

  // Per-server incident summary
  const [incRows] = await db.query(
    `SELECT server_id,
            COUNT(*) AS incidents,
            MAX(COALESCE(duration_s, TIMESTAMPDIFF(SECOND, started_at, NOW()))) AS longest_s
     FROM status_incidents
     WHERE started_at >= ? AND started_at <= ?
     GROUP BY server_id`,
    [periodStart, periodEnd]
  );

  const incById = {};
  for (const r of incRows) incById[r.server_id] = r;

  const servers = serverConfig.map(s => {
    const u = upRows.find(r => r.server_id === s.id);
    const i = incById[s.id];
    const total = u ? Number(u.total) : 0;
    const okC   = u ? Number(u.ok_count) : 0;
    const uptime = total > 0 ? (okC / total) * 100 : null;
    return {
      id:        s.id,
      name:      s.name,
      host:      s.host,
      total,
      uptime,
      avgMs:     u && u.avg_ms != null ? Math.round(Number(u.avg_ms)) : null,
      incidents: i ? Number(i.incidents) : 0,
      longestS:  i ? Number(i.longest_s || 0) : 0
    };
  });

  // Overall metrics
  const totalChecks   = servers.reduce((a, s) => a + s.total, 0);
  const totalIncidents = servers.reduce((a, s) => a + s.incidents, 0);
  const weightedUp = servers.reduce((a, s) => s.total > 0 ? a + (s.uptime * s.total) : a, 0);
  const overallUptime = totalChecks > 0 ? (weightedUp / totalChecks) : null;

  const worst = [...servers]
    .filter(s => s.uptime != null)
    .sort((a, b) => a.uptime - b.uptime)
    .slice(0, 5);
  const slowest = [...servers]
    .filter(s => s.avgMs != null)
    .sort((a, b) => b.avgMs - a.avgMs)
    .slice(0, 5);

  return { periodStart, periodEnd, servers, totalChecks, totalIncidents, overallUptime, worst, slowest };
}

function fmtReportDuration(s) {
  if (!s || s < 60) return `${Math.round(s || 0)}s`;
  if (s < 3600) return `${Math.floor(s/60)}m ${Math.round(s%60)}s`;
  if (s < 86400) return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
  return `${Math.floor(s/86400)}d ${Math.floor((s%86400)/3600)}h`;
}

function renderWeeklyReportHtml(rep) {
  const fmtPct = v => v == null ? "—" : `${v.toFixed(2)}%`;
  const periodLabel = `${rep.periodStart.toISOString().slice(0,10)} → ${rep.periodEnd.toISOString().slice(0,10)}`;
  const upColor = v => v == null ? "#8b949e" : (v >= 99.9 ? "#10e88a" : (v >= 99 ? "#f5a623" : "#ef3d5a"));

  const worstRows = rep.worst.length ? rep.worst.map(s => `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #21262d">${escAttrServer(s.name)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #21262d;color:${upColor(s.uptime)};font-weight:600">${fmtPct(s.uptime)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #21262d;text-align:right">${s.incidents}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #21262d;text-align:right">${fmtReportDuration(s.longestS)}</td>
    </tr>`).join("") : `<tr><td colspan="4" style="padding:12px;color:#8b949e;text-align:center">No data for this period.</td></tr>`;

  const slowRows = rep.slowest.length ? rep.slowest.map(s => `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #21262d">${escAttrServer(s.name)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #21262d;text-align:right">${s.avgMs} ms</td>
      <td style="padding:8px 10px;border-bottom:1px solid #21262d;color:${upColor(s.uptime)};text-align:right">${fmtPct(s.uptime)}</td>
    </tr>`).join("") : `<tr><td colspan="3" style="padding:12px;color:#8b949e;text-align:center">No response data for this period.</td></tr>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
  <body style="margin:0;background:#f4f7fb;font-family:-apple-system,Segoe UI,sans-serif;color:#c9d1d9">
    <div style="max-width:640px;margin:0 auto;padding:24px">
      <div style="background:#0d1117;border:1px solid #21262d;border-radius:12px;overflow:hidden">
        <div style="padding:24px;background:linear-gradient(135deg,#10e88a22,#0d1117)">
          <div style="font-size:12px;color:#8b949e;letter-spacing:.05em;text-transform:uppercase">Weekly Uptime Report</div>
          <div style="font-size:22px;font-weight:700;color:#f0f6fc;margin-top:4px">${periodLabel}</div>
        </div>
        <div style="padding:20px 24px;display:flex;gap:16px;flex-wrap:wrap;border-bottom:1px solid #21262d">
          <div style="flex:1;min-width:140px">
            <div style="font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.05em">Overall Uptime</div>
            <div style="font-size:26px;font-weight:700;color:${upColor(rep.overallUptime)};margin-top:2px">${fmtPct(rep.overallUptime)}</div>
          </div>
          <div style="flex:1;min-width:140px">
            <div style="font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.05em">Incidents</div>
            <div style="font-size:26px;font-weight:700;color:#f0f6fc;margin-top:2px">${rep.totalIncidents}</div>
          </div>
          <div style="flex:1;min-width:140px">
            <div style="font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.05em">Checks Run</div>
            <div style="font-size:26px;font-weight:700;color:#f0f6fc;margin-top:2px">${rep.totalChecks.toLocaleString()}</div>
          </div>
        </div>

        <div style="padding:20px 24px">
          <div style="font-size:14px;font-weight:600;color:#f0f6fc;margin-bottom:10px">Lowest Uptime</div>
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead>
              <tr style="color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.05em">
                <th style="text-align:left;padding:6px 10px;border-bottom:1px solid #21262d">Server</th>
                <th style="text-align:left;padding:6px 10px;border-bottom:1px solid #21262d">Uptime</th>
                <th style="text-align:right;padding:6px 10px;border-bottom:1px solid #21262d">Incidents</th>
                <th style="text-align:right;padding:6px 10px;border-bottom:1px solid #21262d">Longest Outage</th>
              </tr>
            </thead>
            <tbody>${worstRows}</tbody>
          </table>
        </div>

        <div style="padding:0 24px 20px">
          <div style="font-size:14px;font-weight:600;color:#f0f6fc;margin-bottom:10px">Slowest Services (avg response)</div>
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead>
              <tr style="color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.05em">
                <th style="text-align:left;padding:6px 10px;border-bottom:1px solid #21262d">Server</th>
                <th style="text-align:right;padding:6px 10px;border-bottom:1px solid #21262d">Avg Response</th>
                <th style="text-align:right;padding:6px 10px;border-bottom:1px solid #21262d">Uptime</th>
              </tr>
            </thead>
            <tbody>${slowRows}</tbody>
          </table>
        </div>

        ${EXTERNAL_URL ? `<div style="padding:16px 24px;border-top:1px solid #21262d;background:#010409"><a href="${EXTERNAL_URL}" style="color:#10e88a;text-decoration:none;font-size:13px">Open the dashboard →</a></div>` : ""}
      </div>
      <div style="text-align:center;color:#8b949e;font-size:11px;margin-top:16px">Sent by Applegate Monitor · Manage in Admin → Settings → Weekly Report</div>
    </div>
  </body></html>`;
}

function renderWeeklyReportText(rep) {
  const fmtPct = v => v == null ? "—" : `${v.toFixed(2)}%`;
  const periodLabel = `${rep.periodStart.toISOString().slice(0,10)} to ${rep.periodEnd.toISOString().slice(0,10)}`;
  const lines = [
    `Weekly Uptime Report — ${periodLabel}`,
    ``,
    `Overall uptime: ${fmtPct(rep.overallUptime)}`,
    `Incidents: ${rep.totalIncidents}`,
    `Checks run: ${rep.totalChecks.toLocaleString()}`,
    ``,
    `Lowest uptime:`
  ];
  if (rep.worst.length) {
    for (const s of rep.worst) lines.push(`  - ${s.name}: ${fmtPct(s.uptime)} · ${s.incidents} incidents · longest ${fmtReportDuration(s.longestS)}`);
  } else {
    lines.push(`  (no data)`);
  }
  lines.push(``, `Slowest services:`);
  if (rep.slowest.length) {
    for (const s of rep.slowest) lines.push(`  - ${s.name}: ${s.avgMs} ms · ${fmtPct(s.uptime)}`);
  } else {
    lines.push(`  (no response data)`);
  }
  return lines.join("\n");
}

// Minimal HTML-safe escape for server names inside report markup.
function escAttrServer(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function sendWeeklyReport(overrideRecipients) {
  if (!smtpTransport) throw new Error("SMTP not configured");
  const recipients = (overrideRecipients && overrideRecipients.length)
    ? overrideRecipients
    : weeklyReportConfig.recipients;
  if (!recipients.length) throw new Error("No recipients configured");
  const rep = await buildWeeklyReport();
  const html = renderWeeklyReportHtml(rep);
  const text = renderWeeklyReportText(rep);
  const subject = `Weekly Uptime Report — ${rep.periodStart.toISOString().slice(0,10)} → ${rep.periodEnd.toISOString().slice(0,10)}`;
  await smtpTransport.sendMail({
    from: smtpConfig.from || smtpConfig.user || "monitor@example.com",
    to: recipients.join(", "),
    subject, text, html
  });
  return { recipients: recipients.length, overallUptime: rep.overallUptime, incidents: rep.totalIncidents };
}

// Fires Monday ≥09:00 UTC, at most once per ISO week.
async function maybeSendScheduledWeeklyReport() {
  if (!weeklyReportConfig.enabled) return;
  if (!smtpTransport) return;
  if (!weeklyReportConfig.recipients.length) return;
  const now = new Date();
  if (now.getUTCDay() !== 1) return;           // Monday only
  if (now.getUTCHours() < 9) return;           // After 09:00 UTC
  // Anchor: Monday 00:00 UTC of this week
  const weekAnchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (weeklyReportConfig.lastSentAt) {
    const last = new Date(weeklyReportConfig.lastSentAt);
    if (!isNaN(last.getTime()) && last >= weekAnchor) return; // already sent this week
  }
  try {
    await sendWeeklyReport();
    const ts = new Date().toISOString();
    await db.query(
      "INSERT INTO status_settings (key_name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
      ["weekly_report_last_sent_at", ts]
    );
    weeklyReportConfig.lastSentAt = ts;
    addLog({ level:"info", server:"system", message:`Weekly report sent to ${weeklyReportConfig.recipients.length} recipient(s)` });
  } catch(e) {
    addLog({ level:"error", server:"system", message:`Weekly report failed: ${e.message}` });
  }
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
    const body = buildWebhookPayload(fmt, { ...evt, dashboardUrl: hookDashboardUrl, webhookName: h.name, hookUrl: h.url });
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

async function fireSubscriberEmails(evt) {
  if (!smtpTransport) return; // SMTP not configured — silently skip
  if (!Array.isArray(evt.serverGroupIds) || !evt.serverGroupIds.length) return;
  try {
    const field = evt.isRecovery ? "notify_recovery" : "notify_down";
    const [subs] = await db.query(
      `SELECT s.email, s.unsubscribe_token, g.name AS group_name, g.slug
       FROM status_email_subscriptions s
       JOIN status_groups g ON g.id = s.group_id
       WHERE s.group_id IN (?) AND s.${field} = 1`,
      [evt.serverGroupIds]
    );
    if (!subs.length) return;
    const emoji  = evt.isRecovery ? "\u2705" : "\uD83D\uDD34";
    const verb   = evt.isRecovery ? "recovered" : "is down";
    const subject = `${emoji} ${evt.server} ${verb}`;
    for (const sub of subs) {
      const unsubUrl = EXTERNAL_URL
        ? `${EXTERNAL_URL}/api/public/unsubscribe?token=${sub.unsubscribe_token}`
        : `/api/public/unsubscribe?token=${sub.unsubscribe_token}`;
      const dashUrl = EXTERNAL_URL ? `${EXTERNAL_URL}/dashboard/${sub.slug}` : `/dashboard/${sub.slug}`;
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;background:#f4f7fb;padding:20px">
        <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #dce6f0;overflow:hidden">
          <div style="background:${evt.isRecovery?"#10b87a":"#ef3d5a"};padding:18px 24px">
            <h2 style="margin:0;color:#fff;font-size:18px">${emoji} ${evt.server} ${verb}</h2>
          </div>
          <div style="padding:20px 24px">
            <p style="margin:0 0 12px;color:#5a6a7e">A status change was detected on <strong>${sub.group_name}</strong>.</p>
            <table style="width:100%;border-collapse:collapse;font-size:13px;color:#2d3a4a">
              <tr><td style="padding:6px 0;color:#8fa0b5;width:100px">Service</td><td>${evt.server}</td></tr>
              <tr><td style="padding:6px 0;color:#8fa0b5">Host</td><td>${evt.host || "\u2014"}</td></tr>
              <tr><td style="padding:6px 0;color:#8fa0b5">Status</td><td><strong>${evt.isRecovery?"UP":"DOWN"}</strong></td></tr>
              <tr><td style="padding:6px 0;color:#8fa0b5">Time</td><td>${new Date(evt.time).toLocaleString()}</td></tr>
              ${evt.cause ? `<tr><td style="padding:6px 0;color:#8fa0b5">Detail</td><td>${evt.cause}</td></tr>` : ""}
            </table>
            <div style="margin-top:20px">
              <a href="${dashUrl}" style="display:inline-block;padding:10px 20px;background:#2a7fff;color:#fff;text-decoration:none;border-radius:6px;font-size:13px;font-weight:600">View Dashboard</a>
            </div>
          </div>
          <div style="padding:16px 24px;background:#f4f7fb;border-top:1px solid #dce6f0;text-align:center">
            <a href="${unsubUrl}" style="display:inline-block;padding:8px 18px;background:#fff;border:1px solid #d0d9e5;border-radius:6px;color:#5a6a7e;text-decoration:none;font-size:12px;font-weight:500">🔕 Unsubscribe from alerts</a>
            <div style="margin-top:8px;font-size:11px;color:#b0bec8">You subscribed to alerts for <strong>${sub.group_name}</strong>.</div>
          </div>
        </div>
      </body></html>`;
      try {
        await sendEmailAlert(sub.email, { subject, text: `${evt.server} ${verb}. View dashboard: ${dashUrl}`, html });
        addLog({ level:"info", server:"subscriptions", message:`Alert email sent to ${sub.email} for ${evt.server}` });
      } catch(e) {
        addLog({ level:"warn", server:"subscriptions", message:`Failed to email ${sub.email}: ${e.message}` });
      }
    }
  } catch(e) {
    addLog({ level:"error", server:"subscriptions", message:`fireSubscriberEmails error: ${e.message}` });
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
    const checks     = await runChecks(def);
    const rawOverall = checks.every(c=>c.ok) ? "up" : checks.some(c=>c.ok) ? "degraded" : "down";
    const prev       = serverStatus[def.id] || {};
    const history    = [...(prev.uptimeHistory||[]), rawOverall==="up"].slice(-20);

    // Sticky status: suppress transitions to down/degraded until rawOverall has
    // stayed non-up for `failure_threshold` consecutive polls. Recovery is immediate.
    const threshold = Math.max(1, def.failure_threshold || 1);
    const failStreak = rawOverall === "up" ? 0 : (prev.failStreak || 0) + 1;
    let overall;
    if (rawOverall === "up") {
      overall = "up";
    } else if (failStreak >= threshold) {
      overall = rawOverall;
    } else {
      // Still within grace period — keep the last committed status (or "up" if first-ever).
      overall = (prev.overall && prev.overall !== "pending") ? prev.overall : "up";
    }

    checks.forEach(c => {
      const label =
        c.type === "ping"          ? "PING" :
        c.type === "tcp"           ? `TCP :${c.port}` :
        c.type === "udp"           ? `UDP :${c.port}` :
        c.type === "http"          ? "HTTP" :
        c.type === "dns"           ? `DNS ${(c.record_type||"A").toUpperCase()}` :
        c.type === "omada_gateway" ? "OMADA-GW" :
        c.type === "omada_device"  ? `OMADA-DEV:${c.device_name||c.device_mac||"?"}` :
        c.type.toUpperCase();
      addLog({ level:c.ok?"info":"error", server:def.name, serverId:def.id, check:label, message:`${label} - ${c.detail}`, ok:c.ok, detail:c.detail });
    });

    const inMaintenance = isUnderMaintenance(def.id);

    if (prev.overall && prev.overall!=="pending" && prev.overall!==overall) {
      addLog({ level:overall==="up"?"info":"error", server:def.name, serverId:def.id, check:"STATUS", message:`Status changed: ${prev.overall.toUpperCase()} -> ${overall.toUpperCase()}${inMaintenance ? " (under maintenance — alerts suppressed)" : ""}`, ok:overall==="up", isStatusChange:true });

      const isRecovery = overall === "up";
      const isDownward = overall === "down" || overall === "degraded";
      const isSquare   = (def.checks || []).some(c => c.type === "square_pos");

      if (inMaintenance) {
        // Server is in a planned maintenance window — skip all webhook/email alerts.
        // The status change is still logged above and still appears in SSE/dashboard;
        // we just don't page anyone about it.
      } else if (isDownward) {
        if (isSquare) {
          // Square POS: hold alert for 5 min — cancel if it recovers first
          if (pendingDownAlerts.has(def.id)) {
            clearTimeout(pendingDownAlerts.get(def.id).timer);
            pendingDownAlerts.delete(def.id);
          }
          const evt = {
            server:         def.name,
            host:           def.host,
            status:         overall,
            previous:       prev.overall,
            cause:          checks.filter(c => !c.ok).map(c => c.detail).join(", ") || null,
            checks:         checks.map(c => ({ type:c.type, port:c.port, ok:c.ok, detail:c.detail, response_ms:c.response_ms })),
            time:           now,
            isRecovery:     false,
            serverGroupIds: def.group_ids || []
          };
          const timer = setTimeout(() => {
            pendingDownAlerts.delete(def.id);
            sentDownAlerts.add(def.id);
            fireWebhooks(evt).catch(() => {});
            fireSubscriberEmails(evt).catch(() => {});
            addLog({ level:"error", server:def.name, serverId:def.id, check:"ALERT", message:`Alert fired — Square POS down for 5+ minutes`, ok:false });
          }, 5 * 60 * 1000);
          pendingDownAlerts.set(def.id, { timer, evt });
          addLog({ level:"warn", server:def.name, serverId:def.id, check:"ALERT", message:`Square POS DOWN — holding alert for 5-minute confirmation window`, ok:false });
        } else {
          // All other check types: alert immediately as normal
          const _alertEvtDown = {
            server:         def.name,
            host:           def.host,
            status:         overall,
            previous:       prev.overall,
            cause:          checks.filter(c => !c.ok).map(c => c.detail).join(", ") || null,
            checks:         checks.map(c => ({ type:c.type, port:c.port, ok:c.ok, detail:c.detail, response_ms:c.response_ms })),
            time:           now,
            isRecovery:     false,
            serverGroupIds: def.group_ids || []
          };
          fireWebhooks(_alertEvtDown).catch(() => {});
          fireSubscriberEmails(_alertEvtDown).catch(() => {});
        }
      }

      if (isRecovery && !inMaintenance) {
        if (isSquare && pendingDownAlerts.has(def.id)) {
          // Square recovered before 5-min window — suppress the alert entirely
          clearTimeout(pendingDownAlerts.get(def.id).timer);
          pendingDownAlerts.delete(def.id);
          addLog({ level:"info", server:def.name, serverId:def.id, check:"ALERT", message:`Square POS recovered within 5-minute window — alert suppressed`, ok:true });
        } else if (isSquare && sentDownAlerts.has(def.id)) {
          // Square was genuinely down (alert was sent) — send recovery
          sentDownAlerts.delete(def.id);
          const _alertEvtSqRec = {
            server:         def.name,
            host:           def.host,
            status:         overall,
            previous:       prev.overall,
            cause:          null,
            checks:         checks.map(c => ({ type:c.type, port:c.port, ok:c.ok, detail:c.detail, response_ms:c.response_ms })),
            time:           now,
            isRecovery:     true,
            serverGroupIds: def.group_ids || []
          };
          fireWebhooks(_alertEvtSqRec).catch(() => {});
          fireSubscriberEmails(_alertEvtSqRec).catch(() => {});
        } else if (!isSquare) {
          // Non-Square recovery: alert immediately as normal
          const _alertEvtRec = {
            server:         def.name,
            host:           def.host,
            status:         overall,
            previous:       prev.overall,
            cause:          null,
            checks:         checks.map(c => ({ type:c.type, port:c.port, ok:c.ok, detail:c.detail, response_ms:c.response_ms })),
            time:           now,
            isRecovery:     true,
            serverGroupIds: def.group_ids || []
          };
          fireWebhooks(_alertEvtRec).catch(() => {});
          fireSubscriberEmails(_alertEvtRec).catch(() => {});
        }
      }
    }

    serverStatus[def.id] = { id:def.id, name:def.name, host:def.host, description:def.description||"", category:def.category||"", sub_category:def.sub_category||"", runbook:def.runbook||"", group_ids:def.group_ids||[], tags:def.tags||[], checks, overall, lastChecked:now, uptimeHistory:history, failStreak, lat:def.lat||null, lng:def.lng||null, maintenance:inMaintenance };
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
  lastPollAt = Date.now();
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

// Google OAuth — redirect to Google consent screen
app.get("/auth/google", (req, res) => {
  if (!googleOAuth) return res.redirect("/login");
  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;
  // Save session to DB before redirecting — without this the state won't be
  // present when Google returns to the callback (async session write race).
  req.session.save(err => {
    if (err) return res.redirect("/login?error=google_failed");
    const url = googleOAuth.generateAuthUrl({
      access_type: "offline",
      scope: ["openid", "email", "profile"],
      state,
      prompt: "select_account"
    });
    res.redirect(url);
  });
});

// Google OAuth — callback after Google consent
app.get("/auth/google/callback", loginLimiter, async (req, res) => {
  if (!googleOAuth) return res.redirect("/login");
  const { code, state, error } = req.query;
  if (error) return res.redirect("/login?error=google_denied");
  if (!state || state !== req.session.oauthState) return res.redirect("/login?error=state_mismatch");
  delete req.session.oauthState;
  try {
    const { tokens } = await googleOAuth.getToken(String(code));
    const ticket = await googleOAuth.verifyIdToken({ idToken: tokens.id_token, audience: googleOAuthConfig.client_id });
    const payload   = ticket.getPayload();
    const googleId  = payload.sub;
    const email     = payload.email     || null;
    const firstName = payload.given_name  || null;
    const lastName  = payload.family_name || null;

    // 1. Existing account with this Google ID
    let [rows] = await db.query("SELECT * FROM status_users WHERE google_id=?", [googleId]);

    // 2. Link by matching email
    if (!rows.length && email) {
      [rows] = await db.query("SELECT * FROM status_users WHERE email=?", [email]);
      if (rows.length) {
        await db.query(
          "UPDATE status_users SET google_id=?, first_name=COALESCE(NULLIF(first_name,''),?), last_name=COALESCE(NULLIF(last_name,''),?) WHERE id=?",
          [googleId, firstName, lastName, rows[0].id]
        );
      }
    }

    let user;
    if (rows.length) {
      user = rows[0];
    } else {
      // 3. Auto-create as viewer
      let base = (email || "user").split("@")[0].toLowerCase().replace(/[^a-z0-9._-]/g, "") || "user";
      let username = base, suffix = 1;
      while ((await db.query("SELECT id FROM status_users WHERE username=?", [username]))[0].length) {
        username = `${base}${++suffix}`;
      }
      const [result] = await db.query(
        "INSERT INTO status_users (username, password_hash, role, google_id, first_name, last_name, email) VALUES (?,?,?,?,?,?,?)",
        [username, null, "viewer", googleId, firstName, lastName, email]
      );
      [rows] = await db.query("SELECT * FROM status_users WHERE id=?", [result.insertId]);
      user = rows[0];
      addLog({ level:"info", server:"auth", message:`Google OAuth: auto-created user ${username}` });
      addAuditLog({ userId: user.id, username, action:"user.create", resourceType:"user", resourceId: user.id, resourceName: username, detail:"google-oauth auto-created", ip: req.ip });
    }

    req.session.userId   = user.id;
    req.session.username = user.username;
    req.session.role     = user.role;
    addLog({ level:"info", server:"auth", message:`Google OAuth login: ${user.username} (${user.role})` });
    addAuditLog({ userId: user.id, username: user.username, action:"login", detail:`google-oauth / ${user.role}`, ip: req.ip });
    const redirect = await computeLoginRedirect(user.id, user.role);
    res.redirect(redirect);
  } catch(e) {
    addLog({ level:"error", server:"auth", message:`Google OAuth error: ${e.message}` });
    res.redirect("/login?error=google_failed");
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

// Numeric semver comparison: returns true iff `latest` is strictly newer
// than `current`. Ignores any pre-release suffix on the core numbers (parseInt
// picks off the leading integer), and treats missing segments as 0 so that
// e.g. "3.3" is equal to "3.3.0". This is the minimum we need for "should the
// 'Update available' banner appear?" — a running dev build ahead of the last
// GitHub release should NOT trigger the banner (previous code compared with
// `!==`, which flagged any difference including downgrades).
function isNewerVersion(latest, current) {
  if (!latest || !current) return false;
  const a = String(latest).split(".").map(s => parseInt(s, 10) || 0);
  const b = String(current).split(".").map(s => parseInt(s, 10) || 0);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] || 0, bv = b[i] || 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false; // equal
}

app.get("/api/version", requireAdmin, async (req, res) => {
  const latest = await fetchLatestVersion();
  res.json({
    current: APP_VERSION,
    latest:  latest || APP_VERSION,
    update_available: isNewerVersion(latest, APP_VERSION),
    release_url: `https://github.com/${GITHUB_REPO}/releases/latest`
  });
});

app.get("/api/me", async (req, res) => {
  if (req.session && req.session.userId) {
    try {
      const [allowed, login_redirect, rows] = await Promise.all([
        getUserAllowedGroupIds(req.session.userId, req.session.role),
        computeLoginRedirect(req.session.userId, req.session.role),
        db.query("SELECT first_name, last_name, email FROM status_users WHERE id=?", [req.session.userId]).then(([r]) => r)
      ]);
      const profile = rows[0] || {};
      res.json({
        loggedIn:   true,
        username:   req.session.username,
        role:       req.session.role,
        first_name: profile.first_name || null,
        last_name:  profile.last_name  || null,
        email:      profile.email      || null,
        allowed_group_ids: allowed,
        login_redirect
      });
    } catch(e) {
      res.json({ loggedIn:true, username: req.session.username, role: req.session.role, allowed_group_ids: [], login_redirect: "/" });
    }
  } else {
    res.json({ loggedIn:false });
  }
});

// ── Pin servers (DB-backed for logged-in users) ───────────────────────────────
app.get("/api/pinned", requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT server_id FROM status_pinned_servers WHERE user_id=?",
      [req.session.userId]
    );
    res.json(rows.map(r => r.server_id));
  } catch(e) { res.status(500).json({ error: "Server error" }); }
});

app.post("/api/pinned/:serverId", requireAuth, async (req, res) => {
  try {
    const sid = req.params.serverId;
    const [existing] = await db.query(
      "SELECT 1 FROM status_pinned_servers WHERE user_id=? AND server_id=?",
      [req.session.userId, sid]
    );
    if (existing.length) {
      await db.query("DELETE FROM status_pinned_servers WHERE user_id=? AND server_id=?", [req.session.userId, sid]);
      res.json({ pinned: false });
    } else {
      await db.query("INSERT INTO status_pinned_servers (user_id, server_id) VALUES (?,?)", [req.session.userId, sid]);
      res.json({ pinned: true });
    }
  } catch(e) { res.status(500).json({ error: "Server error" }); }
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
  res._slug     = req.query.slug || null;  // group-slug dashboard context (may be null)
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
// Authenticated users and group-slug visitors get lat/lng (map feature).
// Anonymous visitors on the root page have lat/lng stripped to protect locations.
function filterServersForSseClient(res, all) {
  if (res._isAdmin) return all;                                              // admin → everything
  if (res._authed) {
    return all.filter(s => Array.isArray(s.group_ids) && s.group_ids.some(gid => res._allowed.has(gid)));
  }
  // Public / unauthenticated clients — only grouped servers, lat/lng + runbook stripped
  // (runbook may include internal ops info and is only for authenticated on-call viewers).
  const list = all.filter(s => Array.isArray(s.group_ids) && s.group_ids.length > 0);
  return list.map(({ lat, lng, runbook, ...rest }) => rest);
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
  const { name, host, description, category, sub_category, tags, checks, group_ids, poll_interval_sec, failure_threshold } = req.body;
  // Runbook is optional markdown; cap at 64KB to match the TEXT column limit.
  const runbook = String(req.body.runbook || "").slice(0, 65535);
  if (!name || !host) return res.status(400).json({ error:"name and host are required" });
  if (Array.isArray(checks)) {
    for (const c of checks) {
      if (c.type === "script") {
        if (req.session.role !== "admin") return res.status(403).json({ error:"Only admins can create script checks" });
        if (!c.command || /[|&;$`<>(){}!\\\n\r]/.test(c.command)) return res.status(400).json({ error:"Script command contains disallowed characters" });
      }
    }
  }
  const wantGroups = Array.isArray(group_ids) ? group_ids.map(g => parseInt(g)).filter(Number.isFinite) : [];
  const interval = Math.max(10, Math.min(3600, parseInt(poll_interval_sec) || 30));
  const threshold = Math.max(1, Math.min(10, parseInt(failure_threshold) || 1));
  const lat = req.body.lat != null && req.body.lat !== "" ? parseFloat(req.body.lat) : null;
  const lng = req.body.lng != null && req.body.lng !== "" ? parseFloat(req.body.lng) : null;
  // Viewers must put new servers into at least one of their allowed groups
  if (req.session.role !== "admin") {
    const allowed = await getUserAllowedGroupIds(req.session.userId, req.session.role);
    const v = validateViewerGroupIds(allowed, wantGroups);
    if (!v.ok) return res.status(v.msg.startsWith("Must assign") ? 400 : 403).json({ error: v.msg });
  }
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"") + "-" + Date.now();
  try {
    await db.query(
      "INSERT INTO status_servers (id, name, host, description, category, sub_category, tags, checks, poll_interval_sec, failure_threshold, lat, lng, location_address, runbook) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [id, name, host, description||"", (category||"").trim() || null, (sub_category||"").trim() || null, JSON.stringify(tags||[]), JSON.stringify(checks||[{type:"ping"}]), interval, threshold, lat, lng, req.body.location_address||null, runbook || null]
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
  const { name, host, description, category, sub_category, tags, checks, group_ids, poll_interval_sec, failure_threshold, location_address } = req.body;
  const runbook = String(req.body.runbook || "").slice(0, 65535);
  if (!name || !host) return res.status(400).json({ error:"name and host are required" });
  if (Array.isArray(checks)) {
    for (const c of checks) {
      if (c.type === "script") {
        if (req.session.role !== "admin") return res.status(403).json({ error:"Only admins can create script checks" });
        if (!c.command || /[|&;$`<>(){}!\\\n\r]/.test(c.command)) return res.status(400).json({ error:"Script command contains disallowed characters" });
      }
    }
  }
  const wantGroups = Array.isArray(group_ids) ? group_ids.map(g => parseInt(g)).filter(Number.isFinite) : [];
  const interval = Math.max(10, Math.min(3600, parseInt(poll_interval_sec) || 30));
  const threshold = Math.max(1, Math.min(10, parseInt(failure_threshold) || 1));
  const lat = req.body.lat != null && req.body.lat !== "" ? parseFloat(req.body.lat) : null;
  const lng = req.body.lng != null && req.body.lng !== "" ? parseFloat(req.body.lng) : null;
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
      // Strip groups the viewer doesn't own from their request — they're re-added
      // via preserved below, so the server stays in those groups automatically.
      const viewerGroups = wantGroups.filter(g => allowed.includes(g));
      // Preserve groups the viewer doesn't own (protected from accidental removal)
      const preserved = existingGroups.filter(g => !allowed.includes(g));
      // Merge: viewer-controlled set + preserved set (de-duplicated)
      const merged = new Set([...viewerGroups, ...preserved]);
      finalGroups = Array.from(merged);
      // The viewer must leave the server in AT LEAST ONE of their own groups
      // (otherwise they've effectively removed themselves from it — silent ownership loss)
      if (!finalGroups.some(g => allowed.includes(g))) {
        return res.status(400).json({ error:"Server must remain in at least one of your allowed groups" });
      }
    }
    const [result] = await db.query(
      "UPDATE status_servers SET name=?, host=?, description=?, category=?, sub_category=?, tags=?, checks=?, poll_interval_sec=?, failure_threshold=?, lat=?, lng=?, location_address=?, runbook=?, updated_at=NOW() WHERE id=?",
      [name, host, description||"", (category||"").trim() || null, (sub_category||"").trim() || null, JSON.stringify(tags||[]), JSON.stringify(checks||[]), interval, threshold, lat, lng, location_address||null, runbook || null, req.params.id]
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

app.get("/api/admin/settings/google-oauth", requireAdmin, async (req, res) => {
  res.json({
    enabled:       googleOAuthConfig.enabled,
    client_id:     googleOAuthConfig.client_id,
    client_secret: googleOAuthConfig.client_secret ? "********" : "",
    callback_url:  GOOGLE_CALLBACK_URL
  });
});

app.post("/api/admin/settings/google-oauth", requireAdmin, async (req, res) => {
  const { enabled, client_id, client_secret } = req.body;
  try {
    const newEnabled  = !!enabled;
    const newClientId = (client_id || "").trim();
    const finalSecret = (client_secret && client_secret !== "********") ? client_secret.trim() : googleOAuthConfig.client_secret;
    if (newEnabled && (!newClientId || !finalSecret)) {
      return res.status(400).json({ error: "Client ID and Client Secret are both required to enable Google OAuth" });
    }
    const settings = [
      ["google_oauth_enabled",       newEnabled ? "true" : "false"],
      ["google_oauth_client_id",     newClientId],
      ["google_oauth_client_secret", finalSecret || ""]
    ];
    for (const [k, v] of settings) {
      await db.query("INSERT INTO status_settings (key_name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)", [k, v]);
    }
    googleOAuthConfig = { enabled: newEnabled, client_id: newClientId, client_secret: finalSecret || "" };
    rebuildGoogleOAuthClient();
    addLog({ level:"info", server:"admin", message:`Google OAuth ${newEnabled ? "enabled" : "disabled"} by ${req.session.username}` });
    res.json({ ok: true, enabled: newEnabled });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Mapbox token — admin reads masked value, writes plain; only conditionally
// overwrites when the posted value is not the mask.
app.get("/api/admin/settings/mapbox", requireAdmin, async (req, res) => {
  res.json({ token: mapboxConfig.token ? "********" : "" });
});

app.post("/api/admin/settings/mapbox", requireAdmin, async (req, res) => {
  const { token } = req.body;
  try {
    const finalToken = (token && token !== "********") ? String(token).trim() : mapboxConfig.token;
    await db.query(
      "INSERT INTO status_settings (key_name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
      ["mapbox_token", finalToken || ""]
    );
    mapboxConfig = { token: finalToken || "" };
    addLog({ level:"info", server:"admin", message:`Mapbox token ${finalToken ? "updated" : "cleared"} by ${req.session.username}` });
    res.json({ ok: true, configured: !!mapboxConfig.token });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Authenticated-only token fetch for the map tile layer. Viewers + admins may
// read it; anonymous visitors on /dashboard/<slug> get 401 and fall back to OSM.
app.get("/api/mapbox-token", requireAuth, (req, res) => {
  res.json({ token: mapboxConfig.token || "" });
});

// -- Weekly uptime report settings + actions ---------------------------------
app.get("/api/admin/settings/weekly-report", requireAdmin, (req, res) => {
  res.json({
    enabled:    weeklyReportConfig.enabled,
    recipients: weeklyReportConfig.recipients.join(", "),
    lastSentAt: weeklyReportConfig.lastSentAt,
    smtpConfigured: !!smtpTransport
  });
});

app.post("/api/admin/settings/weekly-report", requireAdmin, async (req, res) => {
  const { enabled, recipients } = req.body;
  try {
    const newEnabled = !!enabled;
    const parsed = String(recipients || "")
      .split(/[\s,;]+/)
      .map(s => s.trim())
      .filter(Boolean);
    const invalid = parsed.filter(e => !isValidEmail(e));
    if (invalid.length) return res.status(400).json({ error: `Invalid email(s): ${invalid.join(", ")}` });
    if (newEnabled && !parsed.length) return res.status(400).json({ error: "At least one recipient is required to enable the weekly report" });
    const settings = [
      ["weekly_report_enabled",    newEnabled ? "true" : "false"],
      ["weekly_report_recipients", parsed.join(",")]
    ];
    for (const [k, v] of settings) {
      await db.query("INSERT INTO status_settings (key_name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)", [k, v]);
    }
    weeklyReportConfig.enabled    = newEnabled;
    weeklyReportConfig.recipients = parsed;
    addLog({ level:"info", server:"admin", message:`Weekly report ${newEnabled ? "enabled" : "disabled"} by ${req.session.username}` });
    res.json({ ok: true, enabled: newEnabled, recipients: parsed.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Manually trigger a send now — admin's own recipients or an ad-hoc "to" address.
app.post("/api/admin/settings/weekly-report/send", requireAdmin, async (req, res) => {
  if (!smtpTransport) return res.status(400).json({ error: "SMTP not configured — set it up first" });
  try {
    const ad = String(req.body && req.body.to || "").split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
    const invalid = ad.filter(e => !isValidEmail(e));
    if (invalid.length) return res.status(400).json({ error: `Invalid email(s): ${invalid.join(", ")}` });
    const result = await sendWeeklyReport(ad.length ? ad : null);
    addLog({ level:"info", server:"admin", message:`Weekly report sent manually by ${req.session.username} to ${result.recipients} recipient(s)` });
    res.json({ ok: true, ...result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Geocoding proxy — tries Nominatim first, falls back to Photon if no results.
// Admin-only; used by the server edit form to resolve an address to lat/lng.
app.get("/api/admin/geocode", requireAuth, async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "Missing query" });
  const headers = {
    "User-Agent": "status-server/1.0 (self-hosted monitoring; admin geocode)",
    "Accept-Language": "en"
  };
  try {
    // 1) Try Nominatim
    const nr = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=3&addressdetails=1&q=${encodeURIComponent(q)}`, { headers });
    if (nr.ok) {
      const nd = await nr.json();
      if (nd.length) return res.json(nd);
    }
    // 2) Fall back to Photon (different OSM dataset, better address coverage)
    const pr = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=3`, { headers });
    if (!pr.ok) return res.json([]);
    const pd = await pr.json();
    if (!pd.features || !pd.features.length) return res.json([]);
    // Normalize Photon features to Nominatim-style {lat, lon, display_name}
    const normalized = pd.features.map(f => {
      const p = f.properties || {};
      const [lon, lat] = f.geometry.coordinates;
      const parts = [
        p.housenumber && p.street ? `${p.housenumber} ${p.street}` : (p.street || p.name || ""),
        p.locality || p.city || p.town || p.village || "",
        p.state || "",
        p.postcode || "",
        p.country || ""
      ].filter(Boolean);
      return { lat: String(lat), lon: String(lon), display_name: parts.join(", ") };
    });
    res.json(normalized);
  } catch(e) {
    res.status(502).json({ error: e.message });
  }
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
  const [users] = await db.query("SELECT id, username, role, first_name, last_name, email, created_at FROM status_users ORDER BY created_at");
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
  const { username, password, role, allowed_group_ids, first_name, last_name, email } = req.body;
  if (!username || !password) return res.status(400).json({ error:"Username and password required" });
  if (!["admin","viewer"].includes(role)) return res.status(400).json({ error:"Role must be admin or viewer" });
  if (password.length < 8) return res.status(400).json({ error:"Password must be at least 8 characters" });
  if (email && !isValidEmail(email)) return res.status(400).json({ error:"Invalid email address" });
  try {
    const hash = await bcrypt.hash(password, 10);
    const [result] = await db.query(
      "INSERT INTO status_users (username, password_hash, role, first_name, last_name, email) VALUES (?,?,?,?,?,?)",
      [username, hash, role, first_name?.trim()||null, last_name?.trim()||null, email?.trim()||null]
    );
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
  const { username, role, password, allowed_group_ids, first_name, last_name, email } = req.body;
  if (!username) return res.status(400).json({ error:"Username required" });
  if (!["admin","viewer"].includes(role)) return res.status(400).json({ error:"Invalid role" });
  if (email && !isValidEmail(email)) return res.status(400).json({ error:"Invalid email address" });
  // Prevent removing admin role from yourself
  if (parseInt(req.params.id) === req.session.userId && role !== "admin") {
    return res.status(400).json({ error:"Cannot remove admin role from your own account" });
  }
  const fn = first_name?.trim()||null, ln = last_name?.trim()||null, em = email?.trim()||null;
  try {
    if (password) {
      if (password.length < 8) return res.status(400).json({ error:"Password must be at least 8 characters" });
      const hash = await bcrypt.hash(password, 10);
      await db.query("UPDATE status_users SET username=?, role=?, password_hash=?, first_name=?, last_name=?, email=? WHERE id=?", [username, role, hash, fn, ln, em, req.params.id]);
    } else {
      await db.query("UPDATE status_users SET username=?, role=?, first_name=?, last_name=?, email=? WHERE id=?", [username, role, fn, ln, em, req.params.id]);
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
  const isEmail = isValidEmail(url);
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
  const isEmail = isValidEmail(url);
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
  const public_enabled = req.body.public_enabled ? 1 : 0;
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
      "UPDATE status_groups SET slug=?, name=?, description=?, logo_text=?, logo_image=?, logo_size=?, accent_color=?, bg_color=?, default_theme=?, custom_domain=?, privacy_text=?, terms_text=?, public_enabled=? WHERE id=?",
      [finalSlug, name, description || "", logo_text || "", cleanLogo, cleanLogoSize, accent_color || "#2a7fff", cleanBg, cleanTheme, cleanDomain, privacy_text || null, terms_text || null, public_enabled, gid]
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

// List APs and switches for a site (excludes gateways)
app.get("/api/admin/omada-controllers/:id/sites/:siteId/devices", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const [rows] = await db.query("SELECT * FROM status_omada_controllers WHERE id=?", [id]);
    if (!rows.length) return res.status(404).json({ error: "Controller not found" });
    const groupMap = await omadaLoadGroupIds([id]);
    if (!(await userCanManageOmadaCtrl(req, groupMap[id] || []))) {
      return res.status(403).json({ error: "You don't have access to this controller" });
    }
    const { siteId } = req.params;
    const { customerId, siteName, customerName } = req.query;
    const devices = await omadaListDevices(rows[0], siteId, customerId||null, siteName||null, customerName||null);
    const isGateway = (d) => {
      const t = (d.type || d.deviceType || "").toString().toLowerCase();
      const m = (d.model || d.modelName || d.product || "").toString().toUpperCase();
      return t === "gateway" || t.includes("gateway") || t.includes("router") || /^ER\d/.test(m) || d.type === 0;
    };
    const subDevices = devices.filter(d => !isGateway(d)).map(d => ({
      mac:        d.mac,
      name:       d.name || d.deviceName || d.mac,
      model:      d.model || d.modelName || d.product || null,
      type:       d.type,
      deviceType: d.deviceType || null,
      status:     d.status,
      uptimeLong: d.uptimeLong || null,
      uptime:     d.uptime || null,
      clientNum:  d.clientNum ?? d.clients ?? d.numClient ?? d.numClients ?? null
    }));
    res.json(subDevices);
  } catch(e) {
    res.status(502).json({ error: e.message });
  }
});

// ── Square Accounts ───────────────────────────────────────────────────────────
// Helper: load group_ids array for a list of Square account ids from the map table.
async function loadGroupIdsForSquareAccounts(accountIds) {
  if (!accountIds.length) return {};
  const [rows] = await db.query(
    "SELECT account_id, group_id FROM status_square_account_groups WHERE account_id IN (?)",
    [accountIds]
  );
  const byId = {};
  for (const r of rows) (byId[r.account_id] ||= []).push(r.group_id);
  return byId;
}

// Permission model:
//   • Admins see every account.
//   • Viewers see accounts they created OR accounts mapped to a group they have access to.
app.get("/api/admin/square-accounts", requireAuth, async (req, res) => {
  try {
    const isAdmin = req.session.role === "admin";
    let rows;
    if (isAdmin) {
      [rows] = await db.query(
        "SELECT id, name, application_id, environment, created_by, created_at FROM status_square_accounts ORDER BY created_at"
      );
    } else {
      const allowed = await getUserAllowedGroupIds(req.session.userId, req.session.role);
      const params  = [req.session.userId];
      let sql = `SELECT DISTINCT sa.id, sa.name, sa.application_id, sa.environment, sa.created_by, sa.created_at
                 FROM status_square_accounts sa
                 LEFT JOIN status_square_account_groups sag ON sag.account_id = sa.id
                 WHERE sa.created_by = ?`;
      if (Array.isArray(allowed) && allowed.length) {
        sql += ` OR sag.group_id IN (?)`;
        params.push(allowed);
      }
      sql += ` ORDER BY sa.created_at`;
      [rows] = await db.query(sql, params);
    }
    const groupMap = await loadGroupIdsForSquareAccounts(rows.map(r => r.id));
    res.json(rows.map(r => ({ ...r, group_ids: groupMap[r.id] || [] })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Any authenticated user can create a Square account (stored under their userId).
// Viewers can only assign the account to groups they themselves have access to.
app.post("/api/admin/square-accounts", requireAuth, async (req, res) => {
  const { name, application_id, access_token, environment, group_ids } = req.body;
  if (!name || !access_token) return res.status(400).json({ error: "Name and access token are required" });
  const env = environment === "sandbox" ? "sandbox" : "production";
  try {
    const [result] = await db.query(
      "INSERT INTO status_square_accounts (name, application_id, access_token, environment, created_by) VALUES (?,?,?,?,?)",
      [name.trim(), (application_id||"").trim(), access_token.trim(), env, req.session.userId]
    );
    const newId = result.insertId;
    if (Array.isArray(group_ids) && group_ids.length) {
      // Scope viewer selections to their allowed groups
      let ids = group_ids.map(Number).filter(Boolean);
      if (req.session.role !== "admin") {
        const allowed = await getUserAllowedGroupIds(req.session.userId, req.session.role);
        ids = ids.filter(gid => (allowed || []).includes(gid));
      }
      if (ids.length) {
        await db.query(
          "INSERT IGNORE INTO status_square_account_groups (account_id, group_id) VALUES ?",
          [ids.map(gid => [newId, gid])]
        );
      }
    }
    addLog({ level:"info", server:"square", message:`Square account added: ${name} by ${req.session.username}` });
    res.json({ ok:true, id: newId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admins can edit any account. Viewers can edit accounts they created OR accounts mapped
// to any of their allowed groups (same visibility rule as the GET endpoint).
app.put("/api/admin/square-accounts/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const { name, application_id, access_token, environment, group_ids } = req.body;
  if (!name) return res.status(400).json({ error: "Name is required" });
  const env = environment === "sandbox" ? "sandbox" : "production";
  try {
    const [rows] = await db.query("SELECT access_token, created_by FROM status_square_accounts WHERE id=?", [id]);
    if (!rows.length) return res.status(404).json({ error: "Account not found" });
    // Viewer permission check
    if (req.session.role !== "admin") {
      const allowed = await getUserAllowedGroupIds(req.session.userId, req.session.role) || [];
      const [g] = await db.query("SELECT group_id FROM status_square_account_groups WHERE account_id=?", [id]);
      const accountGroupIds = g.map(r => r.group_id);
      const sharesGroup = accountGroupIds.some(gid => allowed.includes(gid));
      if (rows[0].created_by !== req.session.userId && !sharesGroup) {
        return res.status(403).json({ error: "You can only edit Square accounts in your allowed dashboards" });
      }
    }
    const finalToken = (access_token && access_token !== "••••••") ? access_token.trim() : rows[0].access_token;
    await db.query("UPDATE status_square_accounts SET name=?, application_id=?, access_token=?, environment=? WHERE id=?",
      [name.trim(), (application_id||"").trim(), finalToken, env, id]);
    // Replace group mapping if provided
    if (Array.isArray(group_ids)) {
      let ids = group_ids.map(Number).filter(Boolean);
      if (req.session.role !== "admin") {
        const allowed = await getUserAllowedGroupIds(req.session.userId, req.session.role);
        ids = ids.filter(gid => (allowed || []).includes(gid));
      }
      await db.query("DELETE FROM status_square_account_groups WHERE account_id=?", [id]);
      if (ids.length) {
        await db.query(
          "INSERT IGNORE INTO status_square_account_groups (account_id, group_id) VALUES ?",
          [ids.map(gid => [id, gid])]
        );
      }
    }
    addLog({ level:"info", server:"square", message:`Square account updated: ${name} by ${req.session.username}` });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admins can delete any account. Viewers can delete accounts they created OR in their groups.
app.delete("/api/admin/square-accounts/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const [rows] = await db.query("SELECT name, created_by FROM status_square_accounts WHERE id=?", [id]);
    if (!rows.length) return res.status(404).json({ error: "Account not found" });
    if (req.session.role !== "admin") {
      const allowed = await getUserAllowedGroupIds(req.session.userId, req.session.role) || [];
      const [g] = await db.query("SELECT group_id FROM status_square_account_groups WHERE account_id=?", [id]);
      const accountGroupIds = g.map(r => r.group_id);
      const sharesGroup = accountGroupIds.some(gid => allowed.includes(gid));
      if (rows[0].created_by !== req.session.userId && !sharesGroup) {
        return res.status(403).json({ error: "You can only delete Square accounts in your allowed dashboards" });
      }
    }
    await db.query("DELETE FROM status_square_accounts WHERE id=?", [id]);
    addLog({ level:"warn", server:"square", message:`Square account removed: ${rows[0].name} by ${req.session.username}` });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Maintenance Windows ────────────────────────────────────────────────────────
// Scheduled downtime that suppresses alerts. One window targets one server — to
// schedule across multiple servers, the POST endpoint accepts a server_ids array
// and creates one row per server.

// Helper: pull the list of server IDs the caller is allowed to touch.
// Admins see everything; viewers see servers in any of their granted dashboard groups.
async function allowedServerIdsFor(session) {
  if (session.role === "admin") {
    const [rows] = await db.query("SELECT id FROM status_servers");
    return rows.map(r => String(r.id));
  }
  const groupIds = await getUserAllowedGroupIds(session.userId, session.role) || [];
  if (!groupIds.length) return [];
  const [rows] = await db.query(
    "SELECT DISTINCT server_id FROM status_server_group_map WHERE group_id IN (?)",
    [groupIds]
  );
  return rows.map(r => String(r.server_id));
}

app.get("/api/admin/maintenance", requireAuth, async (req, res) => {
  try {
    const allowed = await allowedServerIdsFor(req.session);
    // Admins get everything; viewers get windows only for servers they can see
    let sql = `SELECT m.id, m.server_id, m.title, m.notes, m.start_time, m.end_time,
                      m.created_by, m.created_at, s.name AS server_name
               FROM status_maintenance_windows m
               LEFT JOIN status_servers s ON s.id = m.server_id`;
    const params = [];
    if (req.session.role !== "admin") {
      if (!allowed.length) return res.json([]);
      sql += ` WHERE m.server_id IN (?)`;
      params.push(allowed);
    }
    sql += ` ORDER BY m.start_time DESC`;
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/maintenance", requireAuth, async (req, res) => {
  const { server_ids, title, notes, start_time, end_time } = req.body;
  if (!Array.isArray(server_ids) || !server_ids.length) return res.status(400).json({ error: "At least one server is required" });
  if (!title || !String(title).trim())                    return res.status(400).json({ error: "Title is required" });
  if (!start_time || !end_time)                           return res.status(400).json({ error: "Start and end times are required" });
  const startMs = new Date(start_time).getTime();
  const endMs   = new Date(end_time).getTime();
  if (!isFinite(startMs) || !isFinite(endMs))             return res.status(400).json({ error: "Invalid date format" });
  if (endMs <= startMs)                                   return res.status(400).json({ error: "End time must be after start time" });
  try {
    // Filter server_ids to only ones the caller can schedule against
    const allowed = new Set(await allowedServerIdsFor(req.session));
    const targets = server_ids.map(String).filter(id => allowed.has(id));
    if (!targets.length) return res.status(403).json({ error: "No accessible servers in selection" });

    const rows = targets.map(sid => [
      sid, String(title).trim(), notes || null,
      new Date(start_time), new Date(end_time), req.session.userId
    ]);
    await db.query(
      "INSERT INTO status_maintenance_windows (server_id, title, notes, start_time, end_time, created_by) VALUES ?",
      [rows]
    );
    await refreshMaintenanceCache();
    addLog({ level:"info", server:"system", message:`Maintenance scheduled: "${title}" for ${targets.length} server(s) by ${req.session.username}` });
    res.json({ ok:true, created: targets.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/admin/maintenance/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const { title, notes, start_time, end_time } = req.body;
  if (!title || !start_time || !end_time) return res.status(400).json({ error: "Title, start and end are required" });
  const startMs = new Date(start_time).getTime();
  const endMs   = new Date(end_time).getTime();
  if (!isFinite(startMs) || !isFinite(endMs) || endMs <= startMs) return res.status(400).json({ error: "Invalid date range" });
  try {
    const [rows] = await db.query("SELECT server_id FROM status_maintenance_windows WHERE id=?", [id]);
    if (!rows.length) return res.status(404).json({ error: "Window not found" });
    if (req.session.role !== "admin") {
      const allowed = new Set(await allowedServerIdsFor(req.session));
      if (!allowed.has(String(rows[0].server_id))) return res.status(403).json({ error: "Not allowed" });
    }
    await db.query(
      "UPDATE status_maintenance_windows SET title=?, notes=?, start_time=?, end_time=? WHERE id=?",
      [String(title).trim(), notes || null, new Date(start_time), new Date(end_time), id]
    );
    await refreshMaintenanceCache();
    addLog({ level:"info", server:"system", message:`Maintenance window ${id} updated by ${req.session.username}` });
    res.json({ ok:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/admin/maintenance/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const [rows] = await db.query("SELECT server_id, title FROM status_maintenance_windows WHERE id=?", [id]);
    if (!rows.length) return res.status(404).json({ error: "Window not found" });
    if (req.session.role !== "admin") {
      const allowed = new Set(await allowedServerIdsFor(req.session));
      if (!allowed.has(String(rows[0].server_id))) return res.status(403).json({ error: "Not allowed" });
    }
    await db.query("DELETE FROM status_maintenance_windows WHERE id=?", [id]);
    await refreshMaintenanceCache();
    addLog({ level:"warn", server:"system", message:`Maintenance window "${rows[0].title}" cancelled by ${req.session.username}` });
    res.json({ ok:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update own profile (first name, last name, email) — all authenticated users
app.put("/api/profile", requireAuth, async (req, res) => {
  const { first_name, last_name, email } = req.body;
  if (email && !isValidEmail(email)) {
    return res.status(400).json({ error: "Invalid email address" });
  }
  try {
    await db.query(
      "UPDATE status_users SET first_name=?, last_name=?, email=? WHERE id=?",
      [first_name?.trim() || null, last_name?.trim() || null, email?.trim() || null, req.session.userId]
    );
    addAuditLog({ userId: req.session.userId, username: req.session.username, action:"profile.update", resourceType:"user", resourceId: req.session.userId, resourceName: req.session.username, ip: req.ip });
    res.json({ ok:true });
  } catch(err) {
    res.status(500).json({ error: err.message });
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

// Incidents for a server — returns recent incidents with their full update timeline.
app.get("/api/public/incidents/:id", allowGroupedOrAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT * FROM status_incidents
       WHERE server_id=?
       ORDER BY started_at DESC LIMIT 20`,
      [req.params.id]
    );
    // Attach updates to each incident in one query (avoids N+1)
    const ids = rows.map(r => r.id);
    let updatesByIncident = {};
    if (ids.length) {
      const [uRows] = await db.query(
        `SELECT id, incident_id, status, message, created_at
         FROM status_incident_updates WHERE incident_id IN (?)
         ORDER BY created_at ASC`,
        [ids]
      );
      for (const u of uRows) {
        (updatesByIncident[u.incident_id] = updatesByIncident[u.incident_id] || []).push(u);
      }
    }
    res.json(rows.map(r => ({ ...r, updates: updatesByIncident[r.id] || [] })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Public incident feed for a group dashboard. Returns incidents for every server
// in the group (filtered to public=1) with their update timelines. Used by the
// /dashboard/:slug/incidents page and can be polled by external integrations.
app.get("/api/public/group/:slug/incidents", async (req, res) => {
  try {
    const [groups] = await db.query("SELECT id FROM status_groups WHERE slug=?", [req.params.slug]);
    if (!groups.length) return res.status(404).json({ error: "Group not found" });
    const groupId = groups[0].id;
    const [serverRows] = await db.query(
      "SELECT server_id FROM status_server_group_map WHERE group_id=?",
      [groupId]
    );
    const serverIds = serverRows.map(r => r.server_id);
    if (!serverIds.length) return res.json({ open: [], recent: [] });

    const [rows] = await db.query(
      `SELECT * FROM status_incidents
       WHERE server_id IN (?) AND public=1
       ORDER BY started_at DESC LIMIT 60`,
      [serverIds]
    );
    const ids = rows.map(r => r.id);
    let updatesByIncident = {};
    if (ids.length) {
      const [uRows] = await db.query(
        `SELECT id, incident_id, status, message, created_at
         FROM status_incident_updates WHERE incident_id IN (?)
         ORDER BY created_at ASC`,
        [ids]
      );
      for (const u of uRows) {
        (updatesByIncident[u.incident_id] = updatesByIncident[u.incident_id] || []).push(u);
      }
    }
    const enriched = rows.map(r => ({ ...r, updates: updatesByIncident[r.id] || [] }));
    const open   = enriched.filter(r => !r.ended_at);
    const recent = enriched.filter(r =>  r.ended_at);
    res.json({ open, recent });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin incident management ───────────────────────────────────────────────
// List all incidents (open + recent) across every server the caller can see.
// Viewers are filtered by allowed_group_ids; admins see everything.
app.get("/api/admin/incidents", requireAuth, async (req, res) => {
  try {
    let sql = `SELECT i.* FROM status_incidents i`;
    const params = [];
    if (req.session.role !== "admin") {
      const allowed = await getUserAllowedGroupIds(req.session.userId, req.session.role) || [];
      if (!allowed.length) return res.json([]);
      sql += ` JOIN status_server_group_map m ON m.server_id = i.server_id
               WHERE m.group_id IN (?)`;
      params.push(allowed);
    }
    sql += ` GROUP BY i.id ORDER BY i.started_at DESC LIMIT 200`;
    const [rows] = await db.query(sql, params);
    const ids = rows.map(r => r.id);
    let updatesByIncident = {};
    if (ids.length) {
      const [uRows] = await db.query(
        `SELECT id, incident_id, status, message, created_at
         FROM status_incident_updates WHERE incident_id IN (?)
         ORDER BY created_at ASC`,
        [ids]
      );
      for (const u of uRows) {
        (updatesByIncident[u.incident_id] = updatesByIncident[u.incident_id] || []).push(u);
      }
    }
    res.json(rows.map(r => ({ ...r, updates: updatesByIncident[r.id] || [] })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Edit incident metadata — title, impact, public flag. status is driven by
// the update timeline (see POST .../updates below).
app.put("/api/admin/incidents/:id", requireAdmin, async (req, res) => {
  try {
    const { title, impact, public: isPublic } = req.body;
    const fields = [];
    const params = [];
    if (title !== undefined)   { fields.push("title=?");  params.push(String(title).slice(0,200) || null); }
    if (impact !== undefined)  {
      if (!["minor","major","critical"].includes(impact)) return res.status(400).json({ error:"impact must be minor|major|critical" });
      fields.push("impact=?"); params.push(impact);
    }
    if (isPublic !== undefined){ fields.push("public=?"); params.push(isPublic ? 1 : 0); }
    if (!fields.length) return res.status(400).json({ error: "No fields to update" });
    params.push(req.params.id);
    await db.query(`UPDATE status_incidents SET ${fields.join(", ")} WHERE id=?`, params);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Post a new update to an incident. Changing status="resolved" closes the incident.
app.post("/api/admin/incidents/:id/updates", requireAdmin, async (req, res) => {
  const { status, message } = req.body;
  if (!["investigating","identified","monitoring","resolved"].includes(status)) {
    return res.status(400).json({ error: "status must be investigating|identified|monitoring|resolved" });
  }
  const msg = (message || "").toString().trim();
  if (!msg) return res.status(400).json({ error: "Message required" });
  if (msg.length > 4000) return res.status(400).json({ error: "Message too long (4000 max)" });
  try {
    const [rows] = await db.query("SELECT * FROM status_incidents WHERE id=?", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Incident not found" });
    const inc = rows[0];

    await db.query(
      "INSERT INTO status_incident_updates (incident_id, status, message, created_by) VALUES (?,?,?,?)",
      [inc.id, status, msg, req.session.userId || null]
    );
    // Mirror the latest status onto the parent row + close if resolved
    if (status === "resolved" && !inc.ended_at) {
      const now = new Date();
      const dur = Math.round((now - new Date(inc.started_at)) / 1000);
      await db.query(
        "UPDATE status_incidents SET status='resolved', ended_at=?, duration_s=? WHERE id=?",
        [now, dur, inc.id]
      );
    } else {
      await db.query("UPDATE status_incidents SET status=? WHERE id=?", [status, inc.id]);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete an update (typo fix). Never allow deleting the last update — there
// should always be at least one entry in the timeline.
app.delete("/api/admin/incident-updates/:id", requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query("SELECT incident_id FROM status_incident_updates WHERE id=?", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Update not found" });
    const [count] = await db.query("SELECT COUNT(*) AS n FROM status_incident_updates WHERE incident_id=?", [rows[0].incident_id]);
    if (count[0].n <= 1) return res.status(400).json({ error: "Cannot delete the only update on an incident" });
    await db.query("DELETE FROM status_incident_updates WHERE id=?", [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete an entire incident (admin only, for spurious flaps or test data).
app.delete("/api/admin/incidents/:id", requireAdmin, async (req, res) => {
  try {
    await db.query("DELETE FROM status_incident_updates WHERE incident_id=?", [req.params.id]);
    await db.query("DELETE FROM status_incidents WHERE id=?", [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Dashboard banners ───────────────────────────────────────────────────────
// Public feed — returns active banners for this group (group-scoped + global),
// filtered to the current time window. Anonymous visitors hit this endpoint
// when loading a public dashboard. Does not require auth.
app.get("/api/public/group/:slug/banners", async (req, res) => {
  try {
    const [groups] = await db.query("SELECT id FROM status_groups WHERE slug=?", [req.params.slug]);
    if (!groups.length) return res.status(404).json({ error: "Group not found" });
    const groupId = groups[0].id;
    // NOW() BETWEEN starts_at AND ends_at, but NULL on either end = unbounded.
    const [rows] = await db.query(
      `SELECT id, group_id, title, message, severity, link_url, link_text, dismissible,
              starts_at, ends_at
       FROM status_banners
       WHERE active=1
         AND (group_id=? OR group_id IS NULL)
         AND (starts_at IS NULL OR starts_at <= NOW())
         AND (ends_at   IS NULL OR ends_at   >= NOW())
       ORDER BY
         FIELD(severity,'critical','warning','info','success'),
         created_at DESC`,
      [groupId]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin — list every banner (regardless of active/time window).
app.get("/api/admin/banners", requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT b.*, g.name AS group_name, g.slug AS group_slug
       FROM status_banners b
       LEFT JOIN status_groups g ON g.id = b.group_id
       ORDER BY b.active DESC, b.created_at DESC`
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin — create banner.
app.post("/api/admin/banners", requireAdmin, async (req, res) => {
  const { group_id, title, message, severity = "info", link_url, link_text,
          active = 1, dismissible = 1, starts_at, ends_at } = req.body;
  if (!message || !String(message).trim()) return res.status(400).json({ error: "Message is required" });
  if (!["info","warning","critical","success"].includes(severity)) {
    return res.status(400).json({ error: "severity must be info|warning|critical|success" });
  }
  try {
    const [r] = await db.query(
      `INSERT INTO status_banners
         (group_id, title, message, severity, link_url, link_text,
          active, dismissible, starts_at, ends_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        group_id ? parseInt(group_id) : null,
        (title || "").trim() || null,
        String(message).trim().slice(0, 2000),
        severity,
        (link_url || "").trim() || null,
        (link_text || "").trim() || null,
        active ? 1 : 0,
        dismissible ? 1 : 0,
        starts_at || null,
        ends_at || null,
        req.session.userId || null
      ]
    );
    addAuditLog({ userId: req.session.userId, username: req.session.username, action:"banner.create", resourceType:"banner", resourceId:String(r.insertId), detail:severity, ip:req.ip });
    res.json({ ok: true, id: r.insertId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin — update banner.
app.put("/api/admin/banners/:id", requireAdmin, async (req, res) => {
  const { group_id, title, message, severity, link_url, link_text,
          active, dismissible, starts_at, ends_at } = req.body;
  try {
    const [rows] = await db.query("SELECT id FROM status_banners WHERE id=?", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Banner not found" });
    if (severity && !["info","warning","critical","success"].includes(severity)) {
      return res.status(400).json({ error: "Invalid severity" });
    }
    const fields = [];
    const params = [];
    if (group_id !== undefined)    { fields.push("group_id=?");    params.push(group_id ? parseInt(group_id) : null); }
    if (title !== undefined)       { fields.push("title=?");       params.push((title||"").trim() || null); }
    if (message !== undefined)     { fields.push("message=?");     params.push(String(message).trim().slice(0,2000)); }
    if (severity !== undefined)    { fields.push("severity=?");    params.push(severity); }
    if (link_url !== undefined)    { fields.push("link_url=?");    params.push((link_url||"").trim() || null); }
    if (link_text !== undefined)   { fields.push("link_text=?");   params.push((link_text||"").trim() || null); }
    if (active !== undefined)      { fields.push("active=?");      params.push(active ? 1 : 0); }
    if (dismissible !== undefined) { fields.push("dismissible=?"); params.push(dismissible ? 1 : 0); }
    if (starts_at !== undefined)   { fields.push("starts_at=?");   params.push(starts_at || null); }
    if (ends_at !== undefined)     { fields.push("ends_at=?");     params.push(ends_at   || null); }
    if (!fields.length) return res.status(400).json({ error: "No fields to update" });
    params.push(req.params.id);
    await db.query(`UPDATE status_banners SET ${fields.join(", ")} WHERE id=?`, params);
    addAuditLog({ userId:req.session.userId, username:req.session.username, action:"banner.update", resourceType:"banner", resourceId:req.params.id, ip:req.ip });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin — delete banner.
app.delete("/api/admin/banners/:id", requireAdmin, async (req, res) => {
  try {
    const [r] = await db.query("DELETE FROM status_banners WHERE id=?", [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: "Banner not found" });
    addAuditLog({ userId:req.session.userId, username:req.session.username, action:"banner.delete", resourceType:"banner", resourceId:req.params.id, ip:req.ip });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Danger Zone: wipe all historical data ───────────────────────────────────
// Deletes:
//   • status_history           (uptime dots / check history)
//   • status_incidents + status_incident_updates
//   • status_audit_log
// Keeps:
//   • servers, groups, users, webhooks, omada, square, settings, maintenance
// Requires the body to carry confirmation: "DELETE ALL HISTORY" — matches the
// string the UI prompts the operator to type. Belt-and-suspenders safeguard
// against a rogue /api/admin/clear-history call being triggered accidentally.
app.post("/api/admin/clear-history", requireAdmin, async (req, res) => {
  const confirm = (req.body && req.body.confirm) || "";
  if (confirm !== "DELETE ALL HISTORY") {
    return res.status(400).json({ error: "Confirmation phrase required" });
  }
  try {
    const [h] = await db.query("SELECT COUNT(*) AS n FROM status_history");
    const [i] = await db.query("SELECT COUNT(*) AS n FROM status_incidents");
    const [a] = await db.query("SELECT COUNT(*) AS n FROM status_audit_log");
    await db.query("DELETE FROM status_incident_updates");
    await db.query("DELETE FROM status_incidents");
    await db.query("DELETE FROM status_history");
    await db.query("DELETE FROM status_audit_log");
    addAuditLog({
      userId: req.session.userId,
      username: req.session.username,
      action: "history.wipe",
      resourceType: "system",
      detail: `Cleared ${h[0].n} history, ${i[0].n} incidents, ${a[0].n} audit entries`,
      ip: req.ip
    });
    addLog({ level:"warn", server:"system", message:`[DANGER] ${req.session.username} cleared all history (${h[0].n} history, ${i[0].n} incidents, ${a[0].n} audit rows)` });
    res.json({ ok: true, deleted: { history: h[0].n, incidents: i[0].n, audit: a[0].n } });
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
      description: s.description, category: s.category || "", sub_category: s.sub_category || "", tags: s.tags, group_ids: s.group_ids || [],
      checks: s.checks || [],                  // includes cert info for HTTPS checks
      overall: s.overall, lastChecked: s.lastChecked,
      uptimeHistory: s.uptimeHistory,
      lat: s.lat != null ? s.lat : null,
      lng: s.lng != null ? s.lng : null,
      // Runbook: on-call playbook shown on the detail panel. Authenticated viewers only —
      // may contain sensitive ops info (SSH hosts, vendor contacts, credential rotation steps).
      runbook: s.runbook || ""
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
    const isAuthed = !!(req.session && req.session.userId);
    const servers = Object.values(serverStatus)
      .filter(s => Array.isArray(s.group_ids) && s.group_ids.includes(g.id))
      .map(s => ({
        id: s.id, name: s.name, host: s.host,
        description: s.description, category: s.category || "", sub_category: s.sub_category || "", tags: s.tags, group_ids: s.group_ids,
        checks: s.checks || [],              // includes cert info for HTTPS checks
        overall: s.overall, lastChecked: s.lastChecked,
        uptimeHistory: s.uptimeHistory,
        // Coords are shown on the topbar map button (logged-in users only) — anonymous
        // visitors on a public dashboard don't need them and shouldn't see locations.
        lat: isAuthed && s.lat != null ? s.lat : null,
        lng: isAuthed && s.lng != null ? s.lng : null,
        // Runbook is for on-call only — don't surface to anonymous visitors.
        runbook: isAuthed ? (s.runbook || "") : ""
      }));
    res.json({ group: g, servers });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// -- Badge API -----------------------------------------------------------------
// Shields.io-style SVG badges for embedding in READMEs, docs, dashboards, etc.
// Auth: same gate as other public endpoints — server must be in a group (public),
//       or the request must be from a logged-in viewer/admin.

function makeBadge(label, value, color, style) {
  const l = String(Array.isArray(label) ? label[0] : (label ?? ""));
  const v = String(Array.isArray(value) ? value[0] : (value ?? ""));
  const s = String(style || "flat").toLowerCase();
  const esc = x => String(x).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

  if (s === "for-the-badge") {
    const L = l.toUpperCase(), V = v.toUpperCase();
    const charW = 7.5, pad = 16;
    const lw = Math.ceil(L.length * charW) + pad * 2;
    const vw = Math.ceil(V.length * charW) + pad * 2;
    const tw = lw + vw;
    const lx = (lw / 2).toFixed(1);
    const vx = (lw + vw / 2).toFixed(1);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="28" role="img" aria-label="${esc(L)}: ${esc(V)}">
<title>${esc(L)}: ${esc(V)}</title>
<g>
  <rect width="${lw}" height="28" fill="#555"/>
  <rect x="${lw}" width="${vw}" height="28" fill="${color}"/>
</g>
<g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11" font-weight="bold" letter-spacing="1">
  <text x="${lx}" y="18">${esc(L)}</text>
  <text x="${vx}" y="18">${esc(V)}</text>
</g>
</svg>`;
  }

  if (s === "flat-square") {
    const charW = 6.5, pad = 10;
    const lw = Math.ceil(l.length * charW) + pad * 2;
    const vw = Math.ceil(v.length * charW) + pad * 2;
    const tw = lw + vw;
    const lx = (lw / 2 + 1).toFixed(1);
    const vx = (lw + vw / 2).toFixed(1);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="20" role="img" aria-label="${esc(l)}: ${esc(v)}">
<title>${esc(l)}: ${esc(v)}</title>
<g>
  <rect width="${lw}" height="20" fill="#555"/>
  <rect x="${lw}" width="${vw}" height="20" fill="${color}"/>
</g>
<g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
  <text x="${lx}" y="15" fill="#010101" fill-opacity=".3">${esc(l)}</text><text x="${lx}" y="14">${esc(l)}</text>
  <text x="${vx}" y="15" fill="#010101" fill-opacity=".3">${esc(v)}</text><text x="${vx}" y="14">${esc(v)}</text>
</g>
</svg>`;
  }

  if (s === "plastic") {
    const charW = 6.5, pad = 10;
    const lw = Math.ceil(l.length * charW) + pad * 2;
    const vw = Math.ceil(v.length * charW) + pad * 2;
    const tw = lw + vw;
    const lx = (lw / 2 + 1).toFixed(1);
    const vx = (lw + vw / 2).toFixed(1);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="18" role="img" aria-label="${esc(l)}: ${esc(v)}">
<title>${esc(l)}: ${esc(v)}</title>
<linearGradient id="p" x2="0" y2="100%">
  <stop offset="0"  stop-color="#fff" stop-opacity=".25"/>
  <stop offset=".4" stop-color="#fff" stop-opacity=".08"/>
  <stop offset=".6" stop-color="#000" stop-opacity=".08"/>
  <stop offset="1"  stop-color="#000" stop-opacity=".18"/>
</linearGradient>
<clipPath id="r"><rect width="${tw}" height="18" rx="4" fill="#fff"/></clipPath>
<g clip-path="url(#r)">
  <rect width="${lw}" height="18" fill="#444"/>
  <rect x="${lw}" width="${vw}" height="18" fill="${color}"/>
  <rect width="${tw}" height="18" fill="url(#p)"/>
</g>
<g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
  <text x="${lx}" y="13" fill="#010101" fill-opacity=".4">${esc(l)}</text><text x="${lx}" y="12">${esc(l)}</text>
  <text x="${vx}" y="13" fill="#010101" fill-opacity=".4">${esc(v)}</text><text x="${vx}" y="12">${esc(v)}</text>
</g>
</svg>`;
  }

  // Default: flat (with subtle gradient — same as current)
  const charW = 6.5, pad = 10;
  const lw = Math.ceil(l.length * charW) + pad * 2;
  const vw = Math.ceil(v.length * charW) + pad * 2;
  const tw = lw + vw;
  const lx = (lw / 2 + 1).toFixed(1);
  const vx = (lw + vw / 2).toFixed(1);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${tw}" height="20" role="img" aria-label="${esc(l)}: ${esc(v)}">
<title>${esc(l)}: ${esc(v)}</title>
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
  <text x="${lx}" y="15" fill="#010101" fill-opacity=".3">${esc(l)}</text><text x="${lx}" y="14">${esc(l)}</text>
  <text x="${vx}" y="15" fill="#010101" fill-opacity=".3">${esc(v)}</text><text x="${vx}" y="14">${esc(v)}</text>
</g>
</svg>`;
}

function sendBadge(res, label, value, color, req) {
  const style = req && req.query && req.query.style ? req.query.style : "flat";
  res.set("Content-Type",  "image/svg+xml");
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.send(makeBadge(label, value, color, style));
}

// ── PWA support ──────────────────────────────────────────────────────────────

// Minimal service worker — satisfies Chrome/Android installability requirement.
// Does not cache anything; all requests pass through to the network so live
// status data is never stale. The SW exists purely to unlock the browser's
// "Add to Home Screen" / install prompt.
app.get("/sw.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Cache-Control", "no-cache");
  // No fetch handler = SW does not intercept anything. Browser still treats the
  // page as installable (install + activate + manifest satisfy the PWA criteria),
  // but API calls, SSE streams, and navigations hit the network directly with
  // zero SW involvement — so a network glitch never surfaces as a "service
  // worker rejected the promise" error in the console.
  res.send(`self.addEventListener("install",  e => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(clients.claim()));`);
});

// Group icon — used by manifest.json and as apple-touch-icon.
// Always returns image/svg+xml so manifest sizes:"any" is valid for Chrome PWA
// install. Raster logo_images are embedded inside an SVG <image> wrapper.
app.get("/api/icon/:slug", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT logo_image, logo_text, name, accent_color, bg_color FROM status_groups WHERE slug=?",
      [req.params.slug]
    );
    if (!rows.length) return res.status(404).send("Not found");
    const g = rows[0];
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "public, max-age=3600");
    if (g.logo_image && g.logo_image.startsWith("data:")) {
      // Wrap raster in an SVG envelope — keeps the image, forces SVG MIME type
      // so manifest sizes:"any" is correct and Chrome PWA validation passes.
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 512 512" width="512" height="512">
  <image href="${g.logo_image}" width="512" height="512" preserveAspectRatio="xMidYMid meet"/>
</svg>`;
      return res.end(svg);
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
    res.end(svg);
  } catch(e) { res.status(500).send("Error"); }
});

// Per-group Web App Manifest — powers the "Add to Home Screen" / install prompt
// on both Android (Chrome) and iOS (Safari). Branding matches the group's theme.
app.get("/dashboard/:slug/manifest.json", pageLimiter, async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM status_groups WHERE slug=?", [req.params.slug]);
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    const g = rows[0];
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
        { src: `/api/icon/${g.slug}`, sizes: "any", type: "image/svg+xml", purpose: "any"      },
        { src: `/api/icon/${g.slug}`, sizes: "any", type: "image/svg+xml", purpose: "maskable" }
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
  sendBadge(res, label, value, colorMap[overall] || "#9f9f9f", req);
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
    if (total === 0) return sendBadge(res, label, "N/A", "#9f9f9f", req);
    const pct   = Math.round((up / total) * 1000) / 10;
    const color = pct >= 99 ? "#44cc11" : pct >= 95 ? "#dfb317" : "#e05d44";
    sendBadge(res, label, `${pct}%`, color, req);
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
  sendBadge(res, label, value, color, req);
});

// SSL cert expiry badge: days until certificate expires
app.get("/api/badge/:id/cert-exp", allowGroupedOrAuth, (req, res) => {
  const s = serverStatus[req.params.id];
  if (!s) return res.status(404).json({ error: "Server not found" });
  const label    = req.query.label || "cert exp";
  const httpChk  = s.checks.find(c => (c.type === "http" || c.type === "https") && c.cert?.valid_to);
  if (!httpChk) return sendBadge(res, label, "N/A", "#9f9f9f", req);
  const days  = Math.ceil((new Date(httpChk.cert.valid_to) - Date.now()) / 86400000);
  const value = days < 0 ? "expired" : `${days}d`;
  const warnDays = parseInt(req.query.warnDays) || 14;
  const downDays = parseInt(req.query.downDays) || 7;
  const color = days < 0 ? "#e05d44" : days <= downDays ? "#e05d44" : days <= warnDays ? "#dfb317" : "#44cc11";
  sendBadge(res, label, value, color, req);
});

// ── Beta: Email subscriptions ────────────────────────────────────────────────
app.post("/api/public/subscribe", pageLimiter, async (req, res) => {
  try {
    const { email, group_id, notify_down, notify_recovery } = req.body;
    if (!email || !group_id) return res.status(400).json({ error: "email and group_id required" });
    if (!isValidEmail(email))
      return res.status(400).json({ error: "Invalid email address" });
    // Verify group exists
    const [gRows] = await db.query("SELECT id, name FROM status_groups WHERE id=?", [group_id]);
    if (!gRows.length)
      return res.status(404).json({ error: "Group not found" });
    const token = crypto.randomBytes(32).toString("hex");
    await db.query(
      `INSERT INTO status_email_subscriptions (email, group_id, notify_down, notify_recovery, unsubscribe_token)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         notify_down=VALUES(notify_down),
         notify_recovery=VALUES(notify_recovery),
         unsubscribe_token=VALUES(unsubscribe_token)`,
      [email.trim().toLowerCase(), group_id,
       notify_down !== false ? 1 : 0,
       notify_recovery !== false ? 1 : 0,
       token]
    );
    addLog({ level:"info", server:"subscriptions", message:`New email subscription: ${email} → group ${gRows[0].name}` });
    res.json({ ok: true, message: "Subscribed successfully" });
  } catch(e) {
    addLog({ level:"error", server:"subscriptions", message:`Subscribe error: ${e.message}` });
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/public/unsubscribe", pageLimiter, async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).send("Missing token");
    const [rows] = await db.query(
      "SELECT s.id, s.email, g.name AS group_name FROM status_email_subscriptions s JOIN status_groups g ON g.id=s.group_id WHERE s.unsubscribe_token=?",
      [token]
    );
    if (!rows.length) return res.status(404).send("Subscription not found or already removed");
    await db.query("DELETE FROM status_email_subscriptions WHERE unsubscribe_token=?", [token]);
    addLog({ level:"info", server:"subscriptions", message:`Unsubscribed: ${rows[0].email} from ${rows[0].group_name}` });
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Unsubscribed</title>
      <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#060c18;color:#94b8d8}
      .box{text-align:center;padding:40px;background:#0d1829;border-radius:12px;border:1px solid rgba(30,100,200,.15)}
      h2{color:#10e88a;margin:0 0 12px}p{margin:0;color:#5e8aad}</style></head>
      <body><div class="box"><h2>&#x2705; Unsubscribed</h2><p>You have been removed from alerts for <strong>${rows[0].group_name}</strong>.</p></div></body></html>`);
  } catch(e) {
    res.status(500).send("Server error");
  }
});

app.get("/api/public/subscription-status", pageLimiter, async (req, res) => {
  try {
    const { email, group_id } = req.query;
    if (!email || !group_id) return res.json({ subscribed: false });
    const [rows] = await db.query(
      "SELECT notify_down, notify_recovery FROM status_email_subscriptions WHERE email=? AND group_id=?",
      [email.trim().toLowerCase(), group_id]
    );
    if (!rows.length) return res.json({ subscribed: false });
    res.json({ subscribed: true, notify_down: !!rows[0].notify_down, notify_recovery: !!rows[0].notify_recovery });
  } catch(e) {
    res.json({ subscribed: false });
  }
});

// Modal-based unsubscribe — no token needed, user is voluntarily removing themselves
app.delete("/api/public/subscribe", pageLimiter, async (req, res) => {
  try {
    const { email, group_id } = req.body;
    if (!email || !group_id) return res.status(400).json({ error: "email and group_id required" });
    const [result] = await db.query(
      "DELETE FROM status_email_subscriptions WHERE email=? AND group_id=?",
      [email.trim().toLowerCase(), group_id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: "Subscription not found" });
    addLog({ level:"info", server:"subscriptions", message:`Unsubscribed (modal): ${email} from group ${group_id}` });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: "Server error" });
  }
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
      if (req.path === "/incidents") {
        return res.render("incidents", {
          groupSlug:    g.slug,
          groupName:    g.name,
          accentColor:  g.accent_color || "#2a7fff",
          bgColor:      g.bg_color || null,
          logoText:     g.logo_text || "",
          logoImage:    g.logo_image || null,
          logoSize:     g.logo_size || 42,
          pageTitle:    `${g.name} — Incident History`,
          privacyUrl:   g.privacy_text ? "/privacy" : null,
          termsUrl:     g.terms_text   ? "/terms"   : null,
        });
      }
      return res.render("index", {
        // Relative /admin — keeps the viewer on their own custom domain (e.g.
        // status.myanthemcoffee.com/admin) so they can log in and manage without
        // being bounced to the gateway host.
        adminHref:    "/admin",
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
app.get("/login",   (req, res) => res.render("login", { googleEnabled: !!googleOAuth }));
app.get("/privacy", (req, res) => res.render("privacy"));
app.get("/terms",   (req, res) => res.render("terms"));

// Beta: Public status page — only accessible when group has public_enabled=1
app.get("/status/:slug", pageLimiter, async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM status_groups WHERE slug=?", [req.params.slug]);
    if (!rows.length || !rows[0].public_enabled) return res.status(404).render("404", { slug: req.params.slug });
    const g = rows[0];
    res.render("index", {
      adminHref:     "/admin",
      groupSlug:     g.slug,
      groupName:     g.name,
      groupSubtitle: g.description || "",
      accentColor:   g.accent_color || "#2a7fff",
      bgColor:       g.bg_color || null,
      logoText:      g.logo_text || "",
      logoImage:     g.logo_image || null,
      logoSize:      g.logo_size || 42,
      defaultTheme:  g.default_theme || "dark",
      pageTitle:     `${g.name} — Status`,
      privacyUrl:    g.privacy_text ? `/dashboard/${g.slug}/privacy` : "/privacy",
      termsUrl:      g.terms_text   ? `/dashboard/${g.slug}/terms`   : "/terms",
      isPublicPage:  true,
    });
  } catch(e) {
    res.status(500).send("Server error");
  }
});

// Per-group dashboard
app.get("/dashboard/:slug", pageLimiter, async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM status_groups WHERE slug=?", [req.params.slug]);
    if (!rows.length) return res.status(404).render("404", { slug: req.params.slug });
    const g = rows[0];
    res.render("index", {
      // Same-domain dashboard: relative /admin works (shared cookie scope with /admin)
      adminHref:    "/admin",
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
app.get("/dashboard/:slug/privacy", pageLimiter, async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM status_groups WHERE slug=?", [req.params.slug]);
    if (!rows.length) return res.status(404).render("404", { slug: req.params.slug });
    const g = rows[0];
    return g.privacy_text
      ? res.render("group-legal", { g, type: "privacy", content: g.privacy_text })
      : res.render("privacy");
  } catch(e) { res.status(500).send("Server error"); }
});

// Public incident history page — lists every public incident for servers in this group
// with the operator-authored update timeline. Uses the same branding as the dashboard.
app.get("/dashboard/:slug/incidents", pageLimiter, async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM status_groups WHERE slug=?", [req.params.slug]);
    if (!rows.length) return res.status(404).render("404", { slug: req.params.slug });
    const g = rows[0];
    res.render("incidents", {
      groupSlug:    g.slug,
      groupName:    g.name,
      accentColor:  g.accent_color || "#2a7fff",
      bgColor:      g.bg_color || null,
      logoText:     g.logo_text || "",
      logoImage:    g.logo_image || null,
      logoSize:     g.logo_size || 42,
      pageTitle:    `${g.name} — Incident History`,
      privacyUrl:   g.privacy_text ? `/dashboard/${g.slug}/privacy` : "/privacy",
      termsUrl:     g.terms_text   ? `/dashboard/${g.slug}/terms`   : "/terms",
    });
  } catch(e) { res.status(500).send("Server error"); }
});

app.get("/dashboard/:slug/terms", pageLimiter, async (req, res) => {
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

// -- Boot ----------------------------------------------------------------------
// ── Import / Export ────────────────────────────────────────────────────────────
app.get("/api/admin/export", requireAdmin, async (req, res) => {
  try {
    const [servers] = await db.query("SELECT * FROM status_servers ORDER BY sort_order, created_at");
    const [groupMap] = await db.query("SELECT server_id, group_id FROM status_server_group_map");
    const gByServer = {};
    for (const row of groupMap) {
      if (!gByServer[row.server_id]) gByServer[row.server_id] = [];
      gByServer[row.server_id].push(row.group_id);
    }
    const exported = servers.map(s => ({
      name:              s.name,
      host:              s.host,
      description:       s.description || "",
      category:          s.category || "",
      sub_category:      s.sub_category || "",
      tags:              (() => { try { return JSON.parse(s.tags||"[]"); } catch(e) { return []; } })(),
      checks:            (() => { try { return JSON.parse(s.checks||"[]"); } catch(e) { return [{type:"ping"}]; } })(),
      poll_interval_sec: s.poll_interval_sec || 30,
      failure_threshold: s.failure_threshold || 1,
      lat:               s.lat || null,
      lng:               s.lng || null,
      group_ids:         gByServer[s.id] || []
    }));
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Disposition", `attachment; filename="servers-export-${date}.json"`);
    res.json({ version: "1.0", exported_at: new Date().toISOString(), servers: exported });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/import", requireAdmin, async (req, res) => {
  const { servers, mode = "skip" } = req.body;
  if (!Array.isArray(servers)) return res.status(400).json({ error: "Expected { servers: [...] }" });
  let added = 0, skipped = 0, errors = [];
  for (const s of servers) {
    if (!s.name || !s.host) { errors.push(`Skipped: missing name or host`); continue; }
    try {
      const [existing] = await db.query("SELECT id FROM status_servers WHERE name=?", [s.name]);
      const interval  = Math.max(10, Math.min(3600, parseInt(s.poll_interval_sec)||30));
      const threshold = Math.max(1,  Math.min(10,   parseInt(s.failure_threshold)||1));
      const tags    = JSON.stringify(Array.isArray(s.tags) ? s.tags : []);
      const checks  = JSON.stringify(Array.isArray(s.checks) && s.checks.length ? s.checks : [{type:"ping"}]);
      const lat     = s.lat ? parseFloat(s.lat) : null;
      const lng     = s.lng ? parseFloat(s.lng) : null;
      const cat     = (s.category||"").trim() || null;
      const subCat  = (s.sub_category||"").trim() || null;
      if (existing.length) {
        if (mode === "skip") { skipped++; continue; }
        const id = existing[0].id;
        await db.query(
          "UPDATE status_servers SET host=?,description=?,category=?,sub_category=?,tags=?,checks=?,poll_interval_sec=?,failure_threshold=?,lat=?,lng=?,location_address=?,updated_at=NOW() WHERE id=?",
          [s.host, s.description||"", cat, subCat, tags, checks, interval, threshold, lat, lng, s.location_address||null, id]
        );
        if (Array.isArray(s.group_ids) && s.group_ids.length) await setServerGroupIds(id, s.group_ids);
        added++;
      } else {
        const id = s.name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"") + "-" + Date.now() + "-" + Math.floor(Math.random()*9999);
        await db.query(
          "INSERT INTO status_servers (id,name,host,description,category,sub_category,tags,checks,poll_interval_sec,failure_threshold,lat,lng,location_address) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
          [id, s.name, s.host, s.description||"", cat, subCat, tags, checks, interval, threshold, lat, lng, s.location_address||null]
        );
        if (Array.isArray(s.group_ids) && s.group_ids.length) await setServerGroupIds(id, s.group_ids);
        added++;
      }
    } catch(e) { errors.push(`${s.name}: ${e.message}`); }
  }
  await loadConfig();
  addAuditLog({ userId: req.session.userId, username: req.session.username, action:"servers.import", resourceType:"server", detail:`imported ${added}, skipped ${skipped}`, ip: req.ip });
  res.json({ ok:true, added, skipped, errors });
});

// ── API Key Authentication ──────────────────────────────────────────────────────
// Key format: ssk_<64 hex chars>. Stored as HMAC-SHA256(SESSION_SECRET, rawKey).
// HMAC (not plain SHA) means a leaked DB alone can't be used to validate keys — the
// attacker also needs the server-side SESSION_SECRET pepper. Deterministic lookup
// is preserved (same key always hashes the same), unlike bcrypt/scrypt.
function hashApiKey(rawKey) {
  return require("crypto").createHmac("sha256", SESSION_SECRET).update(rawKey).digest("hex");
}
function requireApiKey(scope = "read") {
  return async (req, res, next) => {
    const auth  = (req.headers["authorization"] || "").trim();
    const xKey  = (req.headers["x-api-key"] || "").trim();
    const rawKey = auth.startsWith("Bearer ") ? auth.slice(7).trim() : xKey;
    if (!rawKey) return res.status(401).json({ error: "API key required. Pass Authorization: Bearer <key> or X-API-Key: <key>" });
    try {
      const hash  = hashApiKey(rawKey);
      const [rows] = await db.query("SELECT * FROM status_api_keys WHERE key_hash=?", [hash]);
      if (!rows.length) return res.status(401).json({ error: "Invalid API key" });
      const key = rows[0];
      if (scope === "write" && key.scope !== "write") return res.status(403).json({ error: "This key has read-only scope" });
      db.query("UPDATE status_api_keys SET last_used_at=NOW() WHERE id=?", [key.id]).catch(() => {});
      req.apiKey = key;
      next();
    } catch(e) { res.status(500).json({ error: e.message }); }
  };
}

// v1 read endpoint — returns current status of all visible servers
app.get("/api/v1/status", requireApiKey("read"), (req, res) => {
  const out = Object.entries(serverStatus).map(([id, s]) => ({
    id,
    name:         s.name,
    status:       s.overall,
    last_checked: s.lastChecked,
    checks:       (s.checks||[]).map(c => ({ type:c.type, ok:c.ok, detail:c.detail||null, response_ms:c.response_ms||null }))
  }));
  res.json(out);
});

// v1 read endpoint — single server
app.get("/api/v1/status/:id", requireApiKey("read"), (req, res) => {
  const s = serverStatus[req.params.id];
  if (!s) return res.status(404).json({ error: "Server not found" });
  res.json({ id: req.params.id, name: s.name, status: s.overall, last_checked: s.lastChecked,
    checks: (s.checks||[]).map(c => ({ type:c.type, ok:c.ok, detail:c.detail||null, response_ms:c.response_ms||null })) });
});

// v1 write endpoint — CI/CD pipelines push external status
app.post("/api/v1/servers/:id/push-status", requireApiKey("write"), async (req, res) => {
  const { status, detail } = req.body;
  if (!["up","down","degraded"].includes(status)) return res.status(400).json({ error:"status must be up|down|degraded" });
  const def = serverConfig.find(s => s.id === req.params.id);
  if (!def) return res.status(404).json({ error:"Server not found" });
  const result = { type:"external", ok: status==="up", detail: (detail||`pushed via API: ${status}`).slice(0,255), response_ms:null };
  serverStatus[def.id] = { ...(serverStatus[def.id]||{}), overall:status, checks:[result], lastChecked: new Date().toISOString() };
  await recordHistory(def, [result], status).catch(() => {});
  const all = Object.values(serverStatus);
  sseClients.filter(r => !r.writableEnded).forEach(r => { try { r.write(`data: ${JSON.stringify(all)}\n\n`); } catch(_) {} });
  res.json({ ok:true });
});

// Admin API key management
app.get("/api/admin/api-keys", requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query("SELECT id,name,key_prefix,scope,last_used_at,created_at FROM status_api_keys ORDER BY created_at DESC");
    res.json(rows);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post("/api/admin/api-keys", requireAdmin, async (req, res) => {
  const { name, scope = "read" } = req.body;
  if (!name) return res.status(400).json({ error:"Name is required" });
  if (!["read","write"].includes(scope)) return res.status(400).json({ error:"scope must be read or write" });
  try {
    const rawKey   = "ssk_" + require("crypto").randomBytes(32).toString("hex");
    const hash     = hashApiKey(rawKey);
    const prefix   = rawKey.slice(0, 12);
    await db.query("INSERT INTO status_api_keys (name,key_hash,key_prefix,scope,created_by) VALUES (?,?,?,?,?)",
      [name, hash, prefix, scope, req.session.userId]);
    addAuditLog({ userId:req.session.userId, username:req.session.username, action:"api_key.create", resourceType:"api_key", resourceName:name, detail:scope, ip:req.ip });
    res.json({ ok:true, key: rawKey }); // shown once only
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.delete("/api/admin/api-keys/:id", requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query("SELECT name FROM status_api_keys WHERE id=?", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error:"API key not found" });
    await db.query("DELETE FROM status_api_keys WHERE id=?", [req.params.id]);
    addAuditLog({ userId:req.session.userId, username:req.session.username, action:"api_key.delete", resourceType:"api_key", resourceName:rows[0].name, ip:req.ip });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Catch-all: redirect any non-API non-page route to /login (authed users will then bounce to /)
// MUST be registered after ALL routes — Express matches in order, so any route declared
// below this point would be shadowed by this catch-all.
app.get("/{*path}", (req, res) => {
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

(async () => {
  await initDB();
  await loadConfig();
  await refreshMaintenanceCache();
  await pollAll(true);  // force everything on startup
  // Tick every 5 seconds — pollAll() picks only servers that are DUE based on their
  // own poll_interval_sec. This lets fast servers (20s) and slow ones (5 min) coexist.
  const TICK = 5000;
  setInterval(async () => { await loadConfig(); await pollAll(); }, TICK);
  // Refresh maintenance cache every 60s — CRUD endpoints also refresh inline, this is
  // a safety net for windows that become active/inactive purely by time passing.
  setInterval(() => { refreshMaintenanceCache().catch(() => {}); }, 60 * 1000);
  // Hourly check: fire the weekly uptime report on Monday ≥09:00 UTC (once per week)
  setInterval(() => { maybeSendScheduledWeeklyReport().catch(() => {}); }, 60 * 60 * 1000);
  // Also attempt shortly after startup so a restart right at the trigger window still fires
  setTimeout(() => { maybeSendScheduledWeeklyReport().catch(() => {}); }, 30 * 1000);
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