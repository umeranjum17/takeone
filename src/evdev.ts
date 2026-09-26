/**
 * Parsing of evdev's 24-byte input_event records (64-bit struct timeval,
 * little-endian on this platform) and the small vocabulary of event types and
 * codes takeone cares about.
 */

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
