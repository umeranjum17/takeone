// Actions from input events, refined by change regions (design 6.2).
// Pure functions over plain data: no Node imports, no I/O.

import type { Action, BBox, Event, FrameRegions, Region } from "../types.ts";
import { bboxIoU, unionBBox } from "../types.ts";

export const CLICK_MAX_MS = 300;
export const CLICK_MAX_PX = 6;
export const DOUBLE_MS = 400;
export const DRAG_MIN_MS = 300;
export const DRAG_MIN_PX = 12;
export const SCROLL_GAP_MS = 500;
export const TYPE_GAP_MS = 1200;
export const DWELL_MIN_MS = 800;
export const DWELL_MAX_PX = 12;
export const TRAVEL_WINDOW_MS = 1000;
export const TRAVEL_FRAC = 0.25;

interface PtrSample {
  t: number;
  x: number;
  y: number;
  window_cls: string;
}

const TYPE_CLASSES = new Set(["char", "space", "backspace", "enter", "tab"]);

/**
 * Derive actions from the event stream.
 *
 * `frames` are the perception regions, used to refine typing regions.
 * When `pointer` is "none" (unmapped capture), pointer-position actions
 * (click/drag position, dwell, travel) fall back to the centroid of the change
 * region within 300 ms of the button event; dwell and travel cannot exist.
 */
export function actionsFromEvents(
  events: Event[],
  frames: FrameRegions[],
  opts: { stream: { w: number; h: number }; pointer: string },
): Action[] {
  const acts: Action[] = [];
  const ptr: PtrSample[] = [];
  let win: { cls: string; rect: BBox } | null = null;
  let lastClick: { t: number; x: number; y: number; cls: string } | null = null;
  const used = new Set<number>();
  const heldIntervals: [number, number][] = [];
  const buttonTimes: number[] = [];
  const ups = new Map<number, number>();
  const pending = new Map<string, number>();

  const pointerAt = (t: number): [number, number] | null => {
    // last ptr sample at or before t
    let lo = 0;
    let hi = ptr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (ptr[mid]!.t <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo ? [ptr[lo - 1]!.x, ptr[lo - 1]!.y] : null;
  };

  const regionCentroidNear = (t: number): [number, number] | null => {
    for (const f of frames) {
      if (f.t < t || f.t > t + CLICK_MAX_MS) continue;
      let best: Region | null = null;
      for (const r of f.regions) {
        if (!best || r.area_frac > best.area_frac) best = r;
      }
      if (best) {
        const [x, y, w, h] = best.bbox;
        return [x + w / 2, y + h / 2];
      }
    }
    return null;
  };

  const frameDiag = Math.hypot(opts.stream.w, opts.stream.h);

  // pass 1: window focus actions and pointer sample collection
  const held = new Set<string>();
  let holdStart = 0;
  for (const [index, e] of events.entries()) {
    if (e.k === "ptr") ptr.push({ t: e.t, x: e.x, y: e.y, window_cls: win?.cls ?? "" });
    else if (e.k === "win") {
      if (!win || win.cls !== e.cls) {
        acts.push({ k: "focus", t: e.t, cls: e.cls, rect: e.rect });
        const last = ptr[ptr.length - 1];
        if (last) {
          if (last.t < e.t) ptr.push({ ...last, t: e.t });
          ptr.push({ ...last, t: e.t, window_cls: e.cls });
        }
      }
      win = { cls: e.cls, rect: e.rect };
    } else if (e.k === "btn") {
      buttonTimes.push(e.t);
      if (e.down) {
        if (held.size === 0) holdStart = e.t;
        held.add(e.b);
        if (!pending.has(e.b)) pending.set(e.b, index);
      } else if (held.has(e.b)) {
        held.delete(e.b);
        const down = pending.get(e.b);
        if (down !== undefined) ups.set(down, index);
        pending.delete(e.b);
        if (held.size === 0) heldIntervals.push([holdStart, e.t]);
      }
    }
  }
  if (held.size > 0) heldIntervals.push([holdStart, Infinity]);

  // pass 2: pointer motions — dwell and travel (needs a pointer source)
  if (opts.pointer !== "none") {
    // dwell: consecutive samples within DWELL_MAX_PX of the anchor for >= DWELL_MIN_MS, no button held
    let i = 0;
    let intervalIndex = 0;
    const btnHeld = (t0: number, t1: number): boolean => {
      while (intervalIndex < heldIntervals.length && heldIntervals[intervalIndex]![1] <= t0) intervalIndex++;
      return intervalIndex < heldIntervals.length && heldIntervals[intervalIndex]![0] < t1;
    };
    while (i < ptr.length) {
      const anchor = ptr[i]!;
      let j = i + 1;
      while (
        j < ptr.length &&
        ptr[j]!.window_cls === anchor.window_cls &&
        Math.hypot(ptr[j]!.x - anchor.x, ptr[j]!.y - anchor.y) <= DWELL_MAX_PX
      ) {
        j++;
      }
      let freeStart = i;
      for (let k = i + 1; k < j; k++) {
        if (!btnHeld(ptr[k - 1]!.t, ptr[k]!.t)) continue;
        const last = ptr[k - 1]!;
        if (last.t - ptr[freeStart]!.t >= DWELL_MIN_MS) {
          acts.push({ k: "dwell", t0: ptr[freeStart]!.t, t1: last.t, x: ptr[freeStart]!.x, y: ptr[freeStart]!.y, window_cls: ptr[freeStart]!.window_cls });
        }
        freeStart = k;
      }
      const last = ptr[j - 1]!;
      if (last.t - ptr[freeStart]!.t >= DWELL_MIN_MS) {
        acts.push({ k: "dwell", t0: ptr[freeStart]!.t, t1: last.t, x: ptr[freeStart]!.x, y: ptr[freeStart]!.y, window_cls: ptr[freeStart]!.window_cls });
      }
      i = Math.max(j - 1, i + 1);
    }
    // travel: cumulative path over a 1 s window > 25% of the diagonal, no click inside
    let buttonIndex = 0;
    for (let a = 0; a < ptr.length; a++) {
      const start = ptr[a]!;
      let len = 0;
      let b = a + 1;
      while (b < ptr.length && ptr[b]!.window_cls === start.window_cls && ptr[b]!.t - start.t <= TRAVEL_WINDOW_MS) {
        len += Math.hypot(ptr[b]!.x - ptr[b - 1]!.x, ptr[b]!.y - ptr[b - 1]!.y);
        b++;
      }
      if (len > frameDiag * TRAVEL_FRAC && b - a >= 2) {
        const end = ptr[b - 1]!;
        while (buttonIndex < buttonTimes.length && buttonTimes[buttonIndex]! < start.t) buttonIndex++;
        const hasClick = buttonIndex < buttonTimes.length && buttonTimes[buttonIndex]! <= end.t;
        if (!hasClick) {
          const xs = ptr.slice(a, b).map((s) => s.x);
          const ys = ptr.slice(a, b).map((s) => s.y);
          acts.push({
            k: "travel",
            t0: start.t,
            t1: end.t,
            from: [start.x, start.y],
            to: [end.x, end.y],
            bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)],
            window_cls: start.window_cls,
          });
          a = b - 1; // do not emit overlapping travels
        }
      }
    }
  }

  // pass 3: buttons -> click/drag, wheel -> scroll, keys -> type/shortcut
  let atWin: { cls: string; rect: BBox } | null = null;
  for (let i = 0; i < events.length; i++) {
    if (used.has(i)) continue;
    const e = events[i]!;
    if (e.k === "win") atWin = { cls: e.cls, rect: e.rect };
    if (e.k === "btn") {
      if (!e.down) continue;
      const upIndex = ups.get(i);
      const up = upIndex === undefined ? null : { t: events[upIndex]!.t };
      if (upIndex !== undefined) used.add(upIndex);
      const p0 = pointerAt(e.t) ?? (opts.pointer === "none" ? regionCentroidNear(e.t) : null);
      if (!p0) continue;
      if (!up) {
        // button never released: treat as drag end at the last pointer sample
        const lastPtr = ptr.length > 0 ? ptr[ptr.length - 1]! : null;
        const p1: [number, number] = lastPtr ? [lastPtr.x, lastPtr.y] : p0;
        acts.push({
          k: "drag",
          t0: e.t,
          t1: lastPtr?.t ?? e.t,
          from: p0,
          to: p1,
          bbox: pathBBox(ptr, e.t, lastPtr?.t ?? e.t, p0, p1),
          window_cls: atWin?.cls ?? "",
        });
        continue;
      }
      const p1 = pointerAt(up.t) ?? p0;
      const held = up.t - e.t;
      const moved = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      if (held > DRAG_MIN_MS || moved > DRAG_MIN_PX) {
        acts.push({
          k: "drag",
          t0: e.t,
          t1: up.t,
          from: p0,
          to: p1,
          bbox: pathBBox(ptr, e.t, up.t, p0, p1),
          window_cls: atWin?.cls ?? "",
        });
      } else {
        const isDouble: boolean =
          lastClick !== null &&
          lastClick.cls === (atWin?.cls ?? "") &&
          up.t - lastClick.t <= DOUBLE_MS &&
          Math.hypot(p0[0] - lastClick.x, p0[1] - lastClick.y) <= CLICK_MAX_PX;
        if (isDouble) {
          // the two clicks become one action
          const lastIdx = acts.map((a) => a.k).lastIndexOf("click");
          if (lastIdx >= 0) acts.splice(lastIdx, 1);
          acts.push({ k: "click", t: up.t, x: p0[0], y: p0[1], double: true, window_cls: atWin?.cls ?? "" });
          lastClick = null;
        } else {
          acts.push({ k: "click", t: up.t, x: p0[0], y: p0[1], window_cls: atWin?.cls ?? "" });
          lastClick = { t: up.t, x: p0[0], y: p0[1], cls: atWin?.cls ?? "" };
        }
      }
    } else if (e.k === "wheel") {
      // merge wheel events while gaps < SCROLL_GAP_MS
      let j = i;
      let dx = 0;
      let dy = 0;
      let detents = 0;
      let lastT = e.t;
      while (j < events.length) {
        const w2 = events[j]!;
        if (w2.k === "win" && w2.cls !== atWin?.cls) break;
        if (j > i && w2.t - lastT >= SCROLL_GAP_MS) break;
        if (w2.k === "wheel") {
          dx += w2.dx;
          dy += w2.dy;
          detents++;
          lastT = w2.t;
          used.add(j);
        }
        j++;
      }
      const p = pointerAt(e.t);
      acts.push({
        k: "scroll",
        t0: e.t,
        t1: lastT,
        x: p?.[0] ?? 0,
        y: p?.[1] ?? 0,
        dx,
        dy,
        detents,
        window_cls: atWin?.cls ?? "",
      });
    } else if (e.k === "key") {
      if (e.combo) {
        acts.push({ k: "shortcut", t: e.t, combo: e.combo, window_cls: atWin?.cls ?? "" });
        continue;
      }
      if (!e.down || !TYPE_CLASSES.has(e.cls)) continue;
      // merge type bursts while gaps < TYPE_GAP_MS
      let j = i + 1;
      let lastT = e.t;
      while (j < events.length) {
        const nx = events[j]!;
        if (nx.k === "win" && nx.cls !== atWin?.cls) break;
        if (nx.t - lastT >= TYPE_GAP_MS) break;
        if (nx.k === "key" && nx.down && (nx.combo || !TYPE_CLASSES.has(nx.cls))) break;
        if (nx.k === "key" && nx.down && TYPE_CLASSES.has(nx.cls)) {
          lastT = nx.t;
          used.add(j);
        }
        j++;
      }
      const region = typingRegion(frames, e.t, lastT, atWin?.rect ?? null);
      acts.push({ k: "type", t0: e.t, t1: lastT, window_cls: atWin?.cls ?? "", ...(region ? { region } : {}) });
    }
  }

  acts.sort((a, b) => actT(a) - actT(b));
  return acts;
}

function actT(a: Action): number {
  return a.k === "click" || a.k === "shortcut" || a.k === "focus" || a.k === "cut" ? a.t : a.t0;
}

/** bbox of pointer samples between t0 and t1, extended to include from/to. */
function pathBBox(
  ptr: PtrSample[],
  t0: number,
  t1: number,
  from: [number, number],
  to: [number, number],
): BBox {
  const xs: number[] = [from[0], to[0]];
  const ys: number[] = [from[1], to[1]];
  for (const s of ptr) {
    if (s.t >= t0 && s.t <= t1) {
      xs.push(s.x);
      ys.push(s.y);
    }
  }
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return [x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0];
}

/** Union of change regions during the burst that lie inside the focused window. */
function typingRegion(
  frames: FrameRegions[],
  t0: number,
  t1: number,
  winRect: BBox | null,
): BBox | null {
  let u: BBox | null = null;
  for (const f of frames) {
    if (f.t < t0 || f.t > t1 + 200) continue; // small tail: the last keystroke's pixels may lag
    for (const r of f.regions) {
      if (winRect && !insideWindow(r.bbox, winRect)) continue;
      u = u ? unionBBox(u, r.bbox) : r.bbox;
    }
  }
  return u;
}

/** Region counts as inside the window when most of it lies within the rect. */
function insideWindow(b: BBox, win: BBox): boolean {
  const i = bboxIoU(b, win);
  const x1 = Math.min(b[0] + b[2], win[0] + win[2]);
  const y1 = Math.min(b[1] + b[3], win[1] + win[3]);
  const inter = Math.max(0, x1 - Math.max(b[0], win[0])) * Math.max(0, y1 - Math.max(b[1], win[1]));
  return i > 0.3 || inter >= bboxAreaOf(b) * 0.6;
}

function bboxAreaOf(b: BBox): number {
  return b[2] * b[3];
}
