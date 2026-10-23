#!/usr/bin/env node
// Is every act inside the frame the viewer sees? For one rendered take, each click (at its press,
// and over the half second of its approach), each typing burst (its whole field), each scroll and
// each drag sample is checked against the take's camera.json projected through the stage exactly
// as the render does (crop-to-fill included). Prints JSON counts per kind, the moving-frame
// split and every miss; exit 2 is a usage or input error. Takes with cuts or speed regions are
// refused: their edited clock is not reproduced here.
//
//   node act-framing.ts <rendered-take-dir> <out_w>x<out_h>
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTheme } from "../../src/themes.ts";
import { actionCameraMilliseconds } from "../../src/beats/clock.ts";
import { idleSqueezes, purposefulEnd, warp } from "../../src/render/pace.ts";
import { sourceViewport, stageGeometry } from "../../src/render/stage.ts";
import type { Beat, CameraFrame, TakeMeta } from "../../src/camera/types.ts";

const [dir, size] = process.argv.slice(2);
const [ow, oh] = (size ?? "").split("x").map(Number);
if (!dir || !ow || !oh) {
  console.error("usage: act-framing.ts <rendered-take-dir> <out_w>x<out_h>");
  process.exit(2);
}
const json = <T>(file: string) => JSON.parse(readFileSync(join(dir, file), "utf8")) as T;
const meta = json<TakeMeta>("take.json");
if (meta.cuts?.length || meta.speed?.length) {
  console.error("act-framing: takes with cuts or speed regions are not supported");
  process.exit(2);
}
const beats = json<Beat[]>("analysis/beats.json");
const frames = json<CameraFrame[]>("camera.json");
const d = { ...resolveTheme(meta.theme), out_w: ow, out_h: oh };
// The render's own clock: action times in ms before pacing, as renderTake converts them.
const clockBeats = beats.map((b) => ({ ...b, actions: b.actions.map(actionCameraMilliseconds) }));
const start = meta.trim_start ?? 0;
const end = meta.trim_end ?? purposefulEnd(clockBeats, start, meta.duration ?? Math.max(0, ...beats.map((b) => b.t1)), d);
const squeezes = idleSqueezes(clockBeats, start, end, d);
const stage = stageGeometry(meta.width, meta.height, d);
const views = frames.map((f) => sourceViewport(f, meta.width, meta.height, stage, d));
const index = (t: number) => Math.max(0, Math.min(views.length - 1, Math.round(warp(t - start, squeezes, d.idle_speed) * d.fps)));
const moving = (i: number) => i > 0 && Math.abs(views[i]!.x - views[i - 1]!.x) + Math.abs(views[i]!.y - views[i - 1]!.y)
  + Math.abs(views[i]!.w - views[i - 1]!.w) > 0.5;
const whole = (v: CameraFrame, [x, y, w, h]: number[]) => x! >= v.x && y! >= v.y && x! + w! <= v.x + v.w && y! + h! <= v.y + v.h;
// The pointer with the margin the press shots keep: a 1/60-of-the-screen square.
const near = meta.width / 60;
const point = (x: number, y: number) => [x - near / 2, y - near / 2, near, near];
const steps = (t0: number, t1: number) => Array.from({ length: Math.floor((t1 - t0) * 30 + 1e-9) + 1 }, (_, i) => t0 + i / 30);

type Probe = { beat: string; kind: string; t: number; box: number[]; at: string };
const probes: Probe[] = beats.flatMap((beat) => beat.actions.flatMap((a): Probe[] => {
  const p = a as { k: string; t?: number; t0?: number; t1?: number; x?: number; y?: number; region?: number[]; path?: { t: number; x: number; y: number }[] };
  // Each probe names the act by where it happened: the pointer (x,y), or the typed field (x,y,w,h).
  const at = (...n: number[]) => n.map(Math.round).join(",");
  if (p.k === "click") return [{ beat: beat.id, kind: "click", t: p.t!, box: point(p.x!, p.y!), at: at(p.x!, p.y!) },
    ...steps(Math.max(start, p.t! - 0.5), p.t!).map((t) => ({ beat: beat.id, kind: "approach", t, box: point(p.x!, p.y!), at: at(p.x!, p.y!) }))];
  if (p.k === "type" && p.region) return steps(p.t0!, p.t1!).map((t) => ({ beat: beat.id, kind: "type", t, box: p.region!, at: at(...p.region!) }));
  if (p.k === "scroll") return steps(p.t0!, p.t1!).map((t) => ({ beat: beat.id, kind: "scroll", t, box: point(p.x!, p.y!), at: at(p.x!, p.y!) }));
  if (p.k === "drag" && p.path) return p.path.filter((_, i) => i % 2 === 0).map((s) => ({ beat: beat.id, kind: "drag", t: s.t, box: point(s.x, s.y), at: at(s.x, s.y) }));
  return [];
}));
const result: Record<string, unknown> = { take: meta.id, out: `${ow}x${oh}`, frames: views.length };
const tally = (list: Probe[]) => ({ n: list.length, framed: list.filter((p) => whole(views[index(p.t)]!, p.box)).length });
for (const kind of ["click", "approach", "type", "scroll", "drag"]) result[kind] = tally(probes.filter((p) => p.kind === kind));
result.all = tally(probes.filter((p) => p.kind !== "approach"));
result.during_moves = tally(probes.filter((p) => moving(index(p.t))));
result.moving_frames = views.filter((_, i) => moving(i)).length;
result.misses = probes.filter((p) => !whole(views[index(p.t)]!, p.box)).reduce<Record<string, number>>((all, p) => {
  const key = `${p.beat} ${p.kind} at ${p.at}`;
  all[key] = (all[key] ?? 0) + 1;
  return all;
}, {});
console.log(JSON.stringify(result, null, 1));
