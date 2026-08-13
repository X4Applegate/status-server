"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const admin = fs.readFileSync(path.join(__dirname, "..", "views", "admin.ejs"), "utf8");

function assertHasId(id) {
  assert.match(admin, new RegExp(`\\bid=["']${id}["']`), `expected admin UI to expose #${id}`);
}

function assertLabelFor(id) {
  assertHasId(id);
  assert.match(
    admin,
    new RegExp(`<label\\b[^>]*\\bfor=["']${id}["'][^>]*>`, "i"),
    `expected a visible label associated with #${id}`,
  );
}

function sliceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.ok(startIndex >= 0, `expected to find ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(endIndex > startIndex, `expected to find ${end} after ${start}`);
  return source.slice(startIndex, endIndex);
}

test("Communication and Platform browse in a permanent management workspace", () => {
  for (const id of [
    "adminManagementWorkspace",
    "adminManagementWorkspaceTitle",
    "adminManagementPanelHost",
    "managementDirectoryTitle",
    "adminManagementDetail",
    "adminManagementDetailContent",
    "adminManagementAuxHost",
  ]) assertHasId(id);

  const workspace = sliceBetween(admin, 'id="adminManagementWorkspace"', "</section>");
  assert.match(workspace, /id="adminManagementWorkspaceTitle"[^>]*tabindex="-1"/);
  assert.match(workspace, /id="adminManagementPanelHost"/);
  assert.doesNotMatch(workspace, /role="dialog"|aria-modal="true"/);

  assert.match(admin, /management\s*:\s*["']adminManagementWorkspace["']/);
  assert.match(admin, /management\s*:\s*["']adminManagementWorkspaceTitle["']/);
  assert.match(admin, /\.admin-management-layout\s*\{[^}]*display\s*:\s*grid/i);
});

test("Communication and Platform rail entries target on-page management tabs", () => {
  const rail = sliceBetween(admin, 'id="adminPrimaryNav"', "</aside>");
  const expectedTabs = [
    "groups",
    "banners",
    "webhooks",
    "omada",
    "unifi",
    "square",
    "users",
    "apikeys",
    "audit",
    "settings",
  ];

  for (const tab of expectedTabs) {
    const tag = rail.match(new RegExp(`<button\\b[^>]*\\bdata-nav-tab=["']${tab}["'][^>]*>`, "i"))?.[0];
    assert.ok(tag, `expected a primary-rail entry for ${tab}`);
    assert.match(tag, /onclick=["'][^"']*openManagementTab\(/i, `${tab} must use the on-page management navigator`);
  }

  assert.match(rail, /data-nav-tab=["'](?:omada|unifi)["']/);
  assert.doesNotMatch(rail, /openDrawer\(\s*["']adminDrawer["']\s*\)/);
});

test("management navigation docks the list instead of opening the drawer", () => {
  assert.match(admin, /function ensureManagementWorkspaceDocked\(\)/);
  const implementation = sliceBetween(
    admin,
    "async function openManagementTab(",
    "async function closeAdminToWorkspace(",
  );

  assert.match(implementation, /showAdminWorkspace\(\s*["']management["']\s*\)/);
  assert.match(implementation, /ensureManagementWorkspaceDocked\(\)/);
  assert.doesNotMatch(implementation, /openDrawer\s*\(/);

  assert.match(
    admin,
    /adminManagementPanelHost[\s\S]{0,1800}(?:aListView|adminListView)|(?:aListView|adminListView)[\s\S]{0,1800}adminManagementPanelHost/,
    "expected the legacy management list to be docked in the main workspace",
  );
});

test("management navigation uses a unique generation so stale tab loads cannot win", () => {
  assert.match(admin, /let managementLoadGeneration\s*=\s*0/);
  assert.match(admin, /function managementLoadIsCurrent\(tab, generation = managementLoadGeneration\)/);

  const navigation = sliceBetween(
    admin,
    "async function openManagementTab(",
    "async function closeAdminToWorkspace(",
  );
  assert.match(navigation, /const generation\s*=\s*\+\+managementLoadGeneration/);
  assert.match(navigation, /await switchTab\(tab, generation\)/);
  assert.match(navigation, /if \(managementLoadIsCurrent\(tab, generation\)\)/);

  const workspaceSwitch = sliceBetween(admin, "function showAdminWorkspace(", "function showAdminOverview(");
  assert.match(workspaceSwitch, /currentAdminWorkspace === ["']management["']/);
  assert.match(workspaceSwitch, /nextWorkspace !== ["']management["']/);
  assert.match(workspaceSwitch, /managementLoadGeneration \+= 1/);

  const helperSource = admin.match(/function managementLoadIsCurrent\(tab, generation = managementLoadGeneration\)\{[\s\S]*?\n\}/)?.[0];
  assert.ok(helperSource, "expected the generation predicate to remain independently testable");
  const helper = new Function(
    "managementLoadGeneration",
    "currentAdminWorkspace",
    "currentTab",
    `${helperSource}; return managementLoadIsCurrent;`,
  )(3, "management", "groups");
  assert.equal(helper("groups", 1), false, "the first A load must lose after A → B → A");
  assert.equal(helper("banners", 2), false, "the intervening B load must lose to the final A");
  assert.equal(helper("groups", 3), true, "only the newest A load may render");
});

test("management dispatcher and every async directory loader carry the generation guard", () => {
  const dispatcher = sliceBetween(admin, "async function switchTab(", "// ── Drawer stat bar");
  assert.match(dispatcher, /switchTab\(tab, managementGeneration = managementLoadGeneration\)/);
  assert.match(dispatcher, /await ensureGroupsLoaded\(\)[\s\S]{0,180}!managementLoadIsCurrent\(tab, managementGeneration\)/);

  const dispatches = {
    groups: /loadGroupList\(managementGeneration\)/,
    omada: /loadOmadaList\(managementGeneration\)/,
    unifi: /loadUnifiList\(managementGeneration\)/,
    square: /loadSquareList\(managementGeneration\)/,
    banners: /loadBannerList\(managementGeneration\)/,
    apikeys: /loadApiKeyList\(managementGeneration\)/,
    users: /loadUserList\(managementGeneration\)/,
    settings: /loadSettings\(managementGeneration\)/,
    audit: /loadAuditLog\(false, managementGeneration\)/,
    webhooks: /loadWebhookList\(managementGeneration\)/,
  };
  for (const [tab, pattern] of Object.entries(dispatches)) {
    assert.match(dispatcher, pattern, `expected ${tab} to receive the active generation`);
  }

  const loaders = [
    ["users", "loadUserList", "// ── User form"],
    ["settings", "loadSettings", "async function saveWeeklyReportSettings"],
    ["webhooks", "loadWebhookList", "function updateWebhookUrlHint"],
    ["groups", "loadGroupList", "function renderGroupServerPicker"],
    ["unifi", "loadUnifiList", "function renderUnifiList"],
    ["omada", "loadOmadaList", "async function showOmadaForm"],
    ["square", "loadSquareList", "async function showSquareForm"],
    ["banners", "loadBannerList", "async function _bnEnsureGroupsLoaded"],
    ["apikeys", "loadApiKeyList", "function showApiKeyForm"],
    ["audit", "loadAuditLog", "// ── Panel scroll buttons"],
  ];
  for (const [tab, name, end] of loaders) {
    const implementation = sliceBetween(admin, `async function ${name}(`, end);
    assert.match(implementation, /generation = managementLoadGeneration/);
    const checks = implementation.match(new RegExp(`managementLoadIsCurrent\\(["']${tab}["'], generation\\)`, "g")) || [];
    assert.ok(checks.length >= 2, `${name} must guard both initial and post-await rendering`);
  }
});

test("legacy drawer tabs and scroll affordances do not reappear in the on-page workspace", () => {
  assert.match(
    admin,
    /\.admin-management(?:-workspace|-panel)[^{]*\s+\.admin-tabs\s*\{[^}]*display\s*:\s*none/i,
  );
  assert.match(
    admin,
    /\.admin-management(?:-workspace|-panel)[^{]*\s+\.panel-scroll-btn\s*\{[^}]*display\s*:\s*none/i,
  );
});

test("controller site browsers are docked on-page while focused editors remain dialogs", () => {
  assertHasId("aOmadaSitesView");
  assertHasId("aUnifiSitesView");
  assert.match(
    admin,
    /adminManagementAuxHost[\s\S]{0,2600}aOmadaSitesView[\s\S]{0,2600}aUnifiSitesView|aOmadaSitesView[\s\S]{0,2600}aUnifiSitesView[\s\S]{0,2600}adminManagementAuxHost/,
    "expected Omada and UniFi site browsers to share the main management host",
  );

  assert.match(admin, /id="adminDrawer"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(admin, /id="aOmadaFormView"/);
  assert.match(admin, /id="aUnifiFormView"/);
});

test("management workspace has a mobile layout contract", () => {
  assert.match(
    admin,
    /@media\(max-width:980px\)\{[\s\S]*?\.admin-management(?:-workspace|-panel)/,
    "expected management content to adapt alongside the other on-page workspaces",
  );
});

test("management records are searchable, escaped, and selection-safe", () => {
  for (const fn of [
    "onManagementSearch",
    "clearManagementSearch",
    "managementRowMarkup",
    "syncManagementSelection",
    "selectManagementRecord",
    "renderManagementRecordDetail",
  ]) assert.match(admin, new RegExp(`function ${fn}\\(`), `expected ${fn}()`);

  const rowMarkup = sliceBetween(
    admin,
    "function managementRowMarkup(",
    "function syncManagementSelection(",
  );
  assert.match(rowMarkup, /return `<button class="admin-server-item management-record-row/);
  assert.match(rowMarkup, /data-management-tab="\$\{_escHtml\(tab\)\}"/);
  assert.match(rowMarkup, /data-management-id="\$\{_escHtml\(id\)\}"/);
  for (const value of ["title", "meta", "detail", "badge"]) {
    assert.match(rowMarkup, new RegExp(`_escHtml\\(${value}`), `expected ${value} to be escaped`);
  }
  assert.match(rowMarkup, /aria-current="true"/);

  assert.match(admin, /currentTab === ["']settings["']\) renderSettingsDirectory\(\)/);
  assert.match(admin, /MANAGEMENT_SETTING_SECTIONS\.filter/);
  assert.match(admin, /No settings sections match this search\./);

  const selection = sliceBetween(
    admin,
    "function syncManagementSelection(",
    "function selectManagementRecord(",
  );
  assert.match(selection, /if \(!filtered\.length\)/);
  assert.match(selection, /resetManagementDetail\(/);

  assert.match(
    admin,
    /!isAdmin\(\)[\s\S]{0,180}\[[^\]]*["']omada["'][^\]]*["']unifi["'][^\]]*["']square["']/,
    "viewer-safe UniFi records must stay reachable from their visible rail entry",
  );
  assert.doesNotMatch(admin, /showGroupForm\(adminGroups\[\$\{idx\}\]\)/);
  assert.doesNotMatch(admin, /showUserForm\(users\[\$\{idx\}\]\)/);
});

test("Communication and Platform focused forms explicitly associate labels with controls", () => {
  const controls = {
    users: ["uName", "uRole", "uFirstName", "uLastName", "uEmail", "uPassword"],
    omada: ["oName", "oUrl", "oClientId", "oClientSecret", "oVerifyTls"],
    unifi: ["ufName", "ufUrl", "ufUsername", "ufPassword", "ufApiKey", "ufVerifyTls"],
    square: ["sqName", "sqEnv", "sqAppId", "sqToken"],
    announcements: ["bnMessage", "bnTitle", "bnSeverity", "bnGroupId", "bnLinkUrl", "bnLinkText", "bnStartsAt", "bnEndsAt", "bnActive", "bnDismissible"],
    statusPages: ["gName", "gSlug", "gDesc", "gLogoFile", "gLogoSize", "gLogo", "gColor", "gBgColor", "gBgColorEnabled", "gPublicEnabled", "gCustomDomain", "gPrivacyText", "gTermsText"],
    webhooks: ["wName", "wUrl", "wFormat", "wGroup", "wEnabled", "wOnDown", "wOnRecovery"],
    settings: ["setSmtpHost", "setSmtpPort", "setSmtpUser", "setSmtpPass", "setSmtpFrom", "setSmtpSecure", "setTsEnabled", "setTsSiteKey", "setTsSecretKey", "setGoEnabled", "setGoClientId", "setGoClientSecret", "setGoCallbackUrl", "setMbToken", "setWrEnabled", "setWrRecipients"],
  };

  for (const [section, ids] of Object.entries(controls)) {
    for (const id of ids) {
      assert.doesNotThrow(() => assertLabelFor(id), `${section} must label #${id}`);
    }
  }

  for (const [picker, label] of [
    ["uGroupsPicker", "uGroupsLabel"],
    ["oGroupPicker", "oGroupPickerLabel"],
    ["ufGroupPicker", "ufGroupPickerLabel"],
    ["sqGroupPicker", "sqGroupPickerLabel"],
    ["gServerPicker", "gServerPickerLabel"],
  ]) {
    assert.match(
      admin,
      new RegExp(`id=["']${picker}["'][^>]*role=["']group["'][^>]*aria-labelledby=["']${label}["']`),
      `expected #${picker} to expose its visible group label`,
    );
  }
});

test("API key generation uses the focused accessible editor", () => {
  for (const id of ["aApiKeyFormView", "akName", "akScope", "akResult", "akGeneratedKey"]) assertHasId(id);
  assert.match(admin, /\[hidden\]\{display:none!important\}/);
  assert.match(admin, /openAdminEditorDrawer\(["']aApiKeyFormView["']/);
  assert.match(admin, /<label class="flabel" for="akName">/);
  assert.match(admin, /<label class="flabel" for="akScope">/);
  assert.match(admin, /id="akGeneratedKey"[^>]*readonly/);
  const implementation = sliceBetween(admin, "function showApiKeyForm()", "async function askDelApiKey(");
  assert.doesNotMatch(implementation, /\bprompt\s*\(|\bconfirm\s*\(/);
  assert.doesNotMatch(implementation, /document\.body\.appendChild\(box\)/);
  assert.match(implementation, /navigator\.clipboard\.writeText/);
  assert.match(admin, /activeDrawer === ["']adminDrawer["']\) closeAdmin\(\)/);
});

test("integration site browsers move focus into the on-page browser and restore it on Back", () => {
  assert.match(admin, /id="oSitesHeading"[^>]*data-management-aux-focus[^>]*tabindex="-1"/);
  assert.match(admin, /id="ufSitesHeading"[^>]*data-management-aux-focus[^>]*tabindex="-1"/);
  assert.match(admin, /onclick="closeManagementAux\(\)"[^>]*>\s*(?:←|&#8592;) Back to controllers/);

  const showAux = sliceBetween(admin, "function showManagementAux(", "function closeManagementAux(");
  assert.match(showAux, /managementAuxReturnFocus\s*=\s*document\.activeElement/);
  assert.match(showAux, /querySelector\(["']\[data-management-aux-focus\]["']\)\?\.focus/);

  const closeAux = sliceBetween(admin, "function closeManagementAux(", "function resetManagementDetail(");
  assert.match(closeAux, /returnTarget\.getClientRects\(\)\.length/);
  assert.match(closeAux, /management-record-row\.active/);
  assert.match(closeAux, /target\?\.focus/);

  const omadaDevices = sliceBetween(admin, "async function showOmadaDevices(", "// One-click: create a server entry");
  assert.match(omadaDevices, /heading\.focus\(\{ preventScroll:true \}\)/);
  const unifiDevices = sliceBetween(admin, "async function showUnifiDevices(", "function appendUnifiAction(");
  assert.match(unifiDevices, /heading\.focus\(\{ preventScroll:true \}\)/);
});

test("UniFi site actions open the service editor with valid checks and return to the browser", () => {
  const flow = sliceBetween(admin, "async function openUnifiServiceEditor(", "// ── Omada Controllers");
  assert.match(flow, /await showServerForm\(null\)/);
  assert.match(flow, /renderCrows\(\)/);
  assert.doesNotMatch(flow, /switchTab\(\s*["']servers["']\s*\)|renderCheckRows\(/);
  for (const type of ["unifi_gateway", "unifi_wan", "unifi_client_count", "unifi_device"]) {
    assert.match(flow, new RegExp(`openUnifiServiceEditor\\(["']${type}["']`));
  }
  assert.match(admin, /async function populateUnifiSitePicker\(i\)/);

  const showList = sliceBetween(admin, "async function showList(", "function renderCrows(");
  assert.match(showList, /unifi-sites/);
  assert.match(showList, /unifi-devices/);
  assert.match(showList, /await showUnifiSites\(/);
  assert.match(showList, /await showUnifiDevices\(/);
});

test("Square delete failures use the shared toast notifier", () => {
  const removeSquare = sliceBetween(admin, "async function askDelSquare(", "// ── Maintenance Windows");
  assert.match(removeSquare, /toast\(data\.error \|\| "Delete failed", "error"\)/);
  assert.match(removeSquare, /toast\(e\.message, "error"\)/);
  assert.doesNotMatch(removeSquare, /showToast\(/);
});

test("Square duplication creates a fresh editable model without shared-record state", () => {
  const form = sliceBetween(admin, "async function showSquareForm(", "async function submitSquareForm(");
  assert.match(form, /const editing = !!a\?\.id/);
  assert.match(form, /editing \? "Edit Square account" : "Add Square account"/);
  const duplicate = sliceBetween(admin, "function dupSquare(", "async function askDelSquare(");
  assert.match(duplicate, /application_id:/);
  assert.match(duplicate, /environment:/);
  assert.match(duplicate, /group_ids:/);
  assert.doesNotMatch(duplicate, /showSquareForm\(\{\s*\.\.\.a/);
  assert.doesNotMatch(duplicate, /shared_outside_scope/);
});

test("UniFi editor uses the shared scoped group store and protects shared viewer records", () => {
  const form = sliceBetween(admin, "async function showUnifiForm(", "async function submitUnifiForm(");
  assert.match(form, /await ensureGroupsLoaded\(\)/);
  assert.doesNotMatch(form, /\bloadGroups\(/);
  assert.match(form, /sessionAllowedGroupIds/);
  assert.match(form, /visibleGroups/);
  assert.match(form, /shared_outside_scope/);
  assert.match(form, /Only an admin can edit a controller shared with other status pages/);

  const detail = sliceBetween(admin, "function renderManagementRecordDetail(", "function askDelGroupById(");
  assert.match(detail, /viewerReadOnly\s*=\s*!isAdmin\(\)\s*&&\s*!!record\.shared_outside_scope/);
  assert.match(detail, /You can browse sites, but only an admin can edit or remove it/);
});

test("shared viewer integrations remain browse-only without exposing destructive actions", () => {
  assert.match(admin, /tab === ["']square["'][\s\S]{0,180}shared_outside_scope/);
  assert.match(admin, /only an admin can edit or remove the shared account/i);
  assert.match(admin, /async function showOmadaForm\(c\)[\s\S]{0,180}c\?\.shared_outside_scope/);
  assert.match(admin, /async function showSquareForm\(a\)[\s\S]{0,180}a\?\.shared_outside_scope/);
});
