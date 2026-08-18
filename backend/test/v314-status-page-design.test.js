"use strict";
const { test } = require("node:test");
const assert   = require("node:assert/strict");
const fs       = require("node:fs");
const path     = require("node:path");

const ROOT         = path.resolve(__dirname, "..");
const serverSource = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const adminSource  = fs.readFileSync(path.join(ROOT, "views", "admin.ejs"), "utf8");
const indexSource  = fs.readFileSync(path.join(ROOT, "views", "index.ejs"), "utf8");
const serializerSource = fs.readFileSync(path.join(ROOT, "public-status-serializer.js"), "utf8");

function sourceBetween(start, end) {
  const si = serverSource.indexOf(start);
  if (si === -1) throw new Error(`Start marker not found: ${start}`);
  const ei = serverSource.indexOf(end, si);
  if (ei === -1) throw new Error(`End marker not found after start: ${end}`);
  return serverSource.slice(si, ei);
}

// ── Schema columns ────────────────────────────────────────────────────────────

test("hero_title column is added to status_groups table", () => {
  assert.match(serverSource, /ALTER TABLE status_groups ADD COLUMN hero_title/);
});

test("kicker_text column is added to status_groups table", () => {
  assert.match(serverSource, /ALTER TABLE status_groups ADD COLUMN kicker_text/);
});

test("layout column is added to status_groups table as ENUM", () => {
  assert.match(serverSource, /ALTER TABLE status_groups ADD COLUMN layout ENUM\(['"]default['"]/);
});

// ── Group INSERT includes new fields ──────────────────────────────────────────

test("group INSERT query includes hero_title, kicker_text, layout", () => {
  const route = sourceBetween(
    'app.post("/api/admin/groups"',
    'app.put("/api/admin/groups/:id"',
  );
  assert.match(route, /hero_title/);
  assert.match(route, /kicker_text/);
  assert.match(route, /layout/);
  assert.match(route, /cleanHeroTitle/);
  assert.match(route, /cleanKickerText/);
  assert.match(route, /cleanLayout/);
});

test("layout value is sanitized to default|minimal|grid in POST", () => {
  const route = sourceBetween(
    'app.post("/api/admin/groups"',
    'app.put("/api/admin/groups/:id"',
  );
  assert.match(route, /\["minimal","grid"\]\.includes.*req\.body\.layout.*\? req\.body\.layout : "default"/);
});

// ── Group UPDATE includes new fields ──────────────────────────────────────────

test("group UPDATE query includes hero_title, kicker_text, layout", () => {
  const route = sourceBetween(
    'app.put("/api/admin/groups/:id"',
    'app.delete("/api/admin/groups/:id"',
  );
  assert.match(route, /hero_title=\?/);
  assert.match(route, /kicker_text=\?/);
  assert.match(route, /layout=\?/);
});

// ── res.render passes new fields ──────────────────────────────────────────────

test("dashboard render passes heroTitle, kickerText, pageLayout", () => {
  assert.match(serverSource, /heroTitle:\s*g\.hero_title/);
  assert.match(serverSource, /kickerText:\s*g\.kicker_text/);
  assert.match(serverSource, /pageLayout:\s*g\.layout/);
});

// ── Public serializer exposes new fields ──────────────────────────────────────

test("serializePublicGroup exposes hero_title, kicker_text, layout", () => {
  assert.match(serializerSource, /hero_title:\s*publicString/);
  assert.match(serializerSource, /kicker_text:\s*publicString/);
  assert.match(serializerSource, /layout:.*\["minimal","grid"\]\.includes/);
});

// ── index.ejs uses kicker text and hero title ─────────────────────────────────

test("index.ejs kicker text uses server-supplied kickerText variable", () => {
  assert.match(indexSource, /kickerText/);
  assert.match(indexSource, /Live service health/);
});

test("index.ejs hero title JS uses HERO_TITLE constant", () => {
  assert.match(indexSource, /const HERO_TITLE/);
  assert.match(indexSource, /HERO_TITLE \|\| ["']All systems operational["']/);
});

test("index.ejs PAGE_LAYOUT constant is injected from server", () => {
  assert.match(indexSource, /const PAGE_LAYOUT/);
  assert.match(indexSource, /pageLayout/);
});

test("index.ejs includes layout-specific CSS for minimal layout", () => {
  assert.match(indexSource, /layout-minimal/);
  assert.match(indexSource, /sidebar.*display:none|\.sidebar\{display:none\}/);
});

test("index.ejs includes layout-specific CSS for grid layout", () => {
  assert.match(indexSource, /layout-grid/);
  assert.match(indexSource, /grid-template-columns.*auto-fill/);
});

// ── Admin group form has new design fields ────────────────────────────────────

test("admin group form has hero title input field", () => {
  assert.match(adminSource, /id="gHeroTitle"/);
});

test("admin group form has kicker text input field", () => {
  assert.match(adminSource, /id="gKickerText"/);
});

test("admin group form has layout select field", () => {
  assert.match(adminSource, /id="gLayout"/);
  assert.match(adminSource, /<option value="grid">/);
  assert.match(adminSource, /<option value="minimal">/);
});

test("showGroupForm populates hero_title and kicker_text from group data", () => {
  assert.match(adminSource, /gHeroTitle.*hero_title|hero_title.*gHeroTitle/);
  assert.match(adminSource, /gKickerText.*kicker_text|kicker_text.*gKickerText/);
  assert.match(adminSource, /gLayout.*layout|layout.*gLayout/);
});

test("submitGroupForm sends hero_title, kicker_text, layout in body", () => {
  assert.match(adminSource, /hero_title:.*gHeroTitle/);
  assert.match(adminSource, /kicker_text:.*gKickerText/);
  assert.match(adminSource, /layout:.*gLayout/);
});
