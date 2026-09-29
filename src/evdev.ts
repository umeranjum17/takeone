/**
 * Parsing of evdev's 24-byte input_event records (64-bit struct timeval,
 * little-endian on this platform) and the small vocabulary of event types and
 * codes takeone cares about.
 */

import { readdir, readFile } from "node:fs/promises";

export const EV_SYN = 0x00;
export const EV_KEY = 0x01;
export const EV_REL = 0x02;

export const REL_WHEEL = 8;
export const REL_HWHEEL = 6;
export const REL_WHEEL_HI_RES = 11;
export const REL_HWHEEL_HI_RES = 12;
/** 120 units of hi-res scroll equal one detent. */
export const HI_RES_PER_DETENT = 120;

export const BTN_LEFT = 0x110;
export const BTN_RIGHT = 0x111;
export const BTN_MIDDLE = 0x112;
export const BTN_SIDE = 0x113;
export const BTN_EXTRA = 0x114;

export const BUTTON_NAMES: Record<number, string> = {
  [BTN_LEFT]: "left",
  [BTN_RIGHT]: "right",
  [BTN_MIDDLE]: "middle",
  [BTN_SIDE]: "back",
  [BTN_EXTRA]: "forward",
};

export interface EvdevRecord {
  sec: number;
  usec: number;
  type: number;
  code: number;
  value: number;
}

export const EVDEV_RECORD_BYTES = 24;

/** Parse the first 24-byte record in a buffer, or null when too short. */
export function parseEvdevRecord(buf: Buffer, offset = 0): EvdevRecord | null {
  if (buf.byteLength - offset < EVDEV_RECORD_BYTES) return null;
  return {
    sec: Number(buf.readBigInt64LE(offset)),
    usec: Number(buf.readBigInt64LE(offset + 8)),
    type: buf.readUInt16LE(offset + 16),
    code: buf.readUInt16LE(offset + 18),
    value: buf.readInt32LE(offset + 20),
  };
}

/**
 * Split a chunk from a character device into complete records plus any
 * trailing partial bytes (feed `rest` back in with the next chunk).
 */
export function extractRecords(chunk: Buffer, carry: Buffer): { records: EvdevRecord[]; rest: Buffer } {
  const whole = Buffer.concat([carry, chunk]);
  const count = Math.floor(whole.byteLength / EVDEV_RECORD_BYTES);
  const records: EvdevRecord[] = [];
  for (let i = 0; i < count; i++) {
    const record = parseEvdevRecord(whole, i * EVDEV_RECORD_BYTES);
    if (record !== null) records.push(record);
  }
  return { records, rest: whole.subarray(count * EVDEV_RECORD_BYTES) };
}

export interface InputCandidate {
  path: string;
  mouse: boolean;
  kbd: boolean;
}

/**
 * Mouse and keyboard event nodes from /proc/bus/input/devices
 * ("H: Handlers=sysrq kbd event3", "H: Handlers=event4 mouse0"). Unlike
 * /dev/input/by-id this also lists Bluetooth, i2c touchpad and uinput devices.
 */
export function parseInputDevices(text: string): InputCandidate[] {
  const candidates: InputCandidate[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("H: Handlers=")) continue;
    const handlers = line.slice("H: Handlers=".length).trim().split(/\s+/);
    const event = handlers.find((h) => /^event\d+$/.test(h));
    const mouse = handlers.some((h) => /^mouse\d+$/.test(h));
    const kbd = handlers.includes("kbd");
    if (event !== undefined && (mouse || kbd)) candidates.push({ path: `/dev/input/${event}`, mouse, kbd });
  }
  return candidates;
}

/**
 * Candidate devices: every mouse/keyboard the kernel lists, or, with `dir`
 * (tests), the `*-event-mouse` / `*-event-kbd` entries of that directory.
 * Rejects with the underlying errno error when the listing is unreadable.
 */
export async function listInputCandidates(dir?: string): Promise<InputCandidate[]> {
  if (dir === undefined) return parseInputDevices(await readFile("/proc/bus/input/devices", "utf8"));
  return (await readdir(dir))
    .filter((n) => n.endsWith("-event-mouse") || n.endsWith("-event-kbd"))
    .sort()
    .map((n) => ({ path: `${dir}/${n}`, mouse: n.endsWith("-event-mouse"), kbd: n.endsWith("-event-kbd") }));
}
