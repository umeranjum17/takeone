import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractRecords,
  EV_KEY,
  EV_REL,
  EV_SYN,
  parseEvdevRecord,
  REL_WHEEL,
  REL_WHEEL_HI_RES,
  BTN_LEFT,
  BUTTON_NAMES,
  parseInputDevices,
} from "../evdev.js";

function recordBytes(sec: number, usec: number, type: number, code: number, value: number): Buffer {
  const buf = Buffer.alloc(24);
  buf.writeBigInt64LE(BigInt(sec), 0);
  buf.writeBigInt64LE(BigInt(usec), 8);
  buf.writeUInt16LE(type, 16);
  buf.writeUInt16LE(code, 18);
  buf.writeInt32LE(value, 20);
  return buf;
}

test("parses one 24-byte input_event record from bytes", () => {
  const raw = recordBytes(1700000000, 123456, EV_KEY, 31, 1);
  const record = parseEvdevRecord(raw);
  assert.ok(record !== null);
  assert.equal(record.sec, 1700000000);
  assert.equal(record.usec, 123456);
  assert.equal(record.type, EV_KEY);
  assert.equal(record.code, 31);
  assert.equal(record.value, 1);
});

test("returns null for a too-short buffer", () => {
  assert.equal(parseEvdevRecord(Buffer.alloc(23)), null);
});

test("extracts several records from one chunk", () => {
  const chunk = Buffer.concat([
    recordBytes(1, 2, EV_KEY, BTN_LEFT, 1),
    recordBytes(1, 3, EV_KEY, BTN_LEFT, 0),
    recordBytes(1, 4, EV_SYN, 0, 0),
  ]);
  const { records, rest } = extractRecords(chunk, Buffer.alloc(0));
  assert.equal(records.length, 3);
  assert.equal(records[0]?.code, BTN_LEFT);
  assert.equal(records[1]?.value, 0);
  assert.equal(rest.byteLength, 0);
});

test("carries partial bytes over to the next chunk", () => {
  const first = recordBytes(1, 2, EV_KEY, BTN_LEFT, 1);
  const second = recordBytes(1, 3, EV_REL, REL_WHEEL_HI_RES, 120);
  // chunk 1 holds the first record plus the first 10 bytes of the second
  const parsed = extractRecords(Buffer.concat([first, second.subarray(0, 10)]), Buffer.alloc(0));
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0]?.code, BTN_LEFT);
  assert.equal(parsed.rest.byteLength, 10);

  // chunk 2 completes the second record from the carry
  const done = extractRecords(second.subarray(10), parsed.rest);
  assert.equal(done.records.length, 1);
  assert.equal(done.records[0]?.code, REL_WHEEL_HI_RES);
  assert.equal(done.records[0]?.value, 120);
  assert.equal(done.records[0]?.sec, 1);
  assert.equal(done.rest.byteLength, 0);
});

test("wheel and button codes carry the names the events file uses", () => {
  assert.equal(BUTTON_NAMES[BTN_LEFT], "left");
  assert.equal(REL_WHEEL, 8);
});

test("input devices come from the kernel list, including virtual and combo devices", () => {
  const text = [
    "I: Bus=0019 Vendor=0000 Product=0001 Version=0000",
    'N: Name="Power Button"',
    "H: Handlers=kbd event0 ",
    "",
    'N: Name="Logitech USB Receiver"',
    "H: Handlers=sysrq kbd leds event3 ",
    "",
    'N: Name="Some Mouse"',
    "H: Handlers=event4 mouse0 ",
    "",
    "I: Bus=0006 Vendor=0000 Product=0000 Version=0000",
    'N: Name="virtual combo"',
    "H: Handlers=sysrq kbd event21 mouse3 ",
    "",
    'N: Name="HD-Audio Generic HDMI"',
    "H: Handlers=event9 ",
    "",
  ].join("\n");
  assert.deepEqual(parseInputDevices(text), [
    { path: "/dev/input/event0", mouse: false, kbd: true },
    { path: "/dev/input/event3", mouse: false, kbd: true },
    { path: "/dev/input/event4", mouse: true, kbd: false },
    { path: "/dev/input/event21", mouse: true, kbd: true },
  ]);
});
