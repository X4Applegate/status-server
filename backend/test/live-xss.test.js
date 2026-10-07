"use strict";
// Live XSS tests: stored XSS through fields a non-admin manager can edit and an
// admin later views, which amounts to admin session takeover because the CSP
// allows inline script (verify.cjs findings A and B, plus the sweep after them).
//   A. hero_title was emitted raw inside an inline <script> on /dashboard/:slug
//   B. logo_image / accent_color were interpolated raw into the public
//      /api/icon/:slug SVG; group create/update now validates both (400)
//   C. group names and accent colours reached the topbar quick-nav (public
//      dashboard and /admin) through innerHTML
//   D. values stored before validation existed still render safely
//      (accent_color, logo_image, custom_css, banner link_url)
// Client-side sinks are exercised by running the page's own functions, exactly
// as the server sends them, in a vm sandbox against a stub DOM.
// Skipped unless TEST_DB_HOST is set; see scripts/test-with-db.sh.
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { skip, startApp, client, setupAdmin, query } = require("../test-support/live-app");

// A real 1x1 PNG.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const HERO_A    = "</script><script>window.__poc_hero=1</script>";
// Escaped output still contains the inert text ` data-a=&quot;1`; the
// attribute exists only if a literal `data-a="` follows whitespace.
const ACCENT_B  = '#f" data-a="1';
const LOGO_B    = 'data:image/png;base64,AAAA"/><g data-poc-logo="1"/><image href="x';
const NAME_HTML = '<img src=x onerror="window.__poc_name=1">';
const CSS_OUT   = "</style><script>window.__poc_css=1</script>";
const JS_LINK   = "javascript:window.__poc_banner=1";

/** Element names in a piece of markup, in document order. */
const elementNames = markup => [...markup.matchAll(/<([A-Za-z][\w:-]*)/g)].map(m => m[1]);

/** The literal assigned by `const NAME = …;` in a page's inline script: raw text and parsed value. */
function scriptConst(html, name) {
  const m = new RegExp(`^\\s*const ${name}\\s*=\\s*(.*);\\s*$`, "m").exec(html);
  assert.ok(m, `const ${name} = …; not found on one line`);
  return { raw: m[1], value: JSON.parse(m[1]) };
}

/** Source of one top-level function declaration in a served page's inline script. */
function extractFunction(html, name) {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(html);
  assert.ok(m, `function ${name} not found in the page`);
  let depth = 0;
  for (let i = html.indexOf("{", m.index + m[0].length); i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}" && --depth === 0) return html.slice(m.index, i + 1);
  }
  throw new Error(`function ${name} is not terminated`);
}

/** Load the named page functions into a sandbox whose document hands out stub elements. */
function sandbox(html, names, globals = {}) {
  const els = {};
  const document = {
    getElementById: id => (els[id] ||= {
      id, innerHTML: "", style: {}, dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      setAttribute() {},
    }),
  };
  const ctx = vm.createContext({ document, ...globals });
  vm.runInContext(names.map(n => extractFunction(html, n)).join("\n"), ctx);
  return { els, run: code => vm.runInContext(code, ctx) };
}

/** Assertions shared by both topbar renderers. */
function assertTopbarSafe(html) {
  assert.ok(!html.includes("<img"), `group name became markup:\n${html}`);
  assert.ok(!/\sdata-a="/.test(html), `accent_color broke out of the style attribute:\n${html}`);
  assert.ok(html.includes("&lt;img src=x onerror="), `group name should be shown as text:\n${html}`);
  // Legitimate pills still render with their link, colour and name.
  assert.ok(html.includes('href="/dashboard/brand"'), html);
  assert.ok(html.includes("background:#12ab56"), html);
  assert.match(html, /Brand Grp<\/a>/);
}

describe("live: stored XSS via group and banner fields", { skip }, () => {
  let app, admin, anon;
  const ids = {};
  const createGroup = async body => {
    const r = await admin.post("/api/admin/groups", { public_enabled: 1, ...body });
    assert.equal(r.status, 200, `create ${body.slug}: ${r.text}`);
    ids[r.json.slug] = r.json.id;
  };

  before(async () => {
    app = await startApp();
    admin = await setupAdmin(app);
    anon = client(app);
    await createGroup({ name: "Hero Grp",  slug: "hero",  hero_title: HERO_A });
    await createGroup({ name: "Calm Grp",  slug: "calm",  hero_title: "Everything is running smoothly" });
    await createGroup({ name: "Odd Grp",   slug: "odd",   hero_title: "a\u2028b\u2029c <!-- d & e" });
    await createGroup({ name: "Brand Grp", slug: "brand", accent_color: "#12ab56", logo_image: PNG });
    await createGroup({ name: "Plain Grp", slug: "plain", accent_color: "#12ab56", custom_css: ".srv-row{outline:1px solid #12ab56}" });
    await createGroup({ name: NAME_HTML,   slug: "named" });
    // Databases from before the fix can already hold hostile values: plant them directly.
    await createGroup({ name: "Legacy One", slug: "legacy1" });
    await createGroup({ name: "Legacy Two", slug: "legacy2", logo_image: PNG });
    await query(app.dbName, "UPDATE status_groups SET accent_color=?, custom_css=? WHERE slug='legacy1'", [ACCENT_B, CSS_OUT]);
    await query(app.dbName, "UPDATE status_groups SET logo_image=? WHERE slug='legacy2'", [LOGO_B]);
  });
  after(async () => { if (app) await app.destroy(); });

  test("A: hero_title cannot break out of the dashboard's inline <script>", async () => {
    const r = await anon.get("/dashboard/hero");
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes(HERO_A), "the raw breakout string is in the page");
    assert.ok(!r.text.includes("<script>window.__poc_hero=1"), "the injected <script> is in the page");
    const hero = scriptConst(r.text, "HERO_TITLE");
    assert.ok(!/[<>]/.test(hero.raw), hero.raw);
    assert.equal(hero.value, HERO_A, "the title must still reach the page, as text");
  });

  test("A: JSON in inline scripts also escapes &, U+2028 and U+2029", async () => {
    const hero = scriptConst((await anon.get("/dashboard/odd")).text, "HERO_TITLE");
    assert.ok(!/[<>&\u2028\u2029]/.test(hero.raw), JSON.stringify(hero.raw));
    assert.equal(hero.value, "a\u2028b\u2029c <!-- d & e");
  });

  test("A: a normal hero title still renders", async () => {
    const r = await anon.get("/dashboard/calm");
    assert.equal(r.status, 200);
    assert.equal(scriptConst(r.text, "HERO_TITLE").value, "Everything is running smoothly");
  });

  test("B: group create and update reject a malformed accent_color or logo_image with 400", async () => {
    const bad = [
      { accent_color: ACCENT_B }, { accent_color: "red" }, { accent_color: "#12345" }, { accent_color: "#12ab56;x:y" },
      { logo_image: LOGO_B }, { logo_image: "javascript:alert(1)" }, { logo_image: "http://example.com/logo.png" },
      { logo_image: "data:image/svg+xml;base64,PHN2Zy8+" }, { logo_image: 'https://example.com/a.png" onerror="x' },
    ];
    for (const fields of bad) {
      const want = "accent_color" in fields ? /accent/i : /logo/i;
      const c = await admin.post("/api/admin/groups", { name: "Bad Grp", slug: "bad-grp", public_enabled: 1, ...fields });
      assert.equal(c.status, 400, `create with ${JSON.stringify(fields)} -> ${c.status} ${c.text}`);
      assert.match(c.json.error, want);
      const u = await admin.put(`/api/admin/groups/${ids.calm}`, { name: "Calm Grp", slug: "calm", public_enabled: 1, ...fields });
      assert.equal(u.status, 400, `update with ${JSON.stringify(fields)} -> ${u.status} ${u.text}`);
      assert.match(u.json.error, want);
    }
    assert.equal((await anon.get("/api/icon/bad-grp")).status, 404, "a rejected group must not be stored");
  });

  test("B: valid accent colours and logo images are accepted", async () => {
    const good = [
      { accent_color: "#abc" }, { accent_color: "#12AB56" }, { accent_color: "#12ab56cc" }, { accent_color: "" },
      { logo_image: PNG }, { logo_image: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==" },
      { logo_image: "data:image/webp;base64,UklGRhIAAABXRUJQ" }, { logo_image: "https://cdn.example.com/brand/logo.png?v=2" },
    ];
    for (const [i, fields] of good.entries()) {
      const r = await admin.post("/api/admin/groups", { name: `Ok ${i}`, slug: `ok-${i}`, ...fields });
      assert.equal(r.status, 200, `${JSON.stringify(fields)} -> ${r.text}`);
    }
  });

  test("B: /api/icon escapes accent_color and logo_image already stored in the database", async () => {
    const accent = await anon.get("/api/icon/legacy1");
    assert.equal(accent.status, 200);
    assert.ok(!/\sdata-a="/.test(accent.text), `injected attribute present:\n${accent.text}`);
    assert.deepEqual(elementNames(accent.text), ["svg", "rect", "rect", "text"]);

    const logo = await anon.get("/api/icon/legacy2");
    assert.equal(logo.status, 200);
    assert.ok(!logo.text.includes('<g data-poc-logo="1"/>'), `injected element present:\n${logo.text}`);
    const names = elementNames(logo.text);
    assert.ok(!names.includes("g") && names.filter(n => n === "image").length <= 1, names.join(","));
  });

  test("B: a valid PNG logo and a normal accent colour still render in the icon", async () => {
    const logo = await anon.get("/api/icon/brand");
    assert.equal(logo.status, 200);
    assert.match(logo.headers.get("content-type"), /^image\/svg\+xml/);
    assert.ok(logo.text.includes(`<image href="${PNG}"`), logo.text.slice(0, 400));
    const plain = await anon.get("/api/icon/plain");
    assert.ok(plain.text.includes('fill="#12ab56"'), plain.text);
    assert.match(plain.text, />PL<\/text>/);
  });

  test("a valid PNG logo, accent colour and custom CSS still render on the dashboard", async () => {
    const brand = await anon.get("/dashboard/brand");
    assert.equal(brand.status, 200);
    assert.ok(brand.text.includes(`<img src="${PNG}"`), "logo <img> missing");
    assert.match(brand.text, /--blue: #12ab56;/);
    const plain = await anon.get("/dashboard/plain");
    assert.ok(plain.text.includes(".srv-row{outline:1px solid #12ab56}"), "custom CSS missing");
  });

  test("D: custom_css and accent_color stored before validation cannot escape <style>", async () => {
    const r = await anon.get("/dashboard/legacy1");
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes("<script>window.__poc_css=1"), "the injected <script> is in the page");
    assert.match(r.text, /<style id="group-custom-css">[^<]*<\/style>/);
    assert.ok(!/\sdata-a="/.test(r.text), "accent_color broke out of its context");
  });

  test("a group name containing HTML is shown escaped on the dashboard", async () => {
    const r = await anon.get("/dashboard/named");
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes(NAME_HTML), "the raw group name is in the page");
    assert.ok(r.text.includes("&lt;img src=x onerror="), "the group name should be shown as text");
  });

  test("C: the dashboard topbar renders group names and colours as text", async () => {
    const groups = (await admin.get("/api/admin/groups")).json;
    assert.ok(groups.some(g => g.name === NAME_HTML) && groups.some(g => g.accent_color === ACCENT_B));
    const page = await admin.get("/dashboard/plain");
    const { els, run } = sandbox(page.text, ["escapeHtml", "renderTopbarDashboards"],
      { GROUP_SLUG: "plain", dashboardGroups: groups });
    run("renderTopbarDashboards()");
    assertTopbarSafe(els.topbarDashboards.innerHTML);
  });

  test("C: the /admin topbar renders group names and colours as text", async () => {
    const groups = (await admin.get("/api/admin/groups")).json;
    const page = await admin.get("/admin");
    assert.equal(page.status, 200);
    const { els, run } = sandbox(page.text, ["_escHtml", "renderTopbarDashboards"], {
      isAdmin: () => true,
      fetch: async () => ({ ok: true, json: async () => groups }),
    });
    await run("renderTopbarDashboards()");
    assertTopbarSafe(els.topbarDashboards.innerHTML);
  });

  test("D: banner links must be http(s), mailto or relative, on input and on output", async () => {
    const banner = body => admin.post("/api/admin/banners", { group_id: ids.plain, link_text: "Details", ...body });
    const ok = await banner({ message: "Planned work", link_url: "https://example.com/status" });
    assert.equal(ok.status, 200, ok.text);
    for (const link_url of [JS_LINK, " JavaScript:alert(1)", "data:text/html,<script>alert(1)</script>"]) {
      const bad = await banner({ message: "Hostile", link_url });
      assert.equal(bad.status, 400, `${link_url} -> ${bad.status} ${bad.text}`);
      const upd = await admin.put(`/api/admin/banners/${ok.json.id}`, { link_url });
      assert.equal(upd.status, 400, `update ${link_url} -> ${upd.status} ${upd.text}`);
    }
    // A banner stored before validation existed must not render a script link.
    const legacy = await banner({ message: "Legacy", link_url: "https://example.com/legacy" });
    await query(app.dbName, "UPDATE status_banners SET link_url=? WHERE id=?", [JS_LINK, legacy.json.id]);
    const list = (await anon.get("/api/public/group/plain/banners")).json;
    assert.equal(list.length, 2, JSON.stringify(list));
    const page = await anon.get("/dashboard/plain");
    const { els, run } = sandbox(page.text,
      ["bannerEscape", "getDismissedBanners", "bannerKey", "iconForSeverity", "renderAdminBanners"], { list });
    run("renderAdminBanners(list)");
    const html = els.adminBanners.innerHTML;
    assert.ok(!/href="\s*javascript:/i.test(html), `script link rendered:\n${html}`);
    assert.ok(html.includes('href="https://example.com/status"'), html);
    assert.ok(html.includes("Legacy"), "the legacy banner's message should still show");
  });
});
