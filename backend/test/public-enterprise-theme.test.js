"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const ejs = require("ejs");

const backendRoot = path.join(__dirname, "..");
const viewPath = path.join(backendRoot, "views", "index.ejs");
const source = fs.readFileSync(viewPath, "utf8");

function renderStatus(overrides = {}) {
  return ejs.render(source, {
    APP_HOME_URL: "/",
    APP_OWNER: "Status owner",
    APP_CONTACT: "",
    adminHref: "/admin",
    groupSlug: "example",
    groupName: "Example status",
    groupSubtitle: "Public service health",
    accentColor: "#f97316",
    bgColor: null,
    logoText: "ES",
    logoImage: null,
    logoSize: 42,
    defaultTheme: "light",
    pageTitle: "Example status",
    privacyUrl: "/privacy",
    termsUrl: "/terms",
    ...overrides,
  }, { filename: viewPath });
}

test("public status seeds the shared theme once and preserves a saved preference", () => {
  const html = renderStatus();
  const scriptStart = html.indexOf("<script>");
  const scriptEnd = html.indexOf("</script>", scriptStart);
  assert.notEqual(scriptStart, -1, "expected an inline theme bootstrap");
  assert.notEqual(scriptEnd, -1, "expected the inline theme bootstrap to close");
  const bootstrap = html.slice(scriptStart + "<script>".length, scriptEnd);
  const storage = new Map();
  const root = { dataset: { theme: "light" } };
  const context = {
    document: { documentElement: root },
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
    },
  };

  vm.runInNewContext(bootstrap, context);
  assert.equal(root.dataset.theme, "light");
  assert.equal(storage.get("status-page-theme"), "light");

  storage.set("status-page-theme", "dark");
  vm.runInNewContext(bootstrap, context);
  assert.equal(root.dataset.theme, "dark");
  assert.equal(storage.get("status-page-theme"), "dark");
});

test("custom backgrounds outrank enterprise theme surfaces", () => {
  const html = renderStatus({ bgColor: "#123456" });
  assert.match(html, /<html lang="en" data-theme="light" class="has-custom-background">/);

  const overrides = html.match(/<style id="custom-bg-overrides">([\s\S]*?)<\/style>/)[1];
  assert.match(overrides, /html\.has-custom-background\[data-theme\]/);
  assert.match(overrides, /--bg:\s+#123456\s+!important/);
  assert.match(overrides, /--surface3:\s+#[0-9a-f]{6}\s+!important/i);
  assert.match(overrides, /--input-bg:\s+#[0-9a-f]{6}\s+!important/i);
});

test("the health hero is the sole overall-health presentation", () => {
  assert.doesNotMatch(source, /healthBanner|health-banner|updateHealthBanner/);
  assert.match(source, /id="statusOverview"/);
  assert.match(source, /function updateStatusOverview\(\)/);
});
