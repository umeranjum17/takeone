import type { Beat, CameraFrame, Zone } from "./types.ts";
import type { CameraDefaults } from "./defaults.ts";

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
  const wholeW = Math.max(width, height * aspect);
  const transition = d.move_t_max + d.min_shot + 2 / d.lowpass_omega;
  const smooth = (u: number) => u * u * u * (u * (u * 6 - 15) + 10);
  const holds = beats.flatMap((beat, index) => {
    const drags = gestures(beat).filter(g => g.t1 / 1000 >= start && g.t0 / 1000 <= start + frames.at(-1)!.t);
    if (!drags.length) return [];
    const zones = drags.map(g => gestureZone(g, width, height));
    const acted = beat.zones.find(z => z.type === "act");
    if (acted) zones.push(acted);
    const next = beats[index + 1];
    const nextAct = next?.zones.find(z => z.type === "act");
    if (nextAct) zones.push(nextAct);
    const a = Math.min(beat.t0, ...drags.map(g => g.t0 / 1000));
    const b = Math.max(beat.t1, ...drags.map(g => g.t1 / 1000), nextAct ? next!.t1 : beat.t1);
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
  return frames.map(f => {
    const t = f.t + start;
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
