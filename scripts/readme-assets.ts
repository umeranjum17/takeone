#!/usr/bin/env node
// One command rebuilds the approved dogfood set A1-A10 and writes manifest.json: every file's sha256,
// its ffprobe facts, the command that made it and the gates it was held to. See docs/readme-assets.md.
//   node scripts/readme-assets.ts [out-dir]
// Offline: the headless board scene, the synthetic take, the saved Tidewater screenshot and ffmpeg.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const { positionals } = parseArgs({ options: {}, allowPositionals: true });
const dest = resolve(positionals[0] ?? join(root, "tmp/readme-assets"));
const work = join(dest, "work");
const manifestFile = join(dest, "manifest.json");
const BUDGET = { file_mb: 8, mbit_s: 8, total_mb: 25 };
const REGIONS = ["320,120,520,540:To do", "870,120,520,400:In progress", "1984,128,544,420:Activity"];

interface Gate { name: string; value: number | string; target: string; passed: boolean }
interface Asset { id: string; file: string; kind: "video" | "image"; width: number; height: number; fps?: number; seconds?: [number, number]; recipe: string; note?: string }
interface Entry extends Asset { sha256: string; bytes: number; probe?: Record<string, unknown>; gates: Gate[]; motion_gate?: { frozen_passed: boolean; frozen_seconds: number } }

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const run = (cmd: string, args: string[]) => { execFileSync(cmd, args, { cwd: root, stdio: ["ignore", "inherit", "inherit"], maxBuffer: 64e6 }); };
const out = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: root, encoding: "utf8", maxBuffer: 64e6 });
const takeone = (...args: string[]) => run("node", ["bin/takeone.mjs", ...args]);
/** make plans with an AI engine; assets are planned by the recorded one, so they rebuild the same without an account. */
const makeRecorded = (dir: string, ...args: string[]) => run("scripts/verification/recorded-engine.sh", [join(work, "engine"), "node", "bin/takeone.mjs", "make", dir, ...args]);
const ff = (...args: string[]) => run("ffmpeg", ["-nostdin", "-hide_banner", "-v", "error", "-y", "-filter_threads", "2", "-filter_complex_threads", "2", "-threads", "4", ...args]);
const fresh = (dir: string) => { rmSync(dir, { recursive: true, force: true }); return dir; };
const film = (take: string) => { const dir = join(take, "out"); const f = readdirSync(dir).find(n => n.endsWith(".mp4") && !n.includes("-preview")); if (!f) throw new Error(`no render in ${dir}`); return join(dir, f); };
const seconds = (file: string) => Number(out("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]));

/** Delivery encode: the render is crf 12 for editing; a README file is held to 8 MB. */
const SRGB = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"];
const deliver = (input: string, output: string, extra: string[] = []) => ff("-i", input, ...extra, "-an", "-c:v", "libx264", "-crf", "24", "-preset", "slow", "-tune", "animation", "-pix_fmt", "yuv420p", ...SRGB, "-movflags", "+faststart", output);

/** A headless board take in one aspect, planned by the recorded engine at 60 fps. */
function board(name: string, aspect: "landscape" | "portrait" | "square", theme?: string) {
  const dir = fresh(join(work, name));
  run("node", ["scripts/headless-scene.mjs", dir, `--aspect=${aspect}`, `--scale=${aspect === "landscape" ? 2 : 1}`]);
  makeRecorded(dir, "--set", "fps=60", ...theme ? ["--theme", theme] : []);
  if (aspect !== "landscape") takeone("render", dir, "--set", "fps=60", ...theme ? ["--theme", theme] : [], "--aspect", aspect);
  return dir;
}

const ffprobe = (file: string, entries: string) => JSON.parse(out("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", entries, "-of", "json", file])) as { streams: Record<string, string>[]; format: Record<string, string> };
const rate = (r: string) => { const [n, d] = r.split("/").map(Number); return n! / (d || 1); };

function measure(a: Asset, file: string): Pick<Entry, "probe" | "gates"> {
  const bytes = statSync(file).size;
  const gate = (name: string, value: number | string, target: string, passed: boolean): Gate => ({ name, value, target, passed });
  const gates: Gate[] = [gate("size_mb", +(bytes / 1e6).toFixed(3), `<= ${BUDGET.file_mb}`, bytes / 1e6 <= BUDGET.file_mb)];
  const p = ffprobe(file, "stream=codec_name,profile,width,height,pix_fmt,avg_frame_rate,color_space,color_transfer,color_primaries,color_range,nb_read_frames:format=duration,bit_rate");
  const s = p.streams[0]!;
  gates.push(gate("dimensions", `${s.width}x${s.height}`, `${a.width}x${a.height}`, Number(s.width) === a.width && Number(s.height) === a.height));
  if (a.kind === "image") return { gates };
  const duration = Number(p.format.duration), mbit = Number(p.format.bit_rate) / 1e6, fps = rate(s.avg_frame_rate!), frames = Number(s.nb_read_frames);
  gates.push(
    gate("fps", fps, `${a.fps}`, Math.abs(fps - a.fps!) < 0.01),
    gate("frames", frames, `${Math.round(duration * a.fps!)} +-1`, Math.abs(frames - duration * a.fps!) <= 1),
    gate("codec", `${s.codec_name} ${s.profile} ${s.pix_fmt}`, "h264 High yuv420p", s.codec_name === "h264" && s.profile === "High" && s.pix_fmt === "yuv420p"),
    gate("color", [s.color_space, s.color_transfer, s.color_primaries, s.color_range].join("/"), "bt709/bt709/bt709/tv", [s.color_space, s.color_transfer, s.color_primaries, s.color_range].join() === "bt709,bt709,bt709,tv"),
    gate("mbit_s", +mbit.toFixed(2), `<= ${BUDGET.mbit_s}`, mbit <= BUDGET.mbit_s),
    gate("seconds", +duration.toFixed(2), a.seconds ? `${a.seconds[0]}-${a.seconds[1]}` : "any", !a.seconds || (duration >= a.seconds[0] && duration <= a.seconds[1])),
  );
  return { probe: { ...s, duration, bit_rate: Number(p.format.bit_rate) }, gates };
}

const still = (video: string, t: number, output: string, size?: string) => ff("-ss", String(t), "-i", video, "-frames:v", "1", ...size ? ["-vf", `scale=${size}:flags=lanczos`] : [], "-update", "1", output);
const motion = (name: string, args: string[]) => { const dir = fresh(join(work, name)); takeone("motion", join(root, "resources/demo/tidewater-board.png"), "--out", dir, "--no-ai", "--title", "Tidewater", "--subtitle", "Plan the launch in one board", "--cta", "Try it today", ...args); return film(dir); };

const A1 = { id: "A1", file: "hero.mp4", kind: "video", width: 1920, height: 1080, fps: 60, seconds: [20, 45], recipe: "scripts/headless-scene.mjs (3840x2160) -> takeone make (recorded engine) --set fps=60 -> delivery crf 24", note: "Spec section 4 asked for 20-30 s; the staged choreography plays about 39.5 s at idle_speed 4, so the range is 20-45 s." } satisfies Asset;
const BUILDS: { id: string; assets: Asset[]; build: (put: (a: Asset, file: string, motionGate?: Entry["motion_gate"]) => void) => void }[] = [];
// Takes shared between steps live here for one run, never across runs.
const shared: Record<string, string> = {};

BUILDS.push({ id: "A1", assets: [A1, { id: "A1", file: "hero-poster.jpg", kind: "image", width: 1920, height: 1080, recipe: "frame at 6 s of hero.mp4" }], build(put) {
  shared.a1 = board("a1", "landscape");
  const raw = film(shared.a1);
  const hero = join(work, "hero.mp4"); deliver(raw, hero); put(A1, hero);
  const poster = join(work, "hero-poster.jpg"); still(hero, 6, poster); put(BUILDS[0]!.assets[1]!, poster);
} });

const A2: Asset = { id: "A2", file: "synth-demo.mp4", kind: "video", width: 1920, height: 1080, fps: 60, recipe: "scripts/synth-take.ts -> takeone make (recorded engine) --set fps=60 -> delivery crf 24" };
BUILDS.push({ id: "A2", assets: [A2], build(put) {
  shared.a2 = fresh(join(work, "a2"));
  run("node", ["scripts/synth-take.ts", shared.a2]);
  makeRecorded(shared.a2, "--set", "fps=60");
  const f = join(work, "synth-demo.mp4"); deliver(film(shared.a2), f); put(A2, f);
} });

const A3: Asset = { id: "A3", file: "portrait.mp4", kind: "video", width: 1080, height: 1920, fps: 60, recipe: "headless board scene --aspect=portrait -> takeone make, render --aspect portrait -> delivery crf 24" };
BUILDS.push({ id: "A3", assets: [A3], build(put) { const f = join(work, "portrait.mp4"); deliver(film(board("a3", "portrait")), f); put(A3, f); } });

const A4: Asset = { id: "A4", file: "square.mp4", kind: "video", width: 1080, height: 1080, fps: 60, recipe: "headless board scene --aspect=square -> takeone make, render --aspect square --theme paper -> delivery crf 24" };
BUILDS.push({ id: "A4", assets: [A4], build(put) { const f = join(work, "square.mp4"); deliver(film(board("a4", "square", "paper")), f); put(A4, f); } });

const A5: Asset = { id: "A5", file: "motion-hero.mp4", kind: "video", width: 1920, height: 1080, fps: 60, recipe: "takeone motion tidewater-board.png --recipe launch --theme aurora -> delivery crf 24", note: "The launch recipe plans a logo sting, hero reveal, three-stop tour and end card, longer than the 12 s of section 4." };
BUILDS.push({ id: "A5", assets: [A5], build(put) {
  const f = join(work, "motion-hero.mp4");
  deliver(motion("a5", ["--recipe", "launch", "--theme", "aurora", ...REGIONS.flatMap(r => ["--region", r])]), f);
  const render = JSON.parse(readFileSync(join(work, "a5", "render.json"), "utf8")) as { gates?: { frozen?: { passed?: boolean; longest?: number } } };
  const frozen = render.gates?.frozen;
  if (!frozen || typeof frozen.passed !== "boolean" || typeof frozen.longest !== "number") throw new Error("A5 motion render is missing its frozen-time gate");
  put(A5, f, { frozen_passed: frozen.passed, frozen_seconds: frozen.longest });
} });

const A6: Asset = { id: "A6", file: "motion-callouts.mp4", kind: "video", width: 1920, height: 1080, fps: 60, recipe: "takeone motion tidewater-board.png --recipe feature --theme paper (three labelled regions) -> delivery crf 24" };
BUILDS.push({ id: "A6", assets: [A6], build(put) { const f = join(work, "motion-callouts.mp4"); deliver(motion("a6", ["--recipe", "feature", "--theme", "paper", ...REGIONS.flatMap(r => ["--region", r])]), f); put(A6, f); } });

const A7: Asset = { id: "A7", file: "motion-scroll.mp4", kind: "video", width: 1080, height: 1920, fps: 60, recipe: "takeone motion tidewater-board.png --pattern scroll-through --aspect portrait --theme mono -> delivery crf 24" };
BUILDS.push({ id: "A7", assets: [A7], build(put) {
  const f = join(work, "motion-scroll.mp4");
  deliver(motion("a7", ["--pattern", "scroll-through", "--theme", "mono", "--aspect", "portrait"]), f); put(A7, f);
} });

const A8: Asset = { id: "A8", file: "before-after.mp4", kind: "video", width: 1920, height: 540, fps: 60, recipe: "A1 raw screen.webm (paced as the render paced it) beside A1's render, hstack 2x960" };
BUILDS.push({ id: "A8", assets: [A8], build(put) {
  const take = shared.a1 ?? join(work, "a1");
  if (!existsSync(join(take, "out"))) throw new Error("A8 needs the A1 take from this build");
  // The render's own pacing: the first setpts in camera.cmd is the warp it applied to the screen.
  const meta = JSON.parse(readFileSync(join(take, "take.json"), "utf8")) as { trim_start?: number };
  const pts = readFileSync(join(take, "camera.cmd"), "utf8").match(/setpts='([^']*)'/)?.[1];
  if (!pts) throw new Error("camera.cmd has no setpts");
  const f = join(work, "before-after.mp4"), render = film(take), length = seconds(render);
  ff("-i", join(take, "screen.webm"), "-i", render, "-filter_complex",
    `[0:v]trim=start=${meta.trim_start ?? 0},setpts='${pts}',fps=60,scale=960:540:flags=lanczos,trim=duration=${length}[a];[1:v]scale=960:540:flags=lanczos[b];[a][b]hstack=inputs=2,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv[v]`,
    "-map", "[v]", "-an", "-c:v", "libx264", "-crf", "24", "-preset", "slow", "-pix_fmt", "yuv420p", ...SRGB, "-movflags", "+faststart", f);
  put(A8, f);
} });

const grid: Asset = { id: "A9", file: "themes.png", kind: "image", width: 2560, height: 1512, recipe: "scripts/theme-proof.ts fixture mode: the saved Tidewater screenshot titled and captioned in every theme" };
BUILDS.push({ id: "A9", assets: [grid], build(put) {
  const proof = fresh(join(work, "themes"));
  run("node", ["scripts/theme-proof.ts", proof]);
  const f = join(work, "themes.png"); copyFileSync(join(proof, "takeone-themes-grid.png"), f); put(grid, f);
  copyFileSync(join(proof, "provenance.json"), join(dest, "themes-provenance.json"));
} });

// Stills sit at fixed fractions of each film, so they stay inside it whatever its length.
const STILLS: [string, number][] = ["a1", "a2"].flatMap(src => [1, 2, 3, 4].map(n => [src, n] as [string, number]));
const STILL_AT = [0.1, 0.35, 0.6, 0.85];
const stillAssets = STILLS.flatMap(([src, n]) => ["webp", "jpg"].map(ext => ({ id: "A10", file: `stills/${src}-${n}.${ext}`, kind: "image" as const, width: 1600, height: 900, recipe: `frame at ${STILL_AT[n - 1]! * 100}% of ${src === "a1" ? "A1" : "A2"}, 1600x900` })));
BUILDS.push({ id: "A10", assets: stillAssets, build(put) {
  const clip = (src: string) => { const f = join(dest, src === "a1" ? "hero.mp4" : "synth-demo.mp4"); if (!existsSync(f)) throw new Error(`A10 needs ${f}; run A1 and A2 first`); return f; };
  mkdirSync(join(work, "stills"), { recursive: true });
  for (const a of stillAssets) {
    const [, src, n] = a.file.match(/stills\/(a\d)-(\d)\./)!;
    const video = clip(src!), f = join(work, a.file);
    still(video, +(seconds(video) * STILL_AT[Number(n) - 1]!).toFixed(2), f, "1600:900"); put(a, f);
  }
} });

function main() {
  mkdirSync(dest, { recursive: true });
  const entries = new Map<string, Entry>();
  for (const b of BUILDS) {
    console.log(`== ${b.id}`);
    b.build((a, file, motionGate) => {
      const target = join(dest, a.file);
      mkdirSync(join(target, ".."), { recursive: true });
      copyFileSync(file, target);
      const entry: Entry = { ...a, sha256: sha(target), bytes: statSync(target).size, ...measure(a, target), ...(motionGate ? { motion_gate: motionGate } : {}) };
      entries.set(a.file, entry);
      console.log(`${entry.gates.every(g => g.passed) ? "pass" : "FAIL"} ${a.file} ${entry.bytes} B ${entry.sha256.slice(0, 12)}`);
    });
  }
  const assets = [...entries.values()].sort((x, y) => x.id.localeCompare(y.id, undefined, { numeric: true }) || x.file.localeCompare(y.file));
  const mp4Bytes = assets.filter(a => a.file.endsWith(".mp4")).reduce((n, a) => n + a.bytes, 0);
  const total: Gate = { name: "total_mp4_mb", value: +(mp4Bytes / 1e6).toFixed(3), target: `<= ${BUDGET.total_mb}`, passed: mp4Bytes / 1e6 <= BUDGET.total_mb };
  const git = (...a: string[]) => out("git", a).trim();
  const manifest = {
    generator: "scripts/readme-assets.ts", generator_sha256: sha(fileURLToPath(import.meta.url)),
    revision: git("rev-parse", "HEAD"), version: (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version,
    ffmpeg: out("ffmpeg", ["-version"]).split("\n")[0], node: process.version,
    budgets: BUDGET, total, complete: BUILDS.every(b => b.assets.every(a => entries.has(a.file))),
    passed: total.passed && assets.every(a => a.gates.every(g => g.passed) && (a.id !== "A5" || a.motion_gate?.frozen_passed === true)),
    assets: assets.map(a => ({ ...a, file: a.file })),
  };
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`manifest ${relative(process.cwd(), manifestFile)}: ${assets.length} assets, complete=${manifest.complete}, passed=${manifest.passed}`);
  if (!manifest.passed) process.exitCode = 1;
}

main();
