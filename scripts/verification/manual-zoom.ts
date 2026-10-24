#!/usr/bin/env node
// Does each manual zoom arrive at its requested time and hold? For one rendered take, every
// take.json zoom is measured on the take's camera.json projected through the stage exactly as the
// render does: when the move into the zoomed-in view that shows the box up to the span's end comes
// to rest (arrival), how late that is against the requested t0 on the output clock, how long it holds,
// whether the requested box stays whole, the depth against the rest framing, and the move's
// camera gates (cameraMetrics from scripts/quality.ts, on the shown window). Exit 2 is a usage or input error. Takes with cuts or
// speed regions are refused: their edited clock is not reproduced here.
//
//   node manual-zoom.ts <rendered-take-dir> <out_w>x<out_h>
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTheme } from "../../src/themes.ts";
import { actionCameraMilliseconds } from "../../src/beats/clock.ts";
import { idleSqueezes, purposefulEnd, warp } from "../../src/render/pace.ts";
import { sourceViewport, stageGeometry } from "../../src/render/stage.ts";
import type { Beat, CameraFrame, TakeMeta } from "../../src/camera/types.ts";
import { cameraMetrics } from "../quality.ts";

const [dir, size] = process.argv.slice(2);
const [ow, oh] = (size ?? "").split("x").map(Number);
if (!dir || !ow || !oh) {
  console.error("usage: manual-zoom.ts <rendered-take-dir> <out_w>x<out_h>");
  process.exit(2);
}
const json = <T>(file: string) => JSON.parse(readFileSync(join(dir, file), "utf8")) as T;
const meta = json<TakeMeta>("take.json");
if (meta.cuts?.length || meta.speed?.length) {
  console.error("manual-zoom: takes with cuts or speed regions are not supported");
  process.exit(2);
}
if (!meta.zooms?.length) {
  console.error("manual-zoom: take.json has no zooms");
  process.exit(2);
}
const beats = json<Beat[]>("analysis/beats.json");
const frames = json<CameraFrame[]>("camera.json");
const phone = meta.device !== undefined && meta.height > meta.width;
const theme = resolveTheme(meta.theme);
// A phone take renders with the handset card the render gives it.
const d = { ...theme, out_w: ow, out_h: oh, ...(phone ? { corner_radius: 36, stage_margin: Math.max(0.16, theme.stage_margin) } : {}) };
const clockBeats = beats.map((b) => ({ ...b, actions: b.actions.map(actionCameraMilliseconds) }));
const start = meta.trim_start ?? 0;
const end = meta.trim_end ?? purposefulEnd(clockBeats, start, meta.duration ?? Math.max(0, ...beats.map((b) => b.t1)), d);
const squeezes = idleSqueezes(clockBeats, start, end, d);
const stage = stageGeometry(meta.width, meta.height, d);
const views = frames.map((f) => sourceViewport(f, meta.width, meta.height, stage, d));
const out = (t: number) => warp(Math.min(end, Math.max(start, t)) - start, squeezes, d.idle_speed);
const index = (t: number) => Math.max(0, Math.min(views.length - 1, Math.round(out(t) * d.fps)));
const same = (a: CameraFrame, b: CameraFrame) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.w - b.w) <= 0.5;
const whole = (v: CameraFrame, [x, y, w, h]: number[]) => x! >= v.x - 0.5 && y! >= v.y - 0.5 && x! + w! <= v.x + v.w + 0.5 && y! + h! <= v.y + v.h + 0.5;
const round = (n: number, k = 3) => Math.round(n * 10 ** k) / 10 ** k;
const rest = views[0]!;
const zooms = meta.zooms.map((z, n) => {
  const last = index(Math.min(z.t1, end) - 1e-6);
  const requested = out(Math.max(start, z.t0));
  // The zoomed-in run that shows the box whole up to the span's end; the hold arrives where the
  // move into that run first comes to rest (a later widening inside the hold is not the arrival).
  const zoomedIn = (v: CameraFrame) => v.w < rest.w * 0.99 && whole(v, z.bbox);
  let run = last + 1;
  while (run > 0 && zoomedIn(views[run - 1]!)) run--;
  if (run > last) return { zoom: n + 1, box: z.bbox, requested_s: round(requested), zoomed: false, depth: round(rest.w / views[last]!.w, 2) };
  let arrived = run;
  while (arrived < last && !same(views[arrived]!, views[arrived + 1]!)) arrived++;
  let move = arrived;
  while (move > 0 && !same(views[move - 1]!, views[move]!)) move--;
  // The move with a still frame on each side, so its start and stop count toward acceleration.
  const path = views.slice(Math.max(0, move - 1), Math.min(views.length, arrived + 2));
  const gates = path.length < 3 ? "no move" : Object.fromEntries(Object.entries(cameraMetrics(path, d.fps, ow, oh, d.min_shot))
    .map(([name, m]) => [name, { value: round(m.value), limit: m.target }]));
  return {
    zoom: n + 1, box: z.bbox, requested_s: round(requested), move_start_s: round(move / d.fps), arrived_s: round(arrived / d.fps),
    late_s: round(Math.max(0, arrived / d.fps - requested)), held_s: round((last - arrived) / d.fps), zoomed: true,
    box_whole: views.slice(arrived, last + 1).every((v) => whole(v, z.bbox)), depth: round(rest.w / views[arrived]!.w, 2), move: gates,
  };
});
console.log(JSON.stringify({ take: meta.id, out: `${ow}x${oh}`, phone, frames: views.length, zooms }, null, 1));
