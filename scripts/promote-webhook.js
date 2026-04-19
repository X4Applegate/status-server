#!/usr/bin/env node
// promote-webhook.js — host-side HTTP trigger for HA auto-failover.
//
// Runs as a systemd service on the STANDBY box. When the health-signal
// source (Cloudflare Worker cron, Load Balancer, or standby watchdog)
// detects that the primary is down, it POSTs here to promote this box.
//
// Why standalone instead of an endpoint in server.js?
//   The promote script has to run on the HOST — it edits compose files,
//   starts systemd services, and manages the cloudflared connector. A
//   container-bound endpoint can't cleanly reach those things without
//   mounting the docker socket (security hole) or SSH-looping to the
//   host. Also: if the status-server container is the reason we're
//   failing over, an endpoint inside it can't respond. This service
//   survives that failure mode.
//
// Architecture:
//   Cloudflare Worker / health-signal source
//       │  POST /promote  with  X-Promote-Token: <shared secret>
//       ▼
//   [promote-webhook.service on standby host]  (this file)
//       │  spawn  sudo -E /opt/status-server/scripts/promote-replica.sh
//       │         --non-interactive --json
//       │  env:   PROMOTE_ACK=yes, MARIADB_ROOT_PASSWORD=..., CLOUDFLARED_SVC=...
//       ▼
//   JSON response mapping script exit code → HTTP status
//
// Endpoints:
//   POST /promote    — auth required; invokes promote script
//   GET  /health     — no auth; { ok, version, ready, cooldown_remaining_s }
//   GET  /           — 404 (no directory listing)
//
// Exit-code → HTTP mapping:
//   0  promoted              → 200 { status: "promoted", ... }
//   1  user_aborted/ack      → 500 { status: "internal_error" }    (webhook bug)
//   2  already_promoted      → 200 { status: "already_promoted" }  (idempotent)
//   3  preflight_fail        → 500 { status: "preflight_fail" }
//   4  promotion_sql_failed  → 500 { status: "promotion_sql_failed" }
//   *  any other / timeout   → 500 { status: "unknown_error" }

"use strict";

const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// ── Config (env vars) ────────────────────────────────────────────────────────
const PORT   = parseInt(process.env.PROMOTE_WEBHOOK_PORT || "9876", 10);
const BIND   = process.env.PROMOTE_WEBHOOK_BIND || "127.0.0.1";
const SECRET = process.env.PROMOTE_SHARED_SECRET || "";
const SCRIPT = process.env.PROMOTE_SCRIPT_PATH || "/opt/status-server/scripts/promote-replica.sh";
const COOLDOWN_SECONDS = parseInt(process.env.PROMOTE_COOLDOWN_SECONDS || "300", 10);
const STATE_FILE = process.env.PROMOTE_STATE_FILE || "/var/lib/status-server/promote-webhook.state";
const TIMEOUT_MS = parseInt(process.env.PROMOTE_TIMEOUT_MS || "120000", 10);
const PKG_VERSION = (() => {
  try { return require(path.join(__dirname, "..", "backend", "package.json")).version; }
  catch { return "unknown"; }
})();

// Refuse to start without a shared secret — the whole point of this service
// is to gate a destructive action behind auth.
if (!SECRET || SECRET.length < 32) {
  console.error("FATAL: PROMOTE_SHARED_SECRET must be set and at least 32 chars long.");
  console.error("       Generate one with:  openssl rand -hex 32");
  process.exit(1);
}

// Refuse to start if we can't see the script.
if (!fs.existsSync(SCRIPT)) {
  console.error(`FATAL: promote script not found at ${SCRIPT}`);
  console.error("       Set PROMOTE_SCRIPT_PATH if it's elsewhere.");
  process.exit(1);
}

// Ensure state directory exists.
try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true, mode: 0o750 }); }
catch (e) { /* ignore — best effort */ }

// ── Cooldown state (Step 3 preview — minimal implementation) ─────────────────
// Tracks the last successful promotion time so we refuse to promote again
// within the cooldown window. Prevents ping-pong if both sides briefly see
// each other as down. Stored on disk so the cooldown survives a restart of
// THIS service (which is separate from the status-server container).
function readLastPromoteTs() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8").trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}
function writeLastPromoteTs(ts) {
  try { fs.writeFileSync(STATE_FILE, String(ts), { mode: 0o640 }); }
  catch (e) { console.error(`WARN: could not write state file: ${e.message}`); }
}
function cooldownRemainingSeconds() {
  const last = readLastPromoteTs();
  if (!last) return 0;
  const elapsed = Math.floor((Date.now() - last) / 1000);
  return Math.max(0, COOLDOWN_SECONDS - elapsed);
}

// ── Auth — constant-time compare ─────────────────────────────────────────────
function checkToken(header) {
  if (typeof header !== "string" || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(SECRET);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); }
  catch { return false; }
}

// ── Response helper ──────────────────────────────────────────────────────────
function sendJson(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store"
  });
  res.end(payload);
}

// ── Script exit code → HTTP status + status slug ─────────────────────────────
function mapExitCode(code) {
  switch (code) {
    case 0: return { http: 200, slug: "promoted" };
    case 1: return { http: 500, slug: "internal_error" };   // webhook bug (we set PROMOTE_ACK)
    case 2: return { http: 200, slug: "already_promoted" };
    case 3: return { http: 500, slug: "preflight_fail" };
    case 4: return { http: 500, slug: "promotion_sql_failed" };
    default: return { http: 500, slug: "unknown_error" };
  }
}

// ── Invoke the promote script ────────────────────────────────────────────────
function runPromote() {
  return new Promise((resolve) => {
    // sudo -E preserves env (PROMOTE_ACK, MARIADB_ROOT_PASSWORD) for the child.
    // The systemd unit already runs this service as root, so in that case
    // sudo is a no-op wrapper and doesn't require a password.
    const child = spawn("sudo", ["-E", SCRIPT, "--non-interactive", "--json"], {
      env: {
        ...process.env,
        PROMOTE_ACK: "yes"
      }
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch {}
      resolve({
        exitCode: -1,
        stdout, stderr,
        timedOut: true,
        scriptJson: null
      });
    }, TIMEOUT_MS);

    child.stdout.on("data", d => { stdout += d.toString(); });
    child.stderr.on("data", d => { stderr += d.toString(); });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode: -1, stdout, stderr: stderr + String(err), timedOut: false, scriptJson: null });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      // The script's --json flag emits exactly one JSON line — usually the last
      // non-empty line of stdout. Parse it opportunistically; if absent, we
      // still have the exit code to work with.
      let scriptJson = null;
      const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].startsWith("{") && lines[i].endsWith("}")) {
          try { scriptJson = JSON.parse(lines[i]); break; } catch {}
        }
      }
      resolve({ exitCode: code, stdout, stderr, timedOut: false, scriptJson });
    });
  });
}

// ── Request dispatch ─────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const ts = new Date().toISOString();
  const ip = (req.socket.remoteAddress || "?").replace(/^::ffff:/, "");

  // Basic access log (one line per request).
  const logLine = (code, extra = "") =>
    console.log(`[${ts}] ${ip} ${req.method} ${req.url} → ${code}${extra ? " " + extra : ""}`);

  // ── GET /health (no auth) ──
  if (req.method === "GET" && req.url === "/health") {
    const remaining = cooldownRemainingSeconds();
    sendJson(res, 200, {
      ok: true,
      service: "promote-webhook",
      version: PKG_VERSION,
      ready: true,
      cooldown_remaining_s: remaining,
      script_path: SCRIPT,
      port: PORT
    });
    return logLine(200);
  }

  // ── POST /promote (auth required) ──
  if (req.method === "POST" && req.url === "/promote") {
    // Auth
    const token = req.headers["x-promote-token"];
    if (!checkToken(token)) {
      sendJson(res, 401, { status: "unauthorized", message: "invalid or missing X-Promote-Token" });
      return logLine(401, "auth_failed");
    }

    // Cooldown
    const remaining = cooldownRemainingSeconds();
    if (remaining > 0) {
      sendJson(res, 429, {
        status: "cooldown",
        message: `in cooldown window; retry after ${remaining}s`,
        cooldown_remaining_s: remaining
      });
      return logLine(429, `cooldown_${remaining}s`);
    }

    // TODO (Step 4 — split-brain guard): verify via a second signal that
    // the primary is actually down before proceeding. For now, we trust
    // the caller to have verified this.

    // Invoke promote script.
    console.log(`[${ts}] promote triggered by ${ip} — invoking ${SCRIPT}`);
    const result = await runPromote();

    if (result.timedOut) {
      sendJson(res, 504, {
        status: "timeout",
        message: `promote script exceeded ${TIMEOUT_MS}ms`,
        stdout_tail: result.stdout.slice(-2000),
        stderr_tail: result.stderr.slice(-2000)
      });
      return logLine(504, "timeout");
    }

    const mapped = mapExitCode(result.exitCode);
    // Record successful promotion timestamps for cooldown. "Successful" here
    // means the script terminated in a state where traffic could now route
    // here — that's exit 0 (freshly promoted) or exit 2 (already promoted).
    if (result.exitCode === 0 || result.exitCode === 2) {
      writeLastPromoteTs(Date.now());
    }

    const body = {
      status: mapped.slug,
      exit_code: result.exitCode,
      script: result.scriptJson || null,
      message: result.scriptJson ? result.scriptJson.message : undefined,
      host: result.scriptJson ? result.scriptJson.host : undefined,
      // Include stderr tail on failures so the webhook caller can diagnose
      // without SSH'ing to the box. Success responses stay minimal.
      stderr_tail: mapped.http >= 500 ? result.stderr.slice(-2000) : undefined
    };
    sendJson(res, mapped.http, body);
    return logLine(mapped.http, `exit=${result.exitCode} status=${mapped.slug}`);
  }

  // ── Anything else ──
  sendJson(res, 404, { status: "not_found" });
  logLine(404);
});

// Graceful shutdown so systemd stop/restart doesn't leave half-served requests.
function shutdown(signal) {
  console.log(`[${new Date().toISOString()}] ${signal} received — shutting down`);
  server.close(() => process.exit(0));
  // Hard kill after 10s if connections linger
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

server.listen(PORT, BIND, () => {
  console.log(`[${new Date().toISOString()}] promote-webhook listening on ${BIND}:${PORT}`);
  console.log(`  script:   ${SCRIPT}`);
  console.log(`  cooldown: ${COOLDOWN_SECONDS}s`);
  console.log(`  timeout:  ${TIMEOUT_MS}ms`);
  console.log(`  version:  ${PKG_VERSION}`);
});
