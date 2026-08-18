"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  serializePublicCheck,
  serializePublicGroup,
  serializePublicServer,
  serializePublicServers,
} = require("../public-status-serializer");

test("anonymous group serialization exposes branding without operator metadata", () => {
  const result = serializePublicGroup({
    id: "7",
    slug: "customer-status",
    name: "Customer Status",
    description: "Service health",
    logo_text: "CS",
    logo_image: "data:image/png;base64,AAAA",
    logo_size: 500,
    accent_color: "#123456",
    bg_color: "#ffffff",
    default_theme: "light",
    custom_domain: "private-routing.example.test",
    privacy_text: "Internal draft",
    terms_text: "Internal draft",
    created_at: "2026-08-13T17:00:00.000Z",
  });

  assert.deepEqual(result, {
    id: 7,
    slug: "customer-status",
    name: "Customer Status",
    description: "Service health",
    logo_text: "CS",
    logo_image: "data:image/png;base64,AAAA",
    logo_size: 120,
    accent_color: "#123456",
    bg_color: "#ffffff",
    default_theme: "light",
  });
  for (const forbidden of ["custom_domain", "privacy_text", "terms_text", "created_at"]) {
    assert.equal(Object.hasOwn(result, forbidden), false, `${forbidden} must not cross the public boundary`);
  }
});

test("anonymous server serialization omits infrastructure and internal polling state", () => {
  const source = {
    id: "edge-api",
    name: "Edge API",
    host: "10.20.30.40",
    description: "Customer API",
    category: "Platform",
    sub_category: "Edge",
    tags: ["customer-facing", 123],
    group_ids: [7, "8", "bad"],
    overall: "down",
    lastChecked: new Date("2026-08-13T17:00:00.000Z"),
    uptimeHistory: [true, false, 1, 0],
    maintenance: false,
    lat: 34.1,
    lng: -118.2,
    runbook: "ssh root@10.20.30.40",
    failStreak: 9,
    failure_threshold: 3,
    location_address: "Private datacenter cage 4",
    checks: [],
  };

  const result = serializePublicServer(source);

  assert.deepEqual(result, {
    id: "edge-api",
    name: "Edge API",
    description: "Customer API",
    category: "Platform",
    sub_category: "Edge",
    tags: ["customer-facing"],
    group_ids: [7, 8],
    checks: [],
    overall: "down",
    lastChecked: "2026-08-13T17:00:00.000Z",
    uptimeHistory: [true, false, true, false],
    maintenance: false,
    flapping: false,
    response_ms: null,
  });
  for (const forbidden of ["host", "lat", "lng", "runbook", "failStreak", "failure_threshold", "location_address"]) {
    assert.equal(Object.hasOwn(result, forbidden), false, `${forbidden} must not cross the public boundary`);
  }
});

test("anonymous checks expose only status, latency, and certificate expiry", () => {
  const result = serializePublicCheck({
    type: "http",
    ok: true,
    response_ms: "83",
    detail: "HTTP 200 from 10.20.30.40",
    url: "https://internal.example.test/admin?token=secret",
    host: "10.20.30.40",
    port: 8443,
    controller_id: 42,
    client_id: "client-secret-id",
    client_secret: "secret",
    credentials: { username: "admin", password: "secret" },
    cert: {
      days_left: 21,
      expires_at: "2026-09-03T17:00:00.000Z",
      subject: "internal.example.test",
      issuer: "Private Root CA",
      serialNumber: "ABC123",
    },
  });

  assert.deepEqual(result, {
    type: "http",
    ok: true,
    response_ms: 83,
    cert: {
      days_left: 21,
      expires_at: "2026-09-03T17:00:00.000Z",
    },
  });
});

test("camel-case TLS expiry is normalized without certificate identity", () => {
  assert.deepEqual(serializePublicCheck({
    type: "tls_cert",
    ok: false,
    response_ms: 12,
    cert: {
      daysLeft: -2,
      expiry: "2026-08-11T17:00:00.000Z",
      subject: "vpn.internal",
      issuer: "Internal CA",
    },
  }), {
    type: "tls_cert",
    ok: false,
    response_ms: 12,
    cert: {
      days_left: -2,
      expires_at: "2026-08-11T17:00:00.000Z",
    },
  });
});

test("public server collections are group scoped and never include ungrouped services", () => {
  const servers = [
    { id: "alpha", name: "Alpha", group_ids: [1], checks: [] },
    { id: "shared", name: "Shared", group_ids: [1, 2], checks: [] },
    { id: "beta", name: "Beta", group_ids: [2], checks: [] },
    { id: "private", name: "Private", group_ids: [], host: "10.0.0.8", checks: [] },
  ];

  assert.deepEqual(serializePublicServers(servers, { groupId: 1 }).map(server => server.id), ["alpha", "shared"]);
  assert.deepEqual(serializePublicServers(servers, { groupId: 999 }), []);
  assert.deepEqual(serializePublicServers(servers).map(server => server.id), ["alpha", "shared", "beta"]);
});

test("group API and SSE both use the shared anonymous serializer", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

  assert.match(server, /require\(["']\.\/public-status-serializer["']\)/);
  assert.match(server, /function filterServersForSseClient[\s\S]*?serializePublicServers\(all,/);
  assert.match(server, /app\.get\(["']\/api\/public\/group\/:slug["'][\s\S]*?: serializePublicServers\(matchingServers, \{ groupId: g\.id \}\)/);
  assert.match(server, /canViewInternal = Array\.isArray\(allowed\)[\s\S]*?includes\(Number\(g\.id\)\)/);
  assert.match(server, /group: canViewInternal \? g : serializePublicGroup\(g\)/);
});

test("legacy live status, logs, and refresh routes enforce operator authentication", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

  assert.match(server, /app\.get\(["']\/api\/status["'],\s*requireAuth/);
  assert.match(server, /app\.get\(["']\/api\/status["'][\s\S]*?getUserAllowedGroupIds\(req\.session\.userId, req\.session\.role\)/);
  assert.match(server, /app\.get\(["']\/api\/logs["'],\s*requireAdmin/);
  assert.match(server, /app\.post\(["']\/api\/refresh["'],\s*requireAuth/);
});
