import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { Beat } from "../src/camera/types.ts";
import { DEFAULTS } from "../src/camera/defaults.ts";
import { keycapAss, keycapBackdropGraph, keycapMaskAss } from "../src/render/overlays.ts";
import { renderTake } from "../src/render/render.ts";

const input = resolve(process.argv[2]!);
const output = resolve(process.argv[3]!);
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const gitStatus = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
const patch = execFileSync("git", ["diff", "HEAD", "--", "src", "scripts/prove-overlays.ts", "test/overlays.test.ts"]);
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const sourcePaths = execFileSync("git", ["ls-files", "src", "resources/fonts"], { encoding: "utf8" }).trim().split("\n");
sourcePaths.push("scripts/prove-overlays.ts", "test/overlays.test.ts", "test/motion-blur.test.ts");
const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, sha(await readFile(path))])));
await mkdir(output, { recursive: true });
const artifact = (name: string) => join(output, `takeone-overlays-${name}`);
const inputs: Record<string, { artifact: string; sha256: string }> = {};
for (const [from, to] of [
  ["screen.webm", "source.webm"], ["cropped.webm", "cropped.webm"], ["events.txt", "events.txt"],
  ["mac-background.png", "mac-background.png"], ["original-producer.ts", "original-producer.ts"],
  ["before/take.json", "saved-take.json"], ["before/camera.json", "saved-camera.json"],
  ["before/analysis/beats.json", "saved-beats.json"], ["before/analysis/decisions.jsonl", "saved-decisions.jsonl"],
] as const) {
  await copyFile(join(input, from), artifact(to));
  inputs[from] = { artifact: `takeone-overlays-${to}`, sha256: sha(await readFile(artifact(to))) };
}
const historical: Record<string, string> = {};
for (const file of await readdir(join(input, "pre-rebase"))) {
  const name = file.replace("takeone-overlays-", "takeone-overlays-pre-rebase-");
  await copyFile(join(input, "pre-rebase", file), join(output, name));
  historical[name] = sha(await readFile(join(output, name)));
}
await writeFile(artifact("source.patch"), patch);
await copyFile("scripts/prove-overlays.ts", artifact("producer.ts"));
const log = await readFile(join(input, "events.txt"), "utf8");
const events = JSON.parse(JSON.parse(log.match(/^result: (.*)$/m)![1]!)) as { t: number; combo: string; trusted: boolean; theme: string }[];
if (events.length !== 4 || events.some(e => !e.trusted)
  || ["light", "dark"].some(theme => ["Ctrl+K", "Ctrl+S"].some(combo => !events.some(e => e.theme === theme && e.combo === combo)))) {
  throw new Error("Expected saved trusted Ctrl+K and Ctrl+S events in both themes");
}
const take = join(process.cwd(), "tmp", `overlay-proof-${head}`);
await mkdir(join(take, "analysis"), { recursive: true });
await copyFile(join(input, "cropped.webm"), join(take, "screen.webm"));
await copyFile(join(input, "before/take.json"), join(take, "take.json"));
await copyFile(join(input, "before/analysis/beats.json"), join(take, "analysis/beats.json"));
await copyFile(join(input, "before/analysis/decisions.jsonl"), join(take, "analysis/decisions.jsonl"));
const defaults = { ...DEFAULTS, idle_speed: 1, fade_s: 0, preset: "fast" };
const ffmpeg = (args: string[]) => execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { maxBuffer: 2_000_000 });
console.log("Rendering saved real take with current native source", head);
const { out, seconds } = await renderTake(take, defaults);
await copyFile(out, artifact("after.mp4"));
for (const event of events) {
  ffmpeg(["-ss", String(event.t / 1000 + 0.75), "-i", out, "-frames:v", "1", artifact(`after-${event.theme}-ctrl-${event.combo.at(-1)!.toLowerCase()}.png`)]);
}
const start = events[0]!.t / 1000 - 0.2;
ffmpeg(["-ss", String(start), "-i", out, "-t", "2.7", "-an", "-c:v", "libx264", "-crf", "18", artifact("after-ctrl-k-clip.mp4")]);
ffmpeg(["-i", artifact("pre-rebase-before-ctrl-k-clip.mp4"), "-i", artifact("after-ctrl-k-clip.mp4"),
  "-filter_complex", "[0:v]scale=960:540[a];[1:v]scale=960:540[b];[a][b]hstack", "-an", "-c:v", "libx264", "-crf", "18", artifact("before-after-ctrl-k.mp4")]);
ffmpeg(["-i", artifact("pre-rebase-before-light-ctrl-k.png"), "-i", artifact("after-light-ctrl-k.png"),
  "-filter_complex", "[0:v]scale=960:540[a];[1:v]scale=960:540[b];[a][b]hstack", "-frames:v", "1", artifact("before-after.png")]);
ffmpeg(["-i", out, "-vf", `select='${events.map(e => `eq(n,${Math.round((e.t / 1000 + 0.75) * defaults.fps)})`).join("+")}',scale=640:360,tile=4x1`,
  "-frames:v", "1", artifact("real-take-strip.png")]);
const macBeats: Beat[] = [{ id: "mac", t0: 0, t1: 3, anchor_t: 0, kind: "shortcut", zones: [],
  actions: [{ k: "shortcut", t: 500, combo: "Ctrl+Alt+Shift+Meta+K" }] }];
const macDefaults = { ...DEFAULTS, keycap_style: "mac" as const };
await writeFile(join(take, "mac-mask.ass"), keycapMaskAss(macBeats, 0, 3, macDefaults));
await writeFile(join(take, "mac.ass"), keycapAss(macBeats, 0, 3, macDefaults));
ffmpeg(["-loop", "1", "-framerate", "60", "-i", artifact("mac-background.png"), "-filter_complex",
  `[0:v]format=yuv420p[keycapInput];${keycapBackdropGraph(3, macDefaults, join(take, "mac-mask.ass"))};[keycapOutput]ass=${join(take, "mac.ass")}:fontsdir=resources/fonts,select=gte(t\\,1)[out]`,
  "-map", "[out]", "-frames:v", "1", artifact("mac-keycaps.png")]);
for (const file of ["camera.json", "motion-blur.json", "take.json", "spotlight.ass", "keycaps.ass", "keycaps-mask.ass"]) {
  await copyFile(join(take, file), artifact(`render-${file}`));
}
for (const path of sourcePaths) if (sha(await readFile(path)) !== sourceHashes[path]) throw new Error(`Source changed during render: ${path}`);
if (execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== head) throw new Error("HEAD changed during render");
const outputs = Object.fromEntries(await Promise.all((await readdir(output)).filter(file => !file.endsWith("provenance.json"))
  .map(async file => [file, sha(await readFile(join(output, file)))])));
await writeFile(artifact("provenance.json"), JSON.stringify({
  schema: 1, headAtRender: head, dirtySourceAtRender: true, gitStatusAtRender: gitStatus,
  qualification: "Rendered from the working-tree source hashes below; this is not proof of a later clean commit.",
  command: `node scripts/prove-overlays.ts <saved-input-dir> ${relative(process.cwd(), output)}`,
  runtime: { node: process.version, ffmpeg: execFileSync("ffmpeg", ["-version"], { encoding: "utf8" }).split("\n")[0] },
  producer: { path: "scripts/prove-overlays.ts", sha256: sourceHashes["scripts/prove-overlays.ts"] },
  sourceHashes, sourcePatchSha256: sha(patch), inputs, outputs, historical,
  historicalQualification: "Byte-preserved pre-rebase artifacts, with their original receipt; no verified source-head binding is claimed for them.",
  events, defaults, seconds, macDefaults,
  proof: { rapidPan: "Saved committed camera frames on a flat diagnostic source through the native spotlight and shutter graphs; not a new captured take.",
    captionCrop: "Decoded native renderTake caption-band regression output.",
    realTake: "Saved cropped recording and trusted events, with saved analysis; no capture or AI analysis rerun.",
    mac: "Current keycap renderer over the approved saved background; the full modifier chord is a typography fixture, not a captured real shortcut." },
}, null, 2));
console.log("Evidence written", relative(process.cwd(), output));
