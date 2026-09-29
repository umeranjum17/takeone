// Android `adb shell getevent -lt` -> take Event[] mapper.
// Pure function over plain data: no Node imports, no I/O.
// One more producer of the take directory's events.jsonl; the desktop
// record/session/taps path is untouched.

import type { Event } from "../types.ts";

export interface TouchOpts {
  /** Raw axis maxima from `getevent -lp` (range is 0..axisMax*). */
  axisMaxX: number;
  axisMaxY: number;
  /** Output size in px from `adb shell wm size` (already rotated). */
  W: number;
  H: number;
  /** Extra ms of wheel events after lift so a fling reads as one scroll. */
  flingTailMs: number;
}

/** A stroke at or under this px length is a tap; mirrors CLICK_RELEASE_MAX_PX. */
export const TAP_MAX_PX = 12;

/** Wheel spacing; must stay under SCROLL_GAP_MS (500) so a swipe is one scroll. */
const WHEEL_STEP_MS = 100;

/** `getevent -lt` line: `[ <sec>.<usec>] <dev>: <type> <code> <hexvalue>`. */
const LINE = /^\[\s*(\d+)\.(\d+)\]\s*(\S+):\s+(\S+)\s+(\S+)\s+([0-9a-fA-F]+)\s*$/;

interface Sample {
  t: number;
  x: number;
  y: number;
}

interface Stroke {
  t0: number;
  start: Sample | null;
  moves: Sample[];
  t1: number;
  end: Sample | null;
}

interface RawPos {
  x: number | null;
  y: number | null;
}

interface DevState {
  sawMT: boolean;
  slot: number;
  pos: Map<number, RawPos>;
  open: Map<number, Stroke>;
  closing: Set<number>;
  stX: number | null;
  stY: number | null;
  stStroke: Stroke | null;
  stClosing: boolean;
}

function newStroke(t: number, start: Sample | null): Stroke {
  return { t0: t, start, moves: [], t1: t, end: null };
}

function newDev(): DevState {
  return {
    sawMT: false,
    slot: 0,
    pos: new Map(),
    open: new Map(),
    closing: new Set(),
    stX: null,
    stY: null,
    stStroke: null,
    stClosing: false,
  };
}

function slotPos(d: DevState, slot: number): RawPos {
  let p = d.pos.get(slot);
  if (!p) {
    p = { x: null, y: null };
    d.pos.set(slot, p);
  }
  return p;
}

function signed(hex: string): number {
  const v = parseInt(hex, 16);
  return v >= 0x80000000 ? v - 0x100000000 : v;
}

/** Fold the slot's current raw position into its stroke at frame time t. */
function commitStroke(s: Stroke, raw: RawPos, t: number): void {
  if (raw.x === null || raw.y === null) return;
  if (!s.start) s.start = { t, x: raw.x, y: raw.y };
  else {
    const prev = s.moves.length > 0 ? s.moves[s.moves.length - 1]! : s.start;
    if (prev.x !== raw.x || prev.y !== raw.y) s.moves.push({ t, x: raw.x, y: raw.y });
  }
}

function closeStroke(s: Stroke, raw: RawPos, t: number): void {
  s.t1 = t;
  if (raw.x !== null && raw.y !== null) s.end = { t, x: raw.x, y: raw.y };
  else if (s.moves.length > 0) s.end = s.moves[s.moves.length - 1]!;
  else if (s.start) s.end = { ...s.start, t };
}

function pushStroke(out: Event[], s: Stroke, o: TouchOpts): void {
  if (!s.start) return; // down+up with no position: nothing to point at
  const end = s.end ?? s.moves[s.moves.length - 1] ?? s.start;
  const cx = (raw: number): number =>
    Math.min(Math.max(0, Math.round((raw * o.W) / (o.axisMaxX + 1))), Math.max(0, o.W - 1));
  const cy = (raw: number): number =>
    Math.min(Math.max(0, Math.round((raw * o.H) / (o.axisMaxY + 1))), Math.max(0, o.H - 1));
  const x0 = cx(s.start.x);
  const y0 = cy(s.start.y);
  const x1 = cx(end.x);
  const y1 = cy(end.y);
  const t1 = Math.max(s.t1, s.t0);
  if (Math.hypot(x1 - x0, y1 - y0) <= TAP_MAX_PX) {
    // Tap and long press share one shape; the core reads a long hold as a
    // from==to drag (actions.ts:219). ptr-lost lands 1 ms after the up: a
    // same-ms loss would drop the click (actions.ts:196).
    out.push({ t: s.t0, k: "ptr", x: x0, y: y0 });
    out.push({ t: s.t0, k: "btn", b: "left", down: true });
    out.push({ t: t1, k: "btn", b: "left", down: false });
    out.push({ t: t1 + 1, k: "ptr-lost" });
    return;
  }
  // v1 never emits swipe-as-drag: getevent cannot tell a control drag from a
  // content scroll, so every long stroke is a scroll through a fixed tail.
  out.push({ t: s.t0, k: "ptr", x: x0, y: y0 });
  const tailEnd = t1 + Math.max(0, o.flingTailMs);
  const span = tailEnd - s.t0;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const step =
    Math.abs(dx) >= Math.abs(dy) ? { dx: Math.sign(dx), dy: 0 } : { dx: 0, dy: Math.sign(dy) };
  if (span <= 0) out.push({ t: s.t0, k: "wheel", ...step });
  else {
    const n = Math.max(2, Math.floor(span / WHEEL_STEP_MS) + 1);
    for (let i = 0; i < n; i++) out.push({ t: s.t0 + Math.round((span * i) / (n - 1)), k: "wheel", ...step });
  }
  out.push({ t: tailEnd + 1, k: "ptr-lost" });
}

/**
 * Parse `getevent -lt` lines into take events. Merges every device stream in
 * the log (phone touchpanel via INPUT_PROP_DIRECT, or all emulator
 * virtio MT devices); concurrent fingers are reduced to the primary finger
 * in v1 (the first active slot of a gesture, ignoring secondary slots until
 * all fingers lift) so output is always a well-formed single-pointer
 * sequence. Times are ms relative to the first line; output is sorted by t.
 */
export function touchEvents(lines: string[] | string, o: TouchOpts): Event[] {
  const arr = typeof lines === "string" ? lines.split("\n") : lines;
  const devs = new Map<string, DevState>();
  const done: Stroke[] = [];
  let t0us: number | null = null;
  let lastT = 0;
  const at = (dev: string): DevState => {
    let d = devs.get(dev);
    if (!d) {
      d = newDev();
      devs.set(dev, d);
    }
    return d;
  };
  const commitMT = (d: DevState, t: number): void => {
    for (const [slot, s] of d.open) {
      const p = d.pos.get(slot) ?? { x: null, y: null };
      if (d.closing.has(slot)) {
        closeStroke(s, p, t);
        d.open.delete(slot);
        d.closing.delete(slot);
        done.push(s);
      } else commitStroke(s, p, t);
    }
  };
  const commitST = (d: DevState, t: number): void => {
    const s = d.stStroke;
    if (!s) return;
    const p = { x: d.stX, y: d.stY };
    if (d.stClosing) {
      closeStroke(s, p, t);
      d.stStroke = null;
      d.stClosing = false;
      done.push(s);
    } else commitStroke(s, p, t);
  };

  for (const line of arr) {
    const m = LINE.exec(line.trim());
    if (!m) continue; // blank lines, headers, -lp dumps
    const us = parseInt(m[1]!, 10) * 1e6 + parseInt(`${m[2]!}000000`.slice(0, 6), 10);
    if (t0us === null) t0us = us;
    const t = Math.round((us - t0us) / 1000);
    lastT = t;
    const d = at(m[3]!);
    const type = m[4]!;
    const code = m[5]!;
    const v = signed(m[6]!);
    if (type === "EV_ABS") {
      if (code === "ABS_MT_SLOT") d.slot = v;
      else if (code === "ABS_MT_TRACKING_ID") {
        d.sawMT = true;
        slotPos(d, d.slot);
        if (v === -1) {
          if (d.open.has(d.slot)) d.closing.add(d.slot);
        } else if (!d.open.has(d.slot)) d.open.set(d.slot, newStroke(t, null));
      } else if (code === "ABS_MT_POSITION_X") {
        d.sawMT = true;
        slotPos(d, d.slot).x = v;
      } else if (code === "ABS_MT_POSITION_Y") {
        d.sawMT = true;
        slotPos(d, d.slot).y = v;
      } else if (code === "ABS_X") d.stX = v;
      else if (code === "ABS_Y") d.stY = v;
    } else if (type === "EV_KEY" && code === "BTN_TOUCH") {
      // MT devices echo BTN_TOUCH alongside tracking ids; the ids own the
      // lifecycle there, so this only drives single-touch devices.
      if (v === 1) {
        if (!d.sawMT && !d.stStroke) {
          d.stStroke = newStroke(
            t,
            d.stX !== null && d.stY !== null ? { t, x: d.stX, y: d.stY } : null,
          );
        }
      } else if (d.stStroke) d.stClosing = true;
    } else if (type === "EV_SYN" && (code === "SYN_REPORT" || code === "SYN_MT_REPORT")) {
      if (d.sawMT) commitMT(d, t);
      else commitST(d, t);
    }
  }
  // Truncated logs: settle strokes still open at the last timestamp.
  for (const d of devs.values()) {
    if (d.sawMT) {
      for (const [slot, s] of d.open) {
        closeStroke(s, d.pos.get(slot) ?? { x: null, y: null }, lastT);
        done.push(s);
      }
      d.open.clear();
      d.closing.clear();
    } else if (d.stStroke) {
      closeStroke(d.stStroke, { x: d.stX, y: d.stY }, lastT);
      done.push(d.stStroke);
      d.stStroke = null;
    }
  }
  const out: Event[] = [];
  done.sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
  let busyEnd = -Infinity;
  for (const s of done) {
    if (s.t0 > busyEnd) {
      pushStroke(out, s, o);
      busyEnd = s.t1;
    } else busyEnd = Math.max(busyEnd, s.t1);
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}
