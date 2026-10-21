import type { Beat, CameraFrame, Zone } from "./types.ts";
import type { CameraDefaults } from "./defaults.ts";
import { baseWidth } from "./solver.ts";

export interface Gesture {
  k: "drag";
  t0: number;
  t1: number;
  from: [number, number];
  to: [number, number];
  bbox: [number, number, number, number];
  whole_object?: [number, number, number, number];
  path?: { t: number; x: number; y: number }[];
}

/** Resolve gestures themselves, never the dwell/click that happens to precede them. */
export function gestures(beat: Beat): Gesture[] {
  return beat.actions.filter((action): action is Gesture => {
    const a = action as Partial<Gesture>;
    return a.k === "drag" && Array.isArray(a.from) && Array.isArray(a.to)
      && Array.isArray(a.bbox) && Number.isFinite(a.t0) && Number.isFinite(a.t1);
  });
}

export function gesturePointer(g: Gesture, time: number): [number, number] {
  const ms = time * 1000;
  const points = [{ t: g.t0, x: g.from[0], y: g.from[1] }, ...(g.path ?? []),
    { t: g.t1, x: g.to[0], y: g.to[1] }];
  const next = points.findIndex(p => p.t > ms);
  const a = points[next < 0 ? points.length - 1 : Math.max(0, next - 1)]!;
  const b = points[next < 0 ? points.length - 1 : next]!;
  const u = b.t > a.t ? Math.max(0, Math.min(1, (ms - a.t) / (b.t - a.t))) : 0;
  return [a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u];
}

/** Reserve the whole swept object and cursor, so the camera need not chase or lag behind a drag. */
export function gestureZone(g: Gesture, width: number, height: number): Zone {
  if (!g.whole_object) return { name: "gesture", type: "all", bbox: [0, 0, width, height] };
  const points = [g.from, g.to, ...(g.path ?? []).map(p => [p.x, p.y])];
  const left = Math.min(g.bbox[0], ...points.map(p => p[0]!));
  const top = Math.min(g.bbox[1], ...points.map(p => p[1]!));
  const right = Math.max(g.bbox[0] + g.bbox[2], ...points.map(p => p[0]!));
  const bottom = Math.max(g.bbox[1] + g.bbox[3], ...points.map(p => p[1]!));
  const subject = g.whole_object;
  // Include cursor ink, not only its hotspot, and preserve the grab offset.
  const x = Math.max(0, left + Math.min(-8, subject[0]! - g.from[0]));
  const y = Math.max(0, top + Math.min(-8, subject[1]! - g.from[1]));
  const r = Math.min(width, right + Math.max(24, subject[0]! + subject[2]! - g.from[0]));
  const b = Math.min(height, bottom + Math.max(32, subject[1]! + subject[3]! - g.from[1]));
  return { name: "gesture", type: "path", bbox: [x, y, Math.max(1, r - x), Math.max(1, b - y)] };
}

/**
 * Keep the editorial camera path, then reserve visibility around each drag.
 * Enlarging a viewport around its existing centre preserves EVERYTHING it
 * showed before, so drag safety cannot cause a framing regression elsewhere.
 * Plan this over the full path: correcting only the current frame would jump.
 */
export function applyDragVisibility(
  frames: CameraFrame[], beats: Beat[], width: number, height: number,
  start: number, d: CameraDefaults,
): CameraFrame[] {
  const aspect = d.out_w / d.out_h;
  const wholeW = baseWidth(width, height, d);
  const transition = d.move_t_max + d.min_shot + 2 / d.lowpass_omega;
  const smooth = (u: number) => u * u * u * (u * (u * 6 - 15) + 10);
  const holds = beats.flatMap(beat => {
    const drags = gestures(beat).filter(g => g.t1 / 1000 >= start && g.t0 / 1000 <= start + frames.at(-1)!.t);
    if (!drags.length) return [];
    const zones = drags.map(g => gestureZone(g, width, height));
    // The window is the drag itself, not the beat around it: the camera need not be wide for the rest of the beat.
    const a = Math.min(...drags.map(g => g.t0 / 1000));
    const b = Math.max(...drags.map(g => g.t1 / 1000));
    let required = 0;
    for (const f of frames) {
      const t = f.t + start;
      if (t < a || t > b) continue;
      const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
      for (const zone of zones) {
        const [x, y, w, h] = zone.bbox;
        required = Math.max(required, f.w, 2 * Math.max(cx - x, x + w - cx),
          2 * Math.max(cy - y, y + h - cy) * aspect);
      }
    }
    return required > 0 ? [{ a, b, w: Math.min(wholeW, required * d.hold_pad) }] : [];
  });
  // A whole-screen reserve must not resize an already moving view and then clamp
  // its centre: hitting either clamp adds a second pan and an abrupt reversal.
  // Ease between fixed endpoints that sit on quiet frames, and hold the reserve only for the drag.
  const full = { x: (width - wholeW) / 2, y: (height - wholeW / aspect) / 2, w: wholeW, h: wholeW / aspect };
  const quiet = (i: number) => {
    const end = i + Math.ceil(d.min_shot * d.fps);
    if (end >= frames.length) return false;
    for (let j = i + 1; j <= end; j++) {
      const p = frames[j - 1]!, q = frames[j]!;
      if (Math.abs(Math.log(q.w / p.w)) * d.fps > 0.005
        || Math.abs(q.x / q.w - p.x / p.w) * d.out_w * d.fps > 1
        || Math.abs(q.y / q.h - p.y / p.h) * d.out_h * d.fps > 1) return false;
    }
    return true;
  };
  const reserved: { enter: number; arrive: number; leave: number; end: number;
    from: CameraFrame; to: typeof full }[] = [];
  if (wholeW >= width && wholeW / aspect >= height) for (const hold of holds.filter(h => h.w >= wholeW - 1e-6)) {
    const rest = Math.ceil(d.min_shot * d.fps);
    let before = Math.max(0, Math.floor((hold.a - start - transition) * d.fps));
    while (before > 0 && !quiet(Math.max(0, before - rest))) before--;
    let after = Math.min(frames.length - 1, Math.ceil((hold.b - start + transition) * d.fps));
    while (after < frames.length - 1 && !quiet(after)) after++;
    const to = quiet(after) ? frames[after]! : full;
    const end = frames[after]!.t + start;
    const next = { enter: frames[before]!.t + start, arrive: hold.a,
      leave: Math.max(hold.b, end - transition), end, from: frames[before]!, to };
    const previous = reserved.at(-1);
    if (previous && next.enter <= previous.end) {
      previous.leave = Math.max(previous.leave, next.leave);
      if (next.end >= previous.end) {
        previous.end = next.end;
        previous.to = next.to;
      }
    } else reserved.push(next);
  }
  const blend = (a: typeof full, b: typeof full, u: number) => {
    u = smooth(Math.max(0, Math.min(1, u)));
    // Literal endpoints: exp(log(w)) is off by round-off, and the outro must land exactly.
    if (u === 0) return { x: a.x, y: a.y, w: a.w, h: a.h };
    if (u === 1) return { x: b.x, y: b.y, w: b.w, h: b.h };
    const w = a.w === b.w ? a.w : Math.exp(Math.log(a.w) + u * Math.log(b.w / a.w));
    // Interpolate nested rectangles, not centres followed by a screen-edge clamp.
    const p = Math.abs(b.w - a.w) < 1e-9 ? u : (w - a.w) / (b.w - a.w);
    return { w, h: w / aspect, x: a.x + p * (b.x - a.x), y: a.y + p * (b.y - a.y) };
  };
  return frames.map(f => {
    const t = f.t + start;
    const reserve = reserved.find(h => t >= h.enter && t <= h.end);
    if (reserve) {
      const view = t < reserve.arrive
        ? blend(reserve.from, full, (t - reserve.enter) / (reserve.arrive - reserve.enter))
        : t > reserve.leave && reserve.end > reserve.leave
          ? blend(full, reserve.to, (t - reserve.leave) / (reserve.end - reserve.leave)) : full;
      return { ...f, ...view };
    }
    let w = f.w;
    for (const hold of holds) {
      const u = t < hold.a ? 1 - (hold.a - t) / transition
        : t > hold.b ? 1 - (t - hold.b) / transition : 1;
      const weight = smooth(Math.max(0, Math.min(1, u)));
      w = Math.max(w, Math.exp(Math.log(f.w) + weight * Math.max(0, Math.log(hold.w / f.w))));
    }
    if (w <= f.w + 1e-9) return f;
    const h = w / aspect;
    const place = (c: number, view: number, size: number) => view > size
      ? (size - view) / 2 : Math.max(0, Math.min(size - view, c - view / 2));
    return { ...f, w, h, x: place(f.x + f.w / 2, w, width), y: place(f.y + f.h / 2, h, height) };
  });
}
