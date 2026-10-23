// Output safe-area gate for takes that carry their on-screen text boxes (text-boxes.json,
// written by the headless scene producer). Every box is projected through the final camera
// exactly as the cursor overlay is, so the check judges the placement that is rendered.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CameraFrame } from "../camera/types.ts";

/** Fraction of the output width and height kept clear of text on every side. */
export const SAFE_INSET = 0.05;
type Box = [number, number, number, number, string];
/** Source-px region one output frame paints (its screen card, cropped by the camera). */
export type Rect = [number, number, number, number];
export interface SafeAreaReport {
  out: { w: number; h: number }; safe: [number, number, number, number]; frames: number; checked: number;
  failures: { frame: number; t_out: number; t_src: number; label: string; source: number[]; output: number[] }[];
  /** Per title or caption: the frames its box covers a shown app box and those boxes' labels, and its
   * least clearance in output px to any shown app box (0 when covering; null when none was shown). */
  covers: { label: string; t0: number; t1: number; frames: number; labels: string[]; clearance: number | null; nearest: string }[];
}

/** Null when the take has no text boxes. `sourceAt` maps an output second to a video second.
 * `drawn[i]` is the source-px region frame i paints; a box outside it is not shown. */
export function safeAreaReport(dir: string, frames: CameraFrame[], drawn: Rect[], origin: { x: number; y: number },
  out: { w: number; h: number; fps: number }, sourceAt: (t: number) => number,
  overlays: { t: number; t1: number; label: string; box: number[] }[] = []): SafeAreaReport | null {
  const file = join(dir, "text-boxes.json");
  if (!existsSync(file)) return null;
  const { samples } = JSON.parse(readFileSync(file, "utf8")) as { samples: { t: number; boxes: Box[] }[] };
  const [x0, y0, x1, y1] = [out.w * SAFE_INSET, out.h * SAFE_INSET, out.w * (1 - SAFE_INSET), out.h * (1 - SAFE_INSET)];
  const report: SafeAreaReport = { out: { w: out.w, h: out.h }, safe: [x0, y0, x1, y1], frames: frames.length, checked: 0, failures: [],
    covers: overlays.map(o => ({ label: o.label, t0: o.t, t1: o.t1, frames: 0, labels: [], clearance: null, nearest: "" })) };
  let k = 0;
  frames.forEach((f, frame) => {
    const t = sourceAt(frame / out.fps);
    if (k > 0 && samples[k - 1]!.t > t + 1e-6) k = 0;
    while (k < samples.length && samples[k]!.t <= t + 1e-6) k++;
    const sx = out.w / f.w, sy = out.h / f.h;
    const shown = overlays.flatMap((o, i) => o.t <= frame / out.fps && frame / out.fps < o.t1 ? [i] : []);
    const covering = new Set<number>();
    const [dx0, dy0, dx1, dy1] = drawn[frame] ?? [-Infinity, -Infinity, Infinity, Infinity];
    for (const [bx, by, bw, bh, label] of samples[Math.max(0, k - 1)]?.boxes ?? []) {
      // Judge only the part the screen card paints: a box the camera crops away is not
      // shown, and a box whose edge the crop cuts is judged where its visible part lands.
      const [vx0, vy0, vx1, vy1] = [Math.max(bx, dx0), Math.max(by, dy0), Math.min(bx + bw, dx1), Math.min(by + bh, dy1)];
      if (vx1 <= vx0 || vy1 <= vy0) continue;
      const r = [(vx0 + origin.x - f.x) * sx, (vy0 + origin.y - f.y) * sy, (vx1 + origin.x - f.x) * sx, (vy1 + origin.y - f.y) * sy];
      // A frame can still paint past the output; a box shown in part counts in full.
      if (r[2]! <= 0 || r[3]! <= 0 || r[0]! >= out.w || r[1]! >= out.h) continue;
      report.checked++;
      for (const i of shown) {
        const o = overlays[i]!.box, c = report.covers[i]!;
        const gap = Math.hypot(Math.max(0, o[0]! - r[2]!, r[0]! - o[2]!), Math.max(0, o[1]! - r[3]!, r[1]! - o[3]!));
        if (c.clearance === null || gap < c.clearance) { c.clearance = +gap.toFixed(1); c.nearest = label; }
        if (r[0]! >= o[2]! || r[2]! <= o[0]! || r[1]! >= o[3]! || r[3]! <= o[1]!) continue;
        covering.add(i);
        if (!c.labels.includes(label)) c.labels.push(label);
      }
      if (r[0]! < x0 - 0.5 || r[1]! < y0 - 0.5 || r[2]! > x1 + 0.5 || r[3]! > y1 + 0.5) {
        report.failures.push({ frame, t_out: +(frame / out.fps).toFixed(3), t_src: +t.toFixed(3), label,
          source: [bx, by, bw, bh], output: r.map(v => Math.round(v)) });
      }
    }
    for (const i of covering) report.covers[i]!.frames++;
  });
  // Output-space text the render draws itself (titles, captions), at its widest travel.
  for (const { t, label, box: r } of overlays) {
    report.checked++;
    if (r[0]! < x0 - 0.5 || r[1]! < y0 - 0.5 || r[2]! > x1 + 0.5 || r[3]! > y1 + 0.5) {
      report.failures.push({ frame: Math.round(t * out.fps), t_out: +t.toFixed(3), t_src: +sourceAt(t).toFixed(3), label,
        source: [], output: r.map(v => Math.round(v)) });
    }
  }
  return report;
}
