"use strict";

function toIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function groupMaintenanceRows(rows, now = new Date()) {
  const nowMs = new Date(now).getTime();
  const grouped = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    const startIso = toIso(row.start_time);
    const endIso = toIso(row.end_time);
    if (!startIso || !endIso) continue;

    const title = String(row.title || "Scheduled maintenance").trim() || "Scheduled maintenance";
    const notes = row.notes == null ? "" : String(row.notes).trim();
    const key = JSON.stringify([title, notes, startIso, endIso]);

    if (!grouped.has(key)) {
      grouped.set(key, {
        id: Number(row.id) || String(row.id || key),
        title,
        notes,
        start_time: startIso,
        end_time: endIso,
        created_at: toIso(row.created_at) || startIso,
        services: [],
      });
    }

    const event = grouped.get(key);
    const rowId = Number(row.id);
    if (Number.isFinite(rowId) && Number.isFinite(Number(event.id))) {
      event.id = Math.min(Number(event.id), rowId);
    }

    const serverId = String(row.server_id || "");
    if (serverId && !event.services.some(service => service.id === serverId)) {
      event.services.push({
        id: serverId,
        name: String(row.server_name || serverId),
      });
    }
  }

  return [...grouped.values()]
    .map(event => {
      const startMs = new Date(event.start_time).getTime();
      const endMs = new Date(event.end_time).getTime();
      const status = nowMs > endMs ? "completed" : nowMs >= startMs ? "in_progress" : "scheduled";
      return {
        ...event,
        status,
        services: event.services.sort((a, b) => a.name.localeCompare(b.name)),
      };
    })
    .sort((a, b) => {
      const rank = { in_progress: 0, scheduled: 1, completed: 2 };
      if (a.status !== b.status) return rank[a.status] - rank[b.status];
      if (a.status === "completed") return new Date(b.end_time) - new Date(a.end_time);
      return new Date(a.start_time) - new Date(b.start_time);
    });
}

function escapeXml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function rssDate(value, fallback) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toUTCString() : fallback.toUTCString();
}

function buildStatusRss({ title, description, link, feedUrl, items, now = new Date() }) {
  const generatedAt = now instanceof Date ? now : new Date(now);
  const safeNow = Number.isFinite(generatedAt.getTime()) ? generatedAt : new Date();
  const sortedItems = [...(Array.isArray(items) ? items : [])]
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
    .slice(0, 100);

  const itemXml = sortedItems.map(item => {
    const itemLink = item.link || link;
    return `    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(itemLink)}</link>
      <guid isPermaLink="false">${escapeXml(item.guid || itemLink)}</guid>
      <pubDate>${rssDate(item.pubDate, safeNow)}</pubDate>
      <description>${escapeXml(item.description)}</description>
    </item>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(link)}</link>
    <description>${escapeXml(description)}</description>
    <language>en-us</language>
    <lastBuildDate>${safeNow.toUTCString()}</lastBuildDate>
    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />
    <ttl>15</ttl>
${itemXml}
  </channel>
</rss>`;
}

module.exports = {
  buildStatusRss,
  escapeXml,
  groupMaintenanceRows,
};
