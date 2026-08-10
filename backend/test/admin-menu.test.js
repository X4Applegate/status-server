"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const template = fs.readFileSync(path.join(__dirname, "..", "views", "admin.ejs"), "utf8");
const helperMatch = template.match(
  /\/\/ NET_CTRL_POSITION_HELPER_START\n([\s\S]*?)\n\/\/ NET_CTRL_POSITION_HELPER_END/,
);

assert.ok(helperMatch, "Network Controller position helper must remain testable");
const getNetCtrlMenuPosition = vm.runInNewContext(`(${helperMatch[1].trim()})`);

test("Network Controller submenu uses drawer-local coordinates on wide desktops", () => {
  const position = getNetCtrlMenuPosition(
    { left: 1050, bottom: 74 },
    { left: 840, top: 0, width: 1080 },
    140,
  );

  assert.deepEqual({ ...position }, { top: 78, left: 210 });
  assert.equal(840 + position.left, 1050, "submenu should align with its viewport-space button");
});

test("Network Controller submenu remains inside the drawer near its right edge", () => {
  const position = getNetCtrlMenuPosition(
    { left: 1900, bottom: 74 },
    { left: 840, top: 0, width: 1080 },
    140,
  );

  assert.equal(position.left, 932);
  assert.equal(position.left + 140 + 8, 1080);
});

test("Network Controller submenu preserves mobile coordinates", () => {
  const position = getNetCtrlMenuPosition(
    { left: 120, bottom: 92 },
    { left: 0, top: 0, width: 390 },
    140,
  );

  assert.deepEqual({ ...position }, { top: 96, left: 120 });
});
