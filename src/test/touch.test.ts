import assert from "node:assert/strict";
import { test } from "node:test";
import { touchEvents } from "../android/touch.js";
import { actionsFromEvents } from "../perceive/actions.js";

// Recorded-shape `getevent -lt` text. Each axis range carries its own tap,
// long press and swipe on two merged device streams.

const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, "0");
const ev = (dev: string, ms: number, type: string, code: string, value: string): string =>
  `[ ${(1000 + ms / 1000).toFixed(6)}] ${dev}: ${type.padEnd(11)} ${code.padEnd(20)} ${value}`;

function mtDown(dev: string, ms: number, x: number, y: number, slot = 0, id = 1): string[] {
  return [
    ev(dev, ms, "EV_ABS", "ABS_MT_SLOT", hex(slot)),
    ev(dev, ms, "EV_ABS", "ABS_MT_TRACKING_ID", hex(id)),
    ev(dev, ms, "EV_KEY", "BTN_TOUCH", hex(1)),
    ev(dev, ms, "EV_ABS", "ABS_MT_POSITION_X", hex(x)),
    ev(dev, ms, "EV_ABS", "ABS_MT_POSITION_Y", hex(y)),
    ev(dev, ms, "EV_SYN", "SYN_REPORT", hex(0)),
  ];
}

function mtMove(dev: string, ms: number, x: number, y: number, slot = 0): string[] {
  return [
    ev(dev, ms, "EV_ABS", "ABS_MT_SLOT", hex(slot)),
    ev(dev, ms, "EV_ABS", "ABS_MT_POSITION_X", hex(x)),
    ev(dev, ms, "EV_ABS", "ABS_MT_POSITION_Y", hex(y)),
    ev(dev, ms, "EV_SYN", "SYN_REPORT", hex(0)),
  ];
}

function mtUp(dev: string, ms: number, slot = 0): string[] {
  return [
    ev(dev, ms, "EV_ABS", "ABS_MT_TRACKING_ID", "ffffffff"),
    ev(dev, ms, "EV_SYN", "SYN_REPORT", hex(0)),
  ];
}

/** Tap, long press and swipe in one clock; second gesture on another device to prove merging. */
function gestures(devA: string, devB: string, x: number, y: number, yEnd: number): string[] {
  return [
    ...mtDown(devA, 0, x, y),
    ...mtUp(devA, 100),
    ...mtDown(devB, 2000, x, y),
    ...mtMove(devB, 2100, x, Math.round((y + yEnd) / 3)),
    ...mtMove(devB, 2200, x, Math.round((y + 2 * yEnd) / 3)),
    ...mtMove(devB, 2300, x, yEnd),
    ...mtUp(devB, 2400),
    ...mtDown(devA, 5000, x, y),
    ...mtUp(devA, 5600),
  ];
}

function checkRange(
  name: string,
  lines: string[],
  opts: { axisMaxX: number; axisMaxY: number; W: number; H: number; flingTailMs: number },
): void {
  const events = touchEvents(lines, opts);
  assert.ok(events.length > 0, `${name}: no events`);
  assert.ok(
    events.every((e, i, a) => i === 0 || a[i - 1]!.t <= e.t),
    `${name}: unsorted`,
  );
  const actions = actionsFromEvents(events, [], {
    stream: { w: opts.W, h: opts.H },
    pointer: "mapped",
  });
  assert.deepEqual(
    actions.map((a) => a.k),
    ["click", "scroll", "drag"],
    `${name}: kinds`,
  );
  const drag = actions[2]!;
  assert.equal(drag.k, "drag", `${name}: third action`);
  if (drag.k === "drag") assert.deepEqual(drag.from, drag.to, `${name}: drag from==to`);
}

test("getevent tap, long press and swipe become click, from==to drag and scroll", () => {
  // Phone: axis range 0..23040 x 0..50688, stream 1080x2400.
  checkRange(
    "phone",
    gestures("/dev/input/event6", "/dev/input/event7", 11520, 20000, 26000),
    { axisMaxX: 23040, axisMaxY: 50688, W: 1080, H: 2400, flingTailMs: 300 },
  );
  // Emulator: axis range 0..32767 x 0..32767, stream 1080x2400.
  checkRange(
    "emulator",
    gestures("/dev/input/event1", "/dev/input/event2", 16383, 12000, 20000),
    { axisMaxX: 32767, axisMaxY: 32767, W: 1080, H: 2400, flingTailMs: 300 },
  );

  // Out-of-range raw values clamp to the stream.
  const wild = touchEvents(
    [...mtDown("/dev/input/event6", 0, 40000, 99999), ...mtUp("/dev/input/event6", 50)],
    { axisMaxX: 23040, axisMaxY: 50688, W: 1080, H: 2400, flingTailMs: 300 },
  );
  const ptr = wild.find((e) => e.k === "ptr");
  assert.ok(ptr && ptr.k === "ptr");
  if (ptr.k === "ptr") assert.deepEqual([ptr.x, ptr.y], [1079, 2399]);
});
