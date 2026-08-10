"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildStatusRss, groupMaintenanceRows } = require("../public-status");

test("groupMaintenanceRows combines one multi-service maintenance window", () => {
  const rows = [
    {
      id: 8,
      server_id: "api",
      server_name: "API",
      title: "Database upgrade",
      notes: "Brief read-only period",
      start_time: "2026-08-12T16:00:00.000Z",
      end_time: "2026-08-12T17:00:00.000Z",
      created_at: "2026-08-10T12:00:00.000Z",
    },
    {
      id: 9,
      server_id: "web",
      server_name: "Website",
      title: "Database upgrade",
      notes: "Brief read-only period",
      start_time: "2026-08-12T16:00:00.000Z",
      end_time: "2026-08-12T17:00:00.000Z",
      created_at: "2026-08-10T12:00:00.000Z",
    },
  ];

  const grouped = groupMaintenanceRows(rows, "2026-08-11T16:00:00.000Z");
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].id, 8);
  assert.equal(grouped[0].status, "scheduled");
  assert.deepEqual(grouped[0].services.map(service => service.name), ["API", "Website"]);
});

test("groupMaintenanceRows puts active windows first", () => {
  const rows = [
    { id: 1, server_id: "one", server_name: "One", title: "Later", start_time: "2026-08-13T10:00:00Z", end_time: "2026-08-13T11:00:00Z" },
    { id: 2, server_id: "two", server_name: "Two", title: "Now", start_time: "2026-08-10T10:00:00Z", end_time: "2026-08-10T11:00:00Z" },
  ];

  const grouped = groupMaintenanceRows(rows, "2026-08-10T10:30:00Z");
  assert.equal(grouped[0].title, "Now");
  assert.equal(grouped[0].status, "in_progress");
});

test("groupMaintenanceRows marks past windows completed", () => {
  const grouped = groupMaintenanceRows([
    { id: 3, server_id: "api", server_name: "API", title: "Finished", start_time: "2026-08-09T10:00:00Z", end_time: "2026-08-09T11:00:00Z" },
  ], "2026-08-10T10:00:00Z");

  assert.equal(grouped[0].status, "completed");
});

test("buildStatusRss emits valid escaped RSS metadata and newest items first", () => {
  const xml = buildStatusRss({
    title: "Status & Updates",
    description: "Incidents < maintenance",
    link: "https://status.example.com",
    feedUrl: "https://status.example.com/feed.rss",
    now: new Date("2026-08-10T12:00:00Z"),
    items: [
      { title: "Older", description: "First", link: "https://status.example.com/incidents#1", guid: "incident-1", pubDate: "2026-08-09T12:00:00Z" },
      { title: "Newer", description: "A & B", link: "https://status.example.com/incidents#2", guid: "incident-2", pubDate: "2026-08-10T11:00:00Z" },
    ],
  });

  assert.match(xml, /<rss version="2\.0"/);
  assert.match(xml, /Status &amp; Updates/);
  assert.match(xml, /Incidents &lt; maintenance/);
  assert.match(xml, /A &amp; B/);
  assert.ok(xml.indexOf("Newer") < xml.indexOf("Older"));
});
