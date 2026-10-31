#!/usr/bin/env node
// Do the absolute smoothness bars hold on every source and export shape? One cell is one source
// take planned by the recorded planner (recorded-planner.ts) and rendered at one export shape (the same renderTake the
// product runs), then measured with scripts/quality.ts's own measureRender on the decoded MP4:
// pan acceleration, pan bounce, subpixel judder, banding, hitches, 60 fps, bt709, text cuts. The wall
// time of the render is recorded; run each cell under `/usr/bin/time -f '%e %U %S %M'` for its CPU.
// Nothing is tuned or hidden: every bar a cell misses is written out with its value and goal.
//
//   node scripts/verification/smooth-matrix.ts <work-dir> <source>:<aspect> [...]
//   sources: scene-landscape scene-portrait scene-square (headless board captures), synth, phone
//   aspects: landscape portrait square 4:5
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULTS } from "../../src/camera/defaults.ts";
import { makeTake } from "../../src/make.ts";
import { renderDimensions } from "../../src/cli.ts";
import { renderTake } from "../../src/render/render.ts";
import { measureRender, type Metrics } from "../quality.ts";
import { RECORDED_KEY, recordedPlanner } from "./recorded-planner.ts";

const SOURCES: Record<string, { script: string; args: string[]; divider: number }> = {
  // The titled take is the default footage: an untitled one fails render's safe-area gate on push-ins.
  // divider = the straight source edge a banded card's judder tracks (as scripts/quality.ts); -1 where
  // the layout has none, which reports judder as not measured instead of tracking a wrong edge.
  "scene-landscape": { script: "headless-scene.mjs", args: ["--cursor=hidden"], divider: 570.7 },
  "scene-portrait": { script: "headless-scene.mjs", args: ["--cursor=hidden", "--aspect=portrait"], divider: -1 },
  "scene-square": { script: "headless-scene.mjs", args: ["--cursor=hidden", "--aspect=square"], divider: -1 },
  synth: { script: "synth-take.ts", args: [], divider: 319 },
  phone: { script: "synth-portrait.ts", args: [], divider: -1 },
};

const [work, ...cells] = process.argv.slice(2);
if (!work || !cells.length || cells.some(c => !SOURCES[c.slice(0, c.indexOf(":"))] || !c.includes(":"))) {
  console.error("usage: smooth-matrix.ts <work-dir> <source>:<aspect>...  sources: " + Object.keys(SOURCES).join(" "));
  process.exit(2);
}
for (const cell of cells) {
  const [source, aspect] = [cell.slice(0, cell.indexOf(":")), cell.slice(cell.indexOf(":") + 1)] as [string, string];
  const { script, args, divider } = SOURCES[source]!;
  const dir = resolve(work, `${source}-${aspect.replace(":", "x")}`);
  const dims = renderDimensions(aspect);
  let d = { ...DEFAULTS, fps: 60, caption_font: "Liberation Sans", out_w: Number(dims.out_w), out_h: Number(dims.out_h) };
  mkdirSync(resolve(work), { recursive: true });
  if (!existsSync(join(dir, "take.json"))) {
    execFileSync(process.execPath, [resolve("scripts", script), dir, ...args], { stdio: ["ignore", "inherit", "inherit"] });
    await makeTake(dir, { apiKey: RECORDED_KEY, fetchImpl: recordedPlanner(), film: false, camera: d });
  }
  const t0 = performance.now();
  const rendered = await renderTake(dir, d);
  const wall = (performance.now() - t0) / 1000;
  // renderTake gives a phone take its handset card; the measurement must read the same stage.
  const meta = JSON.parse(readFileSync(join(dir, "take.json"), "utf8"));
  if (meta.device !== undefined && meta.height > meta.width) d = { ...d, corner_radius: 36, stage_margin: Math.max(0.16, d.stage_margin) };
  const m = await measureRender(dir, rendered.out, d, { deterministic: null, divider });
  const unmet = Object.entries(m.metrics as Metrics).filter(([, v]) => !v.goalPassed).map(([k, v]) => `${k} ${v.value} (goal ${v.direction === "max" ? "<=" : ">="} ${v.target})`);
  const row = {
    cell, size: `${d.out_w}x${d.out_h}`, source: `${meta.width}x${meta.height}`, seconds: camera(m.camera), renderWallSeconds: wall,
    judder: m.edge, metrics: Object.fromEntries(Object.entries(m.metrics as Metrics).map(([k, v]) => [k, v.value])), unmet,
  };
  writeFileSync(join(dir, "matrix-row.json"), JSON.stringify(row, null, 2) + "\n");
  console.log(JSON.stringify(row));
}
function camera(frames: { t: number }[]) { return Number((frames.at(-1)!.t).toFixed(2)); }
