"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const backendRoot = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(backendRoot, relativePath), "utf8");
}

function assertHasId(source, id) {
  assert.match(
    source,
    new RegExp(`\\bid=["']${id}["']`),
    `expected template to expose #${id}`,
  );
}

const head = read("views/partials/head.ejs");
const server = read("server.js");
const dockerfile = read("Dockerfile");
const admin = read("views/admin.ejs");
const publicStatus = read("views/index.ejs");
const incidents = read("views/incidents.ejs");

test("shared enterprise assets are loaded by the head partial and served from /assets", () => {
  assert.match(head, /<link\b[^>]*href=["']\/assets\/css\/enterprise\.css["'][^>]*>/i);
  assert.match(head, /<script\b[^>]*src=["']\/assets\/js\/theme\.js["'][^>]*>/i);
  assert.match(
    server,
    /app\.use\(\s*["']\/assets["']\s*,\s*express\.static\(\s*path\.join\(\s*__dirname\s*,\s*["']public["']/,
  );
  assert.match(
    dockerfile,
    /COPY\s+--chown=node:node\s+public\s+\.\/public/,
    "expected the production image to include the shared enterprise assets",
  );
  assert.match(
    dockerfile,
    /COPY\s+--chown=node:node\s+server\.js\s+public-status\.js\s+public-status-serializer\.js\s+\.\//,
    "expected the production image to include the anonymous response serializer",
  );
});

test("admin exposes its enterprise overview contract and a persisted theme control", () => {
  for (const id of [
    "adminOverview",
    "adminHealthHeadline",
    "adminResourceGrid",
    "adminPrimaryNav",
  ]) {
    assertHasId(admin, id);
  }

  assertHasId(admin, "adminThemeToggle");
  assert.match(admin, /localStorage\.getItem\(\s*["']status-page-theme["']\s*\)/);
  assert.match(admin, /localStorage\.setItem\(\s*["']status-page-theme["']/);
});

test("admin keeps service observability inside the enterprise workspace", () => {
  assertHasId(admin, "adminServiceWorkspace");
  assertHasId(admin, "adminServiceLayout");
  assertHasId(admin, "serviceDirectory");
  assertHasId(admin, "sidebarList");
  assertHasId(admin, "mainArea");
  assert.match(admin, /async function showAdminService\(/);
  assert.match(admin, /fetch\(`\/api\/public\/\$\{path\}\/\$\{encodedId\}`\)/);
  assert.match(admin, /renderDetail\(currentServer, uptime, heartbeat, incidents, responseSeries\)/);

  const workspaceStart = admin.indexOf('id="adminServiceWorkspace"');
  const workspaceEnd = admin.indexOf("</section>", workspaceStart);
  const workspace = admin.slice(workspaceStart, workspaceEnd);
  assert.ok(workspaceStart >= 0 && workspaceEnd > workspaceStart, "expected service workspace markup");
  assert.match(workspace, /id="serviceDirectory"[\s\S]*id="sidebarList"[\s\S]*id="mainArea"/);
  assert.doesNotMatch(workspace, /role="dialog"|aria-modal="true"/);
  assert.doesNotMatch(workspace, /Manage services|openManagementTab\(['"]servers['"]\)/);

  assert.match(admin, /\.admin-service-layout\{display:grid;/);
  assert.match(admin, /@media\(max-width:980px\)\{[\s\S]*?\.admin-service-layout\{grid-template-columns:1fr\}/);
  assert.match(admin, /return `<button class="srv-row/);
  assert.match(admin, /data-service-id="\$\{_escHtml\(s\.id\)\}"/);
  assert.match(admin, /aria-current="true"/);
  assert.match(admin, /window\.scrollTo\(\{ top:0, behavior:"auto" \}\)/);
  assert.doesNotMatch(admin, /serviceWorkspace\?\.scrollIntoView/);
  assert.match(admin, /function cacheClearServiceObservability\(/);
  assert.doesNotMatch(admin, /function hydrateFromCache\(\)/);
  assert.doesNotMatch(
    admin,
    /\.sidebar(?:\s*,[^\{]+)?\s*\{[^}]*display\s*:\s*none/,
    "the on-page service directory must not be hidden by an enterprise override",
  );
  assert.doesNotMatch(
    admin,
    /\.service-directory\s*\{[^}]*display\s*:\s*none/,
    "the permanent service directory itself must remain visible",
  );
});

test("admin keeps incident and maintenance browsing in responsive on-page workspaces", () => {
  for (const id of [
    "adminIncidentWorkspace",
    "incidentDirectoryList",
    "incidentDetail",
    "adminMaintenanceWorkspace",
    "maintenanceDirectoryList",
    "maintenanceDetail",
  ]) assertHasId(admin, id);

  const incidentStart = admin.indexOf('id="adminIncidentWorkspace"');
  const incidentEnd = admin.indexOf('</section>', incidentStart);
  const incidentWorkspace = admin.slice(incidentStart, incidentEnd);
  assert.match(incidentWorkspace, /id="incidentDirectoryList"[\s\S]*id="incidentDetail"/);
  assert.doesNotMatch(incidentWorkspace, /role="dialog"|aria-modal="true"/);

  const maintenanceStart = admin.indexOf('id="adminMaintenanceWorkspace"');
  const maintenanceEnd = admin.indexOf('</section>', maintenanceStart);
  const maintenanceWorkspace = admin.slice(maintenanceStart, maintenanceEnd);
  assert.match(maintenanceWorkspace, /id="maintenanceDirectoryList"[\s\S]*id="maintenanceDetail"/);
  assert.doesNotMatch(maintenanceWorkspace, /role="dialog"|aria-modal="true"/);

  assert.match(admin, /\.admin-record-layout\{display:grid;/);
  assert.match(admin, /@media\(max-width:980px\)\{[\s\S]*?\.admin-record-layout(?:,[^{]+)?\{grid-template-columns:1fr\}/);
  assert.match(admin, /data-nav-view="incidents" onclick="showAdminIncidents\(\)"/);
  assert.match(admin, /data-nav-view="maintenance" onclick="showAdminMaintenance\(\)"/);
  assert.match(admin, /function showAdminWorkspace\(name\)/);
  assert.match(admin, /button\.setAttribute\("aria-current", "page"\)/);
});

test("record workspaces escape dynamic values, preserve selection, and keep mutations focused", () => {
  assert.match(admin, /return `<button class="record-row\$\{active \? " active" : ""\}" type="button" data-incident-id="\$\{_escHtml\(incident\.id\)\}"/);
  assert.match(admin, /_escHtml\(_incidentTitle\(incident\)\)/);
  assert.match(admin, /_escHtml\(window\.title \|\| "Maintenance"\)/);
  assert.match(admin, /_escHtml\(window\.notes \|\| "No customer-facing notes were provided\."\)/);
  assert.match(admin, /cacheSet\("selected-incident-id", match\.id\)/);
  assert.match(admin, /cacheSet\("selected-maintenance-id", match\.id\)/);
  assert.match(admin, /filtered\.length && !filtered\.some\(incident => String\(incident\.id\) === String\(selectedIncidentId\)\)/);
  assert.match(admin, /filtered\.length && !filtered\.some\(window => String\(window\.id\) === String\(selectedMaintenanceId\)\)/);
  assert.match(admin, /const requestId = \+\+incidentWorkspaceRequest/);
  assert.match(admin, /if \(requestId !== incidentWorkspaceRequest\) return/);
  assert.match(admin, /const requestId = \+\+maintenanceWorkspaceRequest/);
  assert.match(admin, /if \(requestId !== maintenanceWorkspaceRequest\) return/);
  assert.match(admin, /No maintenance windows match this filter\.[\s\S]*renderMaintenanceWorkspaceDetail\(null\)/);
  assert.match(admin, /No incidents match this filter\.[\s\S]*showIncidentPanel\(null\)/);
  assert.match(admin, /const updateComposer = canMutate && isOpen \?/);
  assert.match(admin, /Read-only access: incident details and updates are visible/);
  assert.match(admin, /for="incNewStatus"/);
  assert.match(admin, /for="incNewMsg"/);
  assert.match(admin, /for="incTitle"/);
  assert.match(admin, /for="incImpact"/);
  assert.match(admin, /for="incPublic"/);
  assert.match(admin, /async function openMaintenanceEditor\(id\)[\s\S]*showAdminWorkspace\("maintenance"\)[\s\S]*showMaintForm\(match\)/);
  assert.match(admin, /await loadIncidentWorkspace\(id\)/);
  assert.match(admin, /await loadMaintenanceWorkspace\(id \|\| null\)/);
  assert.match(admin, /syncLiveMaintenanceFlags\(\)/);
  assert.match(admin, /servers = reconcileLiveMaintenanceFlags\(servers, overviewMaintenance\)/);
  assert.doesNotMatch(admin, /renderMaintenanceWorkspaceDirectory\(\);\s*renderMaintenanceWorkspaceDetail\(adminMaint/);
  assert.doesNotMatch(admin, /renderIncidentWorkspaceDirectory\(\);\s*showIncidentPanel\(selectedIncidentId\)/);
  assert.match(admin, /Multi-service schedule\./);
  assert.match(admin, /start_time: startDate\.toISOString\(\), end_time: endDate\.toISOString\(\)/);
  assert.doesNotMatch(admin, /askDelMaint\([^)]*,\s*['"]\$\{/);
});

test("maintenance workspace preserves authenticated, grant-scoped viewer actions", () => {
  const routeStart = server.indexOf("// ── Maintenance Windows");
  const routeEnd = server.indexOf("// Update own profile", routeStart);
  const routes = server.slice(routeStart, routeEnd);
  assert.match(routes, /app\.get\("\/api\/admin\/maintenance", requireAuth/);
  assert.match(routes, /app\.post\("\/api\/admin\/maintenance", requireAuth/);
  assert.match(routes, /app\.put\("\/api\/admin\/maintenance\/:id", requireAuth/);
  assert.match(routes, /app\.delete\("\/api\/admin\/maintenance\/:id", requireAuth/);
  assert.match(routes, /allowedServerIdsFor\(req\.session\)/);
  assert.match(admin, /onclick="openNewMaintenance\(\)"/);
  assert.match(admin, /onclick="openMaintenanceEditor\(this\.dataset\.maintenanceId\)"/);
  assert.match(admin, /onclick="askDelMaint\(this\.dataset\.maintenanceId\)"/);
});

test("admin isolates authenticated caches and escapes service management values", () => {
  assert.match(admin, /function sessionCacheFingerprint\(session\)/);
  assert.match(admin, /return `\$\{session\.username \|\| ""\}\|\$\{session\.role \|\| "viewer"\}\|\$\{groups\}`/);
  assert.match(admin, /sessionStorage\.getItem\("sm-session-fingerprint"\)/);
  assert.match(admin, /function scopedCachePrefix\(\)/);
  assert.match(admin, /sessionStorage\.getItem\(prefix \+ key\)/);
  assert.match(admin, /function cacheClearLegacyPersistentCaches\(\)/);

  assert.match(admin, /<div class="admin-name">\$\{_escHtml\(s\.name\)\}<\/div>/);
  assert.match(admin, /<div class="admin-host">\$\{_escHtml\(s\.host\)\}/);
  assert.match(admin, /data-service-id="\$\{serviceId\}" onclick="showServerForm\(findAdminServer\(this\.dataset\.serviceId\)\)"/);
  assert.match(admin, /event\.target===event\.currentTarget&&\(event\.key==='Enter'/);
  assert.match(admin, /categoryHints"\)\.innerHTML = cats\.map\(c => `<option value="\$\{_escHtml\(c\)\}">`\)/);
  assert.match(admin, /value="\$\{_escHtml\(ck\.url\|\|""\)\}"/);
  assert.match(admin, /value="\$\{_escHtml\(ck\.command\|\|""\)\}"/);
  assert.match(admin, /_escHtml\(ck\.device_name \|\| ck\.device_mac \|\| "Unknown device"\)/);
  assert.match(admin, /<optgroup label="\$\{_escHtml\(group\.name\)\}">/);
  assert.doesNotMatch(admin, /value="\$\{ck\.url\|\|""\}"/);
  assert.doesNotMatch(admin, /value="\$\{ck\.command\|\|""\}"/);
  assert.doesNotMatch(admin, /adminServers\.find\(x=>x\.id==='\$\{s\.id\}'\)/);
});

test("admin overview distinguishes unavailable data and groups maintenance windows", () => {
  assert.match(admin, /overviewIncidents = null/);
  assert.match(admin, /Incident data unavailable/);
  assert.match(admin, /Maintenance data unavailable/);
  assert.match(admin, /const groupedWindows = new Map\(\)/);
  assert.match(admin, /value !== null && value !== undefined/);
  assert.match(admin, /setInterval\(\(\) => \{ if \(sessionRole\) hydrateAdminOverview\(\); \}, 60000\)/);
});

test("admin incident and overlay controls respect roles and dialog semantics", () => {
  assert.match(admin, /const canMutate = isAdmin\(\)/);
  assert.match(admin, /Read-only access: incident details and updates are visible/);
  assert.match(admin, /role="dialog" aria-modal="true" aria-labelledby="adminDrawerTitle"/);
  assert.match(admin, /event\.key === "Escape"/);
  assert.match(admin, /_drawerReturnFocus/);
  assert.match(admin, /adminWorkspaceFocusIds/);
  assert.match(admin, /adminMaintenanceWorkspaceTitle" tabindex="-1"/);
  assert.match(admin, /closeAdminToWorkspace\('maintenance'\)/);
  assert.match(admin, /_drawerReturnFocus = document\.getElementById\(adminWorkspaceFocusIds\[name\]\)/);
});

test("public status page exposes enterprise resources, incidents, and footer", () => {
  assertHasId(publicStatus, "statusResourceCenter");
  assertHasId(publicStatus, "incidentSummary");
  assert.match(
    publicStatus,
    /class=["'][^"']*\benterprise-footer\b[^"']*["']/,
    "expected the public page to render the shared enterprise footer",
  );
  assert.match(publicStatus, /fetchDetailEndpoint\(`\/api\/public\/response\/\$\{id\}`/);
  assert.match(publicStatus, /responseSeries\.map\(point =>/);
  assert.match(publicStatus, /value !== null && value !== undefined && value !== ""/);
});

test("incident history uses the shared head and enterprise theme control", () => {
  assert.match(incidents, /include\(\s*["']partials\/head["']/);
  assert.match(
    incidents,
    /<button\b[^>]*\bdata-enterprise-theme-toggle(?:=["'][^"']*["'])?[^>]*>/i,
  );
});
