#!/usr/bin/env node
// Rebuild the Tidewater overlay demo from fictional HTML in an isolated headless browser.
// node scripts/synth-overlays.ts <output-dir>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULTS } from "../src/camera/defaults.ts";
import { renderTake } from "../src/render/render.ts";
import type { Beat, Decision, TakeMeta } from "../src/camera/types.ts";

const root = resolve(process.argv[2] ?? "tmp/overlays");
await mkdir(root, { recursive: true });
const session = `takeone-overlays-${createHash("sha256").update(root).digest("hex").slice(0, 10)}`;
const env = { ...process.env, CHROME_DEVTOOLS_AXI_SESSION: session };
const browser = (...args: string[]) => execFileSync("chrome-devtools-axi", args, { env, maxBuffer: 4_000_000 });
const light = join(root, "tidewater-light.png");
const dark = join(root, "tidewater-dark.png");
try {
  browser("newpage", new URL("./e2e/scene.html", import.meta.url).href);
  browser("resize", "3840", "2160");
  browser("eval", `() => {
    document.documentElement.style.width = '3840px';
    document.documentElement.style.height = '2160px';
    document.body.style.zoom = '1.5';
    return document.title;
  }`);
  browser("screenshot", light);
  browser("eval", `() => {
    const theme = {'--bg':'#10151d','--panel':'#19222e','--ink':'#eef4fa','--muted':'#a4afbd','--line':'#334252'};
    for (const [key, value] of Object.entries(theme)) document.documentElement.style.setProperty(key, value);
    return document.title;
  }`);
  browser("screenshot", dark);
} finally {
  browser("stop"); // Only this fixture's named browser session.
}

const source = join(root, "screen.webm");
execFileSync("ffmpeg", ["-y", "-v", "error", "-loop", "1", "-framerate", "60", "-t", "5", "-i", light,
  "-loop", "1", "-framerate", "60", "-t", "5", "-i", dark,
  "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p", "-an", "-c:v", "libvpx-vp9",
  "-deadline", "realtime", "-cpu-used", "8", "-lossless", "1", source]);
const rect = (values: [number, number, number, number]): [number, number, number, number] =>
  values.map(value => value * 1.5) as [number, number, number, number];
const base: TakeMeta = { id: "demo", width: 3840, height: 2160, trim_end: 10,
  captions: [{ t: 1.7, d: 2.8, text: "Find any task on the launch board" },
    { t: 5.7, d: 2.8, text: "Save your progress" }] };
const beats: Beat[] = [
  { id: "search", t0: 0, t1: 5, anchor_t: 2, kind: "shortcut", actions: [],
    zones: [{ name: "search", type: "act", bbox: rect([980, 20, 600, 48]) }] },
  { id: "save", t0: 5, t1: 10, anchor_t: 6, kind: "shortcut", actions: [],
    zones: [{ name: "save", type: "act", bbox: rect([2200, 20, 200, 48]) }] },
];
const decisions: Decision[] = beats.map(b => ({ beat: b.id, A: b.zones[0]!.name, L: 1,
  p: 0, K: 0, conf: 1, decided_by: "synthetic" }));
const d = { ...DEFAULTS, idle_speed: 1, fade_s: 0, preset: "fast" };
for (const version of ["before", "after"] as const) {
  const dir = join(root, version);
  await mkdir(join(dir, "analysis"), { recursive: true });
  await writeFile(join(dir, "screen.webm"), await readFile(source));
  const meta: TakeMeta = { ...base };
  const b = structuredClone(beats);
  if (version === "after") {
    meta.spotlight = [{ t: 1.5, d: 3, rect: rect([950, 0, 660, 92]) }];
    meta.blur = [{ t: 0, d: 10, rect: rect([2000, 310, 490, 55]) }];
    b[0]!.actions = [{ k: "shortcut", t: 2000, combo: "Ctrl+K" },
      { k: "key", t: 2100, cls: "char", down: true, char: "NEVER_RENDER_THIS", text: "NEVER_RENDER_THIS" },
      { k: "shortcut", t: 2200, combo: "Ctrl+NEVER_RENDER_THIS" }];
    b[1]!.actions = [{ k: "shortcut", t: 6000, combo: "Ctrl+S" }];
  }
  await writeFile(join(dir, "take.json"), JSON.stringify(meta));
  await writeFile(join(dir, "analysis/beats.json"), JSON.stringify(b));
  await writeFile(join(dir, "analysis/decisions.jsonl"), decisions.map(v => JSON.stringify(v)).join("\n"));
  const { out } = await renderTake(dir, d);
  execFileSync("ffmpeg", ["-y", "-v", "error", "-ss", "2.5", "-i", out, "-frames:v", "1",
    join(root, `takeone-overlays-${version}.png`)]);
}
execFileSync("ffmpeg", ["-y", "-v", "error", "-i", join(root, "before/out/demo.mp4"),
  "-i", join(root, "after/out/demo.mp4"), "-filter_complex",
  "[0:v]scale=960:540[a];[1:v]scale=960:540[b];[a][b]hstack", "-an", "-c:v", "libx264",
  "-crf", "18", "-preset", "fast", join(root, "takeone-overlays-before-after.mp4")]);
await writeFile(join(root, "takeone-overlays-after.mp4"), await readFile(join(root, "after/out/demo.mp4")));
console.log(root);
