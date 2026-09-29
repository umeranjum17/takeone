import assert from "node:assert/strict";
import { test } from "node:test";
import { touchEvents } from "../android/touch.js";
import { actionsFromEvents } from "../perceive/actions.js";

// Recorded-shape `getevent -lt` text: tap + swipe on two phone-range device
// streams (merged), long press on an emulator-range stream.

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

test("getevent tap, long press and swipe become click, from==to drag and scroll", () => {
  // Phone axis range 0..23040 x 0..50688, stream 1080x2400.
  const phone = [
    ...mtDown("/dev/input/event6", 0, 11520, 25344),
    ...mtUp("/dev/input/event6", 100),
    ...mtDown("/dev/input/event7", 2000, 11520, 20000),
    ...mtMove("/dev/input/event7", 2100, 11520, 22000),
    ...mtMove("/dev/input/event7", 2200, 11520, 24000),
    ...mtMove("/dev/input/event7", 2300, 11520, 26000),
    ...mtUp("/dev/input/event7", 2400),
  ];
  // Emulator axis range 0..32767 x 0..32767, stream 1080x2400.
  const emu = [...mtDown("/dev/input/event1", 5000, 16383, 16383), ...mtUp("/dev/input/event1", 5600)];

  const phoneEvents = touchEvents(phone, { axisMaxX: 23040, axisMaxY: 50688, W: 1080, H: 2400, flingTailMs: 300 });
  const emuEvents = touchEvents(emu, { axisMaxX: 32767, axisMaxY: 32767, W: 1080, H: 2400, flingTailMs: 300 });
  for (const batch of [phoneEvents, emuEvents]) {
    assert.ok(batch.length > 0);
    assert.ok(batch.every((e, i, a) => i === 0 || a[i - 1]!.t <= e.t));
  }

  // Sequential gestures on one clock: the emulator long press lands 5 s after the phone tap and swipe.
  const events = [...phoneEvents, ...emuEvents.map((e) => ({ ...e, t: e.t + 5000 }))].sort((a, b) => a.t - b.t);
  const actions = actionsFromEvents(events, [], { stream: { w: 1080, h: 2400 }, pointer: "mapped" });
  assert.deepEqual(
    actions.map((a) => a.k),
    ["click", "scroll", "drag"],
  );
  const drag = actions[2]!;
  assert.equal(drag.k, "drag");
  if (drag.k === "drag") assert.deepEqual(drag.from, drag.to);

  // Out-of-range raw values clamp to the stream.
  const wild = touchEvents([...mtDown("/dev/input/event6", 0, 40000, 99999), ...mtUp("/dev/input/event6", 50)], {
    axisMaxX: 23040,
    axisMaxY: 50688,
    W: 1080,
    H: 2400,
    flingTailMs: 300,
  });
  const ptr = wild.find((e) => e.k === "ptr");
  assert.ok(ptr && ptr.k === "ptr");
  if (ptr.k === "ptr") assert.deepEqual([ptr.x, ptr.y], [1079, 2399]);
});
