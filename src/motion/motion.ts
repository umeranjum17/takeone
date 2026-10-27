// `takeone motion`: screens in, type-led film out. Writes a take-shaped directory (take.json, sources/,
// storyboard.json, out/<id>.mp4, render.json) that `takeone render <dir>` rerenders with zero planning.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { blurPlan } from "./blur.ts";
import type { FrozenReport, LoudnessReport } from "./gates.ts";
import { allTimelines } from "./layout.ts";
import { sceneCameras } from "./camera.ts";
import { ingest, ingestClips, clipStale } from "./ingest.ts";
import { ingestSegments, segmentStale } from "./segment.ts";
import { samplePalette } from "./palette.ts";
import { motionPage } from "./page.ts";
import { ffmpegVersion, MOTION_CRF, renderFrames, withPage } from "./render.ts";
import { pinnedShell } from "./shell.ts";
import { filmDuration, validateStoryboard } from "./storyboard.ts";
import { motionTokens } from "./theme.ts";
import type { MotionEngine, Storyboard } from "./types.ts";


export interface RenderManifest {
  version: 1;
  engine?: MotionEngine;
  storyboard_sha256: string;
  out: string;
  frames: number;
  fps: number;
  width: number;
  height: number;
  workers: number;
  render_s: number;
  warmup?: number;
  raster_scale?: number;
  shell?: { version: string; sha256: string; flags: string[] };
  ffmpeg?: string;
  encode?: { codec: "libx264"; profile: "high"; crf: number; preset: string; pix_fmt: "yuv420p"; colour: "bt709/tv" };
  concat_s: number;
  frame_md5?: string;
  motion_blur?: unknown;
  camera?: boolean;
  gates?: { frozen: FrozenReport; loudness?: LoudnessReport };
  hyperframes?: { version: string; cli: string; shell_version: string; shell_sha256: string; browser: string };
}

export function readStoryboard(dir: string): Storyboard {
  return validateStoryboard(JSON.parse(readFileSync(join(dir, "storyboard.json"), "utf8")));
}

/** Everything the page needs, with screen files as absolute file:// URLs. */
export function pageData(dir: string, sb: Storyboard, cameras: Record<string, unknown>) {
  const screens = Object.fromEntries(Object.entries(sb.screens).map(([id, s]) => {
    const file = isAbsolute(s.file) ? s.file : resolve(dir, s.file);
    if (!existsSync(file)) throw new Error(`screens.${id}: ${s.file} is missing; re-run ingest`);
    return [id, { url: pathToFileURL(file).href, width: s.width, height: s.height }];
  }));
  // Each clip plays the file whose own aspect is nearest the output's: a take rendered once per format is re-aimed, not cropped.
  const ar = sb.output.out_w / sb.output.out_h, off = (f: { aspect: number }) => Math.abs(Math.log(f.aspect / ar));
  const clips = Object.fromEntries(Object.entries(sb.clips ?? {}).map(([id, c]) => {
    if (!c.frames) throw new Error(`clips.${id}: not ingested`);
    for (const f of c.frames) if (!existsSync(resolve(dir, f.dir))) throw new Error(`clips.${id}: ${f.dir} is missing; re-run ingest`);
    const f = c.frames.reduce((a, b) => (off(b) < off(a) ? b : a));
    const file = c.files[c.frames.indexOf(f)];
    if (file === undefined) throw new Error(`clips.${id}: no source file for the selected frame set`);
    const video = isAbsolute(file) ? file : resolve(dir, file);
    if (!existsSync(video)) throw new Error(`clips.${id}: ${file} is missing`);
    return [id, { url: pathToFileURL(resolve(dir, f.dir)).href + "/", count: f.count, width: f.width, height: f.height, fps: 60,
      video: pathToFileURL(video).href, start: c.start }];
  }));
  const segments = Object.fromEntries(Object.entries(sb.segments ?? {}).map(([id, seg]) => {
    const video = seg.video ? resolve(dir, seg.video) : "";
    if (!video || !existsSync(video)) throw new Error(`segments.${id}: not rendered; re-run ingest`);
    return [id, { video: pathToFileURL(video).href }];
  }));
  const audio = sb.audio ? (() => {
    const file = isAbsolute(sb.audio.file) ? sb.audio.file : resolve(dir, sb.audio.file);
    if (!existsSync(file)) throw new Error(`audio: ${sb.audio.file} is missing`);
    return { url: pathToFileURL(file).href, start: sb.audio.start ?? 0, volume: sb.audio.volume ?? 1 };
  })() : undefined;
  const first = Object.values(sb.screens)[0];
  const palette = first ? samplePalette(isAbsolute(first.file) ? first.file : resolve(dir, first.file)) : null;
  return { storyboard: sb, screens, clips, segments, ...(audio ? { audio } : {}), cameras, palette, tokens: motionTokens(sb.theme.name, sb.theme.overrides) };
}

/** Write the page for a storyboard and return its path (dir/.motion/film.html). */
export function writePage(dir: string, sb: Storyboard): { html: string; cameras: ReturnType<typeof sceneCameras>; data: ReturnType<typeof pageData> } {
  const cameras = sceneCameras(sb, dir);
  const data = pageData(dir, sb, cameras);
  mkdirSync(join(dir, ".motion"), { recursive: true });
  const html = join(dir, ".motion", "film.html");
  writeFileSync(html, motionPage(data, data.tokens, sb.output.out_w, sb.output.out_h));
  return { html, cameras, data };
}

export interface RenderOptions {
  workers?: number;
  framesDir?: string;
  /** "hyperframes" renders through the pinned HyperFrames pair; "legacy" is the in-repo capture path. */
  engine?: MotionEngine;
  /** Render the same timeline at another frame size (an aspect preset): out/<id>-<w>x<h>.mp4 and render-<w>x<h>.json. */
  size?: [number, number];
  /** Write one PNG per film time (seconds) instead of the film: out/<id>[-<w>x<h>]-<t>s.png (contact sheets, critique). */
  stills?: number[];
  /** Write out/<id>.mov, ProRes 4444 with real alpha and no themed backdrop (hyperframes engine). */
  alpha?: boolean;
}

/** Render storyboard.json in dir to out/<id>.mp4 plus render.json and out/<id>.frames.md5. */
export async function renderMotion(dir: string, o: RenderOptions & { stills: number[] }): Promise<{ out: string; stills: string[] }>;
export async function renderMotion(dir: string, o?: Omit<RenderOptions, "stills">): Promise<{ out: string; manifest: RenderManifest }>;
export async function renderMotion(dir: string, o: RenderOptions = {}): Promise<{ out: string; manifest?: RenderManifest; stills?: string[] }> {
  let raw = readFileSync(join(dir, "storyboard.json"));
  let sb = validateStoryboard(JSON.parse(raw.toString("utf8")));
  if (!Object.keys(sb.screens).length || Object.values(sb.clips ?? {}).some(c => clipStale(dir, c))) { // first render of a hand-written storyboard: ingest once, keep the result
    if (!Object.keys(sb.screens).length) await ingest(dir, sb);
    ingestClips(dir, sb);
    raw = Buffer.from(JSON.stringify(sb, null, 2) + "\n");
    writeFileSync(join(dir, "storyboard.json"), raw);
    sb = validateStoryboard(JSON.parse(raw.toString("utf8")));
  }
  const staleSegments = Object.keys(sb.segments ?? {}).filter(id => segmentStale(dir, sb, id));
  if (staleSegments.length) {
    await ingestSegments(dir, sb, line => console.error(line));
    raw = Buffer.from(JSON.stringify(sb, null, 2) + "\n");
    writeFileSync(join(dir, "storyboard.json"), raw);
    sb = validateStoryboard(JSON.parse(raw.toString("utf8")));
  }
  const tag = o.size ? `-${o.size[0]}x${o.size[1]}` : "";
  if (o.size) { const json = JSON.parse(raw.toString("utf8")); sb = validateStoryboard({ ...json, output: { ...json.output, out_w: o.size[0], out_h: o.size[1] } }); }
  if (o.workers !== undefined) sb.output.workers = o.workers;
  const shell = await pinnedShell();
  const { html, cameras } = writePage(dir, sb);
  if (Object.keys(cameras).length) {
    writeFileSync(join(dir, "camera-scenes.json"), JSON.stringify(cameras) + "\n");
    if (sb.layout.kind === "single") {
      const track = Array.from({ length: Math.round(filmDuration(sb) * sb.output.fps) }, (_, f) => {
        const t = f / sb.output.fps;
        const i = sb.scenes.findIndex(s => t >= s.at! && t < s.at! + s.d);
        const scene = sb.scenes[Math.max(0, i)]!;
        const screen = sb.screens[scene.screen ?? Object.keys(sb.screens)[0]!]!;
        const frame = cameras[String(i)]?.[Math.round((t - scene.at!) * sb.output.fps)];
        const view = frame?.output ?? frame ?? { x: 0, y: 0, w: screen.width, h: screen.height };
        return { ...view, t };
      });
      writeFileSync(join(dir, "camera.json"), JSON.stringify(track) + "\n");
    } else writeFileSync(join(dir, "camera.json"), JSON.stringify(Object.fromEntries(Object.entries(cameras).map(([key, frames]) => [key, frames.map(f => f.output ?? f)]))) + "\n");
  } else {
    rmSync(join(dir, "camera-scenes.json"), { force: true });
    rmSync(join(dir, "camera.json"), { force: true });
  }
  const { out_w: width, out_h: height, fps } = sb.output;
  const frames = Math.round(filmDuration(sb) * fps);
  mkdirSync(join(dir, "out"), { recursive: true });
  for (const t of o.stills ?? []) if (!(t >= 0 && t * fps < frames)) throw new Error(`still ${t} s is outside the ${frames / fps} s film`);
  const engine = o.engine ?? "legacy";
  if (o.alpha && engine !== "hyperframes") throw new Error("--alpha needs the hyperframes engine");
  if (engine === "hyperframes") {
    if (o.size) throw new Error("hyperframes engine does not re-lay out --aspect; render with --engine legacy");
    if (o.stills) throw new Error("hyperframes engine does not write stills; render with --engine legacy");
    if (o.framesDir) throw new Error("hyperframes engine does not write legacy frame directories; use --engine legacy for frame proofs");
    await safeAreaGate(dir, tag, html, sb, Array.from({ length: frames }, (_, i) => i / fps), shell);
    const { renderHyperframes } = await import("./hyperframes.ts");
    return await renderHyperframes(dir, sb, { workers: o.workers, alpha: o.alpha });
  }
  if (sb.audio) throw new Error("audio is only supported by the hyperframes engine; render with --engine hyperframes");
  if (sb.scenes.some(s => s.pattern === "segment")) throw new Error("segment scenes are only supported by the hyperframes engine; render with --engine hyperframes");
  if (sb.scenes.some(s => s.fill)) throw new Error("fill clip scenes are only supported by the hyperframes engine; render with --engine hyperframes");
  await safeAreaGate(dir, tag, html, sb, o.stills ?? Array.from({ length: frames }, (_, i) => i / fps), shell);
  if (o.stills) {
    const stills: string[] = [];
    for (const t of o.stills) {
      const framesDir = join(dir, ".motion", "still"), png = join(dir, "out", `${sb.id}${tag}-${t}s.png`);
      await renderFrames({ html, width, height, fps, frames: 1, firstFrame: Math.round(t * fps), workers: 1, framesDir, shell });
      renameSync(join(framesDir, "000001.png"), png);
      stills.push(png);
    }
    return { out: stills[0]!, stills };
  }
  const blur = await blurPlan(html, sb, frames);
  const rasterScale = allTimelines(sb.layout, sb.scenes).some(list => list.some(scene => scene.pattern === "zoom-tour")) ? 2 : 1;
  const out = join(dir, "out", `${sb.id}${tag}.mp4`);
  const crf = MOTION_CRF;
  const r = await renderFrames({ html, width, height, fps, frames, workers: sb.output.workers, plan: blur.plan, mp4: out, crf,
    preset: sb.output.preset, shell, rasterScale, ...(o.framesDir ? { framesDir: o.framesDir } : {}) });
  const md5 = r.md5.map((h, i) => `${String(i + 1).padStart(6, "0")} ${h}`).join("\n") + "\n";
  writeFileSync(join(dir, "out", `${sb.id}${tag}.frames.md5`), md5);
  const manifest: RenderManifest = {
    version: 1, engine: "legacy", storyboard_sha256: createHash("sha256").update(raw).digest("hex"), out: `out/${sb.id}${tag}.mp4`,
    frames, fps, width, height, workers: r.workers, warmup: 3, raster_scale: rasterScale,
    shell: { version: r.shell.version, sha256: r.shell.sha256, flags: r.flags }, ffmpeg: ffmpegVersion(),
    encode: { codec: "libx264", profile: "high", crf, preset: sb.output.preset, pix_fmt: "yuv420p", colour: "bt709/tv" },
    render_s: +r.render_s.toFixed(2), concat_s: +r.concat_s.toFixed(2),
    frame_md5: createHash("sha256").update(md5).digest("hex"), motion_blur: blur.metrics, camera: Object.keys(cameras).length > 0,
  };
  writeFileSync(join(dir, `render${tag}.json`), JSON.stringify(manifest, null, 2) + "\n");
  return { out, manifest };
}

interface SafeHit { t: number; pattern: string; text: string; box: number[] }

/** Fail before any frame is drawn when a title, note, label or footage window crosses the frame's 5% inset, or a clipping
 * box cuts a shown word part-way, at any of these film times; the full list goes to safe-area[-WxH].json. */
async function safeAreaGate(dir: string, tag: string, html: string, sb: Storyboard, times: number[], shell: Awaited<ReturnType<typeof pinnedShell>>): Promise<void> {
  const report = join(dir, `safe-area${tag}.json`);
  const hits = await withPage<SafeHit[]>(html, sb.output.out_w, sb.output.out_h,
    b => b.evaluate(`${JSON.stringify(times)}.flatMap((t) => __safe(t * 1000).map((hit) => ({ t, ...hit })))`), shell);
  if (!hits.length) { rmSync(report, { force: true }); return; }
  writeFileSync(report, JSON.stringify(hits, null, 2) + "\n");
  const [x0, y0, x1, y1] = hits[0]!.box;
  throw new Error(`safe area: ${hits.length} box(es) cross the 5% inset or cut a word; first at ${hits[0]!.t.toFixed(3)} s, ${hits[0]!.pattern} "${hits[0]!.text}" at ${x0},${y0}-${x1},${y1} (all in ${report})`);
}
