import assert from "node:assert/strict";
import { test } from "node:test";
import { mapLogicalToStream, mapRectToStream, mappingScale, pickMonitor, type MonitorInfo, type SurfaceGeometry } from "../mapping.js";

const monitor: MonitorInfo = {
  name: "HDMI-A-1",
  x: 0,
  y: 0,
  width: 3840,
  height: 2160,
  scale: 1.5,
};

const geometry: SurfaceGeometry = {
  source: { width: 3840, height: 2160 },
  encoded: { width: 3840, height: 2160 },
  origin: { x: 0, y: 0 },
};

test("mappingScale follows source.width / (monitor.width / monitor.scale)", () => {
  assert.equal(mappingScale(geometry.source.width, monitor), 1.5);
});

test("logical point maps to stream pixels", () => {
  const scale = mappingScale(geometry.source.width, monitor);
  const point = mapLogicalToStream(1279, 491, monitor, scale);
  assert.equal(point.x, Math.round(1279 * 1.5));
  assert.equal(point.y, Math.round(491 * 1.5));
});

test("logical rect maps to stream rect", () => {
  const scale = 1.5;
  const rect = mapRectToStream([100, 50, 800, 600], monitor, scale);
  assert.deepEqual(rect, [150, 75, 1200, 900]);
});

test("second monitor offset subtracts the monitor origin", () => {
  const right: MonitorInfo = { name: "DP-1", x: 2560, y: 0, width: 1920, height: 1080, scale: 1 };
  const point = mapLogicalToStream(2600, 10, right, mappingScale(1920, right));
  assert.deepEqual(point, { x: 40, y: 10 });
});

test("pickMonitor finds the captured monitor by stream size", () => {
  const picked = pickMonitor([monitor], geometry);
  assert.ok(picked !== null);
  assert.equal(picked.monitor.name, "HDMI-A-1");
  assert.equal(picked.scale, 1.5);
});

test("pickMonitor prefers the monitor at the geometry origin among size-equal matches", () => {
  const twin: MonitorInfo = { name: "DP-2", x: 3840, y: 0, width: 3840, height: 2160, scale: 1.5 };
  const picked = pickMonitor([twin, monitor], geometry);
  assert.ok(picked !== null);
  assert.equal(picked.monitor.name, "HDMI-A-1");
});

test("pickMonitor returns null when no monitor matches within 2 px (no-pointer mode)", () => {
  const wrongHeight: MonitorInfo = { name: "DP-3", x: 0, y: 0, width: 3840, height: 2400, scale: 1.5 };
  assert.equal(pickMonitor([wrongHeight], geometry), null);
});

test("pickMonitor rejects a same-aspect smaller monitor", () => {
  const smaller: MonitorInfo = { ...monitor, width: 1920, height: 1080 };
  assert.equal(pickMonitor([smaller], geometry), null);
});

test("pickMonitor accepts a match within the 2 px tolerance", () => {
  const close: MonitorInfo = { name: "DP-4", x: 0, y: 0, width: 3840, height: 2162, scale: 1.5 };
  const picked = pickMonitor([close], geometry);
  assert.ok(picked !== null);
  assert.equal(picked.monitor.name, "DP-4");
});
