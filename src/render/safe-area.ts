// Output safe-area gate for takes that carry their on-screen text boxes (text-boxes.json,
// written by the headless scene producer). Every box is projected through the final camera
// exactly as the cursor overlay is, so the check judges the placement that is rendered.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CameraFrame } from "../camera/types.ts";

/** Fraction of the output width and height kept clear of text on every side. */
export const SAFE_INSET = 0.05;
type Box = [number, number, number, number, string];
export interface SafeAreaReport {
  out: { w: number; h: number }; safe: [number, number, number, number]; frames: number; checked: number;
  failures: { frame: number; t_out: number; t_src: number; label: string; source: number[]; output: number[] }[];
}

/** Null when the take has no text boxes. `sourceAt` maps an output second to a video second. */
export function safeAreaReport(dir: string, frames: CameraFrame[], origin: { x: number; y: number },
  out: { w: number; h: number; fps: number }, sourceAt: (t: number) => number): SafeAreaReport | null {
  const file = join(dir, "text-boxes.json");
  if (!existsSync(file)) return null;
  const { samples } = JSON.parse(readFileSync(file, "utf8")) as { samples: { t: number; boxes: Box[] }[] };
  const [x0, y0, x1, y1] = [out.w * SAFE_INSET, out.h * SAFE_INSET, out.w * (1 - SAFE_INSET), out.h * (1 - SAFE_INSET)];
  const report: SafeAreaReport = { out: { w: out.w, h: out.h }, safe: [x0, y0, x1, y1], frames: frames.length, checked: 0, failures: [] };
  let k = 0;
  frames.forEach((f, frame) => {
    const t = sourceAt(frame / out.fps);
    if (k > 0 && samples[k - 1]!.t > t + 1e-6) k = 0;
    while (k < samples.length && samples[k]!.t <= t + 1e-6) k++;
    const sx = out.w / f.w, sy = out.h / f.h;
    for (const [bx, by, bw, bh, label] of samples[Math.max(0, k - 1)]?.boxes ?? []) {
      const r = [(bx + origin.x - f.x) * sx, (by + origin.y - f.y) * sy, (bx + bw + origin.x - f.x) * sx, (by + bh + origin.y - f.y) * sy];
      // A box wholly outside the output is not shown; one shown in part counts in full.
      if (r[2]! <= 0 || r[3]! <= 0 || r[0]! >= out.w || r[1]! >= out.h) continue;
      report.checked++;
      if (r[0]! < x0 - 0.5 || r[1]! < y0 - 0.5 || r[2]! > x1 + 0.5 || r[3]! > y1 + 0.5) {
        report.failures.push({ frame, t_out: +(frame / out.fps).toFixed(3), t_src: +t.toFixed(3), label,
          source: [bx, by, bw, bh], output: r.map(v => Math.round(v)) });
      }
    }
  });
  return report;
}
