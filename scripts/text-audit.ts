#!/usr/bin/env node
// Source-relative text fidelity of a rendered take. Each sampled output frame is traced back through
// the render's own camera to the source frame it shows, and judged only where the source says what
// the pixel must be:
//   grain      luma std inside 8x8 output blocks whose whole source footprint is one flat value (source: 0)
//   halo       how far a text-edge pixel overshoots the source's own min/max under its footprint
//   sharpness  text-edge gradient energy over an area-resampled source reference (smear reads below 1)
// Frames are split by camera speed like cut-audit; fades and fast sweeps (motion blur) are reported, not gated.
// usage: node scripts/text-audit.ts <rendered-take-dir>... [--every N]
import { execFileSync } from "node:child_process";
import { basename, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { renderClock } from "./cut-audit.ts";
import { edgeSpeed, still, SWEEP_EDGE_SPEED } from "../src/camera/sweep.ts";
import { existsSync, readFileSync } from "node:fs";
import { sourceViewport, stageGeometry } from "../src/render/stage.ts";
import type { CameraFrame } from "../src/camera/types.ts";
import type { Storyboard } from "../src/motion/types.ts";

/** Gates, fixed before measuring: half an 8-bit level of grain, a quarter of the quality gate's edge floor gone, a visible fringe. */
export const GATES = { grain: 0.5, halo: 8, sharpness: 0.75 };
const B = 8, EDGE = 48, NEUTRAL = 4;
type Kind = "rest" | "slow" | "fast" | "fade";
interface Tally { frames: number; flatBlocks: number; variance: number; edgePixels: number; overshoot: number[]; energy: number; reference: number; skipped: number }
export interface TextAudit { take: string; source: string; output: string; classes: Record<Kind, { frames: number; flatBlocks: number; grain: number | null;
  edgePixels: number; haloP99: number | null; sharpness: number | null; skippedBlocks: number }>; failures: string[] }

function decode(file: string, second: number, frames: number, fmt: string, size: number): Uint8Array[] {
  const raw = execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-threads", "2", "-ss", Math.max(0, second).toFixed(6), "-i", file,
    "-frames:v", String(frames), "-pix_fmt", fmt, "-f", "rawvideo", "-"], { maxBuffer: 1 << 30 });
  if (raw.length !== size * frames) throw new Error(`${file}: ${raw.length} bytes for ${frames} ${fmt} frames at ${second} s`);
  return Array.from({ length: frames }, (_, k) => raw.subarray(k * size, k * size + size));
}

export function auditText(dir: string, every = 15): TextAudit {
  const motion = existsSync(join(dir, "storyboard.json"));
  let W: number, H: number, OW: number, OH: number, fps: number, frames: CameraFrame[], video: string, source: string;
  let viewport: (frame: CameraFrame) => CameraFrame, sourceTime: (frame: CameraFrame) => number, fade: number;
  if (motion) {
    const sb = JSON.parse(readFileSync(join(dir, "storyboard.json"), "utf8")) as Storyboard;
    const render = JSON.parse(readFileSync(join(dir, "render.json"), "utf8")) as { engine?: string; out: string; frames: number; fps: number; width: number; height: number };
    if (render.engine !== "hyperframes") throw new Error(`${dir}: A11 motion audit requires the HyperFrames output`);
    if (sb.layout.kind !== "single" || sb.clips || sb.scenes.some(s => s.pattern === "clip")) throw new Error(`${dir}: audit only supports single-screen image motion films`);
    const screens = new Set(sb.scenes.map(s => s.screen ?? Object.keys(sb.screens)[0]));
    if (screens.size !== 1) throw new Error(`${dir}: audit requires one source screen throughout the film`);
    const screen = sb.screens[[...screens][0]!];
    if (!screen) throw new Error(`${dir}: storyboard has no source screen`);
    W = screen.width; H = screen.height; OW = render.width; OH = render.height; fps = render.fps;
    const track = existsSync(join(dir, "camera.json")) ? JSON.parse(readFileSync(join(dir, "camera.json"), "utf8")) as CameraFrame[] : [];
    if (!Array.isArray(track)) throw new Error(`${dir}: motion audit needs a single-screen camera track`);
    frames = Array.from({ length: render.frames }, (_, i) => track[i] ?? { t: i / fps, x: 0, y: 0, w: W, h: H });
    source = isAbsolute(screen.file) ? screen.file : join(dir, screen.file);
    video = join(dir, render.out);
    viewport = frame => frame;
    sourceTime = () => 0;
    fade = 0;
  } else {
    const { meta, d, frames: cameraFrames, sourceAt } = renderClock(dir);
    if (meta.title || meta.captions?.length) throw new Error(`${dir}: titled takes render into the fixed text band; audit an untitled copy`);
    if (d.out_w > d.out_h !== meta.width > meta.height) throw new Error(`${dir}: crop-to-fill exports are not modelled`);
    W = meta.width; H = meta.height; OW = d.out_w; OH = d.out_h; fps = d.fps; frames = cameraFrames;
    const st = stageGeometry(W, H, d);
    source = join(dir, "screen.webm");
    video = join(dir, "out", `${meta.id ?? basename(dir)}.mp4`);
    viewport = frame => sourceViewport(frame, W, H, st, d);
    sourceTime = frame => sourceAt(frame.t);
    fade = Math.min(d.fade_s, (frames.at(-1)!.t + 1 / fps) / 4);
  }
  const sourceFrame = motion ? decode(source, 0, 1, "yuv444p", W * H * 3)[0]! : undefined;
  const tally = Object.fromEntries((["rest", "slow", "fast", "fade"] as Kind[]).map(k => [k,
    { frames: 0, flatBlocks: 0, variance: 0, edgePixels: 0, overshoot: [], energy: 0, reference: 0, skipped: 0 } as Tally])) as Record<Kind, Tally>;
  for (let i = every; i < frames.length - 1; i += every) {
    const f = frames[i]!, p = frames[i - 1]!;
    const kind: Kind = f.t < fade || f.t > frames.at(-1)!.t - fade ? "fade" : still(p, f, OW, OH, fps) ? "rest"
      : edgeSpeed(p, f, OW, OH, fps) >= SWEEP_EDGE_SPEED ? "fast" : "slow";
    const T = tally[kind];
    T.frames++;
    const out = decode(video, (i - 0.25) / fps, 1, "yuv420p", OW * OH * 1.5)[0]!;
    // A source video is judged only where it holds still across adjacent frames; a motion screen is static.
    const [prev, cur] = sourceFrame ? [sourceFrame, sourceFrame] : decode(source, sourceTime(f) - 1 / 60, 2, "yuv444p", W * H * 3);
    const v = viewport(f), s = v.w / OW;
    const sx = (u: number) => v.x - 0.5 + (u + 0.5) * s, sy = (y: number) => v.y - 0.5 + (y + 0.5) * s;
    const at = (x: number, y: number) => {
      const x0 = Math.max(0, Math.min(W - 2, Math.floor(x))), y0 = Math.max(0, Math.min(H - 2, Math.floor(y)));
      const a = x - x0, b = y - y0, k = y0 * W + x0;
      return (cur![k]! * (1 - a) + cur![k + 1]! * a) * (1 - b) + (cur![k + W]! * (1 - a) + cur![k + W + 1]! * a) * b;
    };
    const R = 2 + s / 2;
    for (let by = 0; by + B <= OH; by += B) for (let bx = 0; bx + B <= OW; bx += B) {
      const x0 = Math.floor(sx(bx) - R), x1 = Math.ceil(sx(bx + B - 1) + R), y0 = Math.floor(sy(by) - R), y1 = Math.ceil(sy(by + B - 1) + R);
      if (x0 < 0 || y0 < 0 || x1 >= W || y1 >= H) continue; // stage background, not source
      let lo = 255, hi = 0, moved = false, tinted = false;
      for (let y = y0; y <= y1; y++) for (let x = x0, k = y * W + x0; x <= x1; x++, k++) {
        const value = cur![k]!; lo = Math.min(lo, value); hi = Math.max(hi, value);
        if (value !== prev![k]) moved = true;
        if (Math.abs(cur![W * H + k]! - 128) > NEUTRAL || Math.abs(cur![2 * W * H + k]! - 128) > NEUTRAL) tinted = true;
      }
      if (moved || (hi > lo && hi - lo < EDGE)) continue;
      let sum = 0, square = 0, mismatch = 0, oLo = 255, oHi = 0;
      for (let y = by; y < by + B; y++) for (let x = bx; x < bx + B; x++) {
        const o = out[y * OW + x]!; sum += o; square += o * o; oLo = Math.min(oLo, o); oHi = Math.max(oHi, o);
      }
      if (hi === lo) {
        // Flat source: any spread is added by the render. A drawn overlay (cursor, ripple) is not grain.
        const mean = sum / (B * B), variance = square / (B * B) - mean * mean;
        if ((!tinted && Math.abs(mean - lo) > 3) || oHi - oLo > 32) { T.skipped++; continue; }
        T.flatBlocks++; T.variance += variance;
        continue;
      }
      if (tinted) continue; // BT.601 source and BT.709 output luma differ on colour
      const ref = new Float64Array(B * B), over: number[] = [];
      for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) {
        const cx = sx(bx + x), cy = sy(by + y);
        let r = 0;
        for (let m = 0; m < 4; m++) for (let n = 0; n < 4; n++) r += at(cx + ((n + 0.5) / 4 - 0.5) * s, cy + ((m + 0.5) / 4 - 0.5) * s);
        ref[y * B + x] = r / 16;
        let a = 255, z = 0;
        for (let yy = Math.floor(cy - s / 2 - 1); yy <= Math.ceil(cy + s / 2 + 1); yy++) for (let xx = Math.floor(cx - s / 2 - 1); xx <= Math.ceil(cx + s / 2 + 1); xx++) {
          const value = cur![yy * W + xx]!; a = Math.min(a, value); z = Math.max(z, value);
        }
        const o = out[(by + y) * OW + bx + x]!;
        over.push(Math.max(0, o - z, a - o));
        mismatch += Math.abs(o - ref[y * B + x]!);
      }
      if (mismatch / (B * B) > 25) { T.skipped++; continue; } // overlay or misregistered frame
      for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) {
        const o = (yy: number, xx: number) => out[(by + yy) * OW + bx + xx]!;
        if (x) { T.energy += (o(y, x) - o(y, x - 1)) ** 2; T.reference += (ref[y * B + x]! - ref[y * B + x - 1]!) ** 2; }
        if (y) { T.energy += (o(y, x) - o(y - 1, x)) ** 2; T.reference += (ref[y * B + x]! - ref[(y - 1) * B + x]!) ** 2; }
      }
      T.edgePixels += over.length; T.overshoot.push(...over);
    }
  }
  const classes = Object.fromEntries(Object.entries(tally).map(([k, T]) => {
    const sorted = T.overshoot.sort((a, b) => a - b);
    return [k, { frames: T.frames, flatBlocks: T.flatBlocks, grain: T.flatBlocks ? +Math.sqrt(T.variance / T.flatBlocks).toFixed(3) : null,
      edgePixels: T.edgePixels, haloP99: sorted.length ? sorted[Math.floor(0.99 * (sorted.length - 1))]! : null,
      sharpness: T.reference ? +(T.energy / T.reference).toFixed(3) : null, skippedBlocks: T.skipped }];
  })) as TextAudit["classes"];
  const failures: string[] = [];
  for (const k of ["rest", "slow"] as const) {
    const c = classes[k];
    if (c.grain !== null && c.grain > GATES.grain) failures.push(`${k}: flat UI grain ${c.grain} > ${GATES.grain} luma levels`);
    if (c.haloP99 !== null && c.haloP99 > GATES.halo) failures.push(`${k}: edge overshoot p99 ${c.haloP99} > ${GATES.halo} levels`);
    if (k === "rest" && c.sharpness !== null && c.sharpness < GATES.sharpness) failures.push(`${k}: edge energy ${c.sharpness} < ${GATES.sharpness} of the source`);
  }
  if (!classes.rest.flatBlocks || !classes.rest.edgePixels) failures.push("rest: no flat or edge blocks measured");
  return { take: basename(dir), source: `${W}x${H}`, output: `${OW}x${OH}`, classes, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), flag = args.indexOf("--every");
  const every = flag < 0 ? 15 : Number(args.splice(flag, 2)[1]);
  if (!args.length || !(every >= 1)) throw new Error("usage: node scripts/text-audit.ts <rendered-take-dir>... [--every N]");
  const audits = args.map(dir => auditText(dir, every));
  for (const a of audits) console.log(JSON.stringify(a));
  const failed = audits.flatMap(a => a.failures.map(f => `${a.take} (${a.source}): ${f}`));
  console.log(failed.length ? `FAIL:\n${failed.join("\n")}` : `PASS: no added UI grain, halo or smear at rest or on slow moves (gates ${JSON.stringify(GATES)})`);
  process.exitCode = failed.length ? 1 : 0;
}
