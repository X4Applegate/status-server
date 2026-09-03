"use strict";
const { test } = require("node:test");
const assert   = require("node:assert/strict");
const fs       = require("node:fs");
const path     = require("node:path");
const http     = require("node:http");
const helmet   = require("helmet");

const ROOT         = path.resolve(__dirname, "..");
const serverSource = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

// Pull the exact `directives: { ... }` object literal out of the helmet() call
// so the test exercises the real config, not a copy of it.
function helmetDirectives() {
  const start = serverSource.indexOf("app.use(helmet({");
  assert.notEqual(start, -1, "helmet() call not found");
  const dStart = serverSource.indexOf("directives: {", start);
  let depth = 0, i = serverSource.indexOf("{", dStart);
  const open = i;
  for (; i < serverSource.length; i++) {
    if (serverSource[i] === "{") depth++;
    else if (serverSource[i] === "}") { depth--; if (depth === 0) break; }
  }
  return new Function(`return (${serverSource.slice(open, i + 1)});`)();
}

function cspHeaderFor(directives) {
  return new Promise((resolve, reject) => {
    const mw = helmet({ contentSecurityPolicy: { directives } });
    const srv = http.createServer((req, res) => mw(req, res, () => res.end("ok")));
    srv.listen(0, () => {
      http.get({ port: srv.address().port, path: "/" }, (res) => {
        const csp = res.headers["content-security-policy"];
        res.resume(); srv.close(); resolve(csp);
      }).on("error", (e) => { srv.close(); reject(e); });
    });
  });
}

test("helmet CSP explicitly allows inline event-handler attributes", () => {
  const d = helmetDirectives();
  assert.deepEqual(d.scriptSrcAttr, ["'unsafe-inline'"]);
});

test("rendered CSP header does not contain script-src-attr 'none' (would block every onclick= in the views)", async () => {
  const csp = await cspHeaderFor(helmetDirectives());
  assert.ok(csp, "CSP header missing");
  assert.doesNotMatch(csp, /script-src-attr[^;]*'none'/);
  assert.match(csp, /script-src-attr 'unsafe-inline'/);
});

test("regression guard: helmet's default alone would emit script-src-attr 'none'", async () => {
  const d = helmetDirectives();
  delete d.scriptSrcAttr;
  const csp = await cspHeaderFor(d);
  assert.match(csp, /script-src-attr 'none'/);
});

test("views still rely on inline handlers, so the directive matters", () => {
  const admin = fs.readFileSync(path.join(ROOT, "views", "admin.ejs"), "utf8");
  assert.ok((admin.match(/ onclick="/g) || []).length > 50);
});
