"use strict";

// Public status responses are intentionally built from allowlists. Live check
// results can contain request URLs, ports, controller identifiers, device names,
// certificate identities, and failure details; copying those objects and then
// deleting a few known fields would make future check types easy to leak.

const PUBLIC_OVERALL_STATES = new Set(["up", "down", "degraded", "pending"]);

function publicString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function publicTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function publicLatency(value) {
  if (value === null || value === undefined || value === "") return null;
  const latency = Number(value);
  return Number.isFinite(latency) && latency >= 0 ? latency : null;
}

function serializePublicCertificate(cert) {
  if (!cert || typeof cert !== "object" || Array.isArray(cert)) return null;

  const rawDays = cert.days_left ?? cert.daysLeft;
  const days = rawDays === null || rawDays === undefined || rawDays === ""
    ? null
    : Number(rawDays);
  const expiresAt = publicTimestamp(cert.expires_at ?? cert.expiry);
  const safe = {};

  if (Number.isFinite(days)) safe.days_left = Math.trunc(days);
  if (expiresAt) safe.expires_at = expiresAt;
  return Object.keys(safe).length ? safe : null;
}

function serializePublicCheck(check) {
  const source = check && typeof check === "object" && !Array.isArray(check) ? check : {};
  const result = {
    type: publicString(source.type, "service").slice(0, 64),
    ok: source.ok === true || source.ok === 1,
  };
  const latency = publicLatency(source.response_ms);
  const cert = serializePublicCertificate(source.cert);

  if (latency !== null) result.response_ms = latency;
  if (cert) result.cert = cert;
  return result;
}

function serializePublicServer(server) {
  const source = server && typeof server === "object" && !Array.isArray(server) ? server : {};
  const groupIds = Array.isArray(source.group_ids)
    ? source.group_ids
      .map(value => Number(value))
      .filter(value => Number.isInteger(value) && value > 0)
    : [];
  const tags = Array.isArray(source.tags)
    ? source.tags.filter(value => typeof value === "string").map(value => value.slice(0, 100))
    : [];
  const uptimeHistory = Array.isArray(source.uptimeHistory)
    ? source.uptimeHistory.map(value => value === true || value === 1)
    : [];

  return {
    id: publicString(source.id),
    name: publicString(source.name),
    description: publicString(source.description),
    category: publicString(source.category),
    sub_category: publicString(source.sub_category),
    tags,
    group_ids: groupIds,
    checks: Array.isArray(source.checks) ? source.checks.map(serializePublicCheck) : [],
    overall: PUBLIC_OVERALL_STATES.has(source.overall) ? source.overall : "pending",
    lastChecked: publicTimestamp(source.lastChecked),
    uptimeHistory,
    maintenance: source.maintenance === true || source.maintenance === 1,
    flapping: source.flapping === true || source.flapping === 1,
    response_ms: publicLatency(source.response_ms),
  };
}

function serializePublicGroup(group) {
  const source = group && typeof group === "object" && !Array.isArray(group) ? group : {};
  const rawId = Number(source.id);
  const rawLogoSize = Number(source.logo_size);

  return {
    id: Number.isInteger(rawId) && rawId > 0 ? rawId : null,
    slug: publicString(source.slug),
    name: publicString(source.name),
    description: publicString(source.description),
    logo_text: publicString(source.logo_text),
    logo_image: publicString(source.logo_image) || null,
    logo_size: Number.isFinite(rawLogoSize) ? Math.max(20, Math.min(120, Math.trunc(rawLogoSize))) : 42,
    accent_color: publicString(source.accent_color, "#2a7fff"),
    bg_color: publicString(source.bg_color) || null,
    default_theme: source.default_theme === "light" ? "light" : "dark",
  };
}

// With no groupId, expose only services assigned to at least one public
// dashboard. Passing a groupId additionally scopes the payload to that exact
// dashboard, which prevents one anonymous SSE stream from inventorying others.
function serializePublicServers(servers, { groupId } = {}) {
  const list = Array.isArray(servers) ? servers : [];
  const hasGroupFilter = groupId !== undefined;
  const normalizedGroupId = Number(groupId);

  return list
    .filter(server => {
      if (!server || !Array.isArray(server.group_ids) || server.group_ids.length === 0) return false;
      if (!hasGroupFilter) return true;
      return Number.isInteger(normalizedGroupId) && server.group_ids.some(id => Number(id) === normalizedGroupId);
    })
    .map(serializePublicServer);
}

module.exports = {
  serializePublicCertificate,
  serializePublicCheck,
  serializePublicGroup,
  serializePublicServer,
  serializePublicServers,
};
