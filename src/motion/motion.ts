// `takeone motion`: screens in, type-led film out. Writes a take-shaped directory (take.json, sources/,
// storyboard.json, out/<id>.mp4, render.json) that `takeone render <dir>` rerenders with zero planning.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { blurPlan } from "./blur.ts";
import { allTimelines } from "./layout.ts";
import { sceneCameras } from "./camera.ts";
import { ingest } from "./ingest.ts";
import { samplePalette } from "./palette.ts";
import { motionPage } from "./page.ts";
import { ffmpegVersion, renderFrames } from "./render.ts";
import { pinnedShell } from "./shell.ts";
import { filmDuration, validateStoryboard } from "./storyboard.ts";
import { motionTokens } from "./theme.ts";
import type { Storyboard } from "./types.ts";


export interface RenderManifest {
  version: 1;
  storyboard_sha256: string;
  out: string;
  frames: number;
  fps: number;
  width: number;
  height: number;
  workers: number;
  warmup: number;
  raster_scale: number;
  shell: { version: string; sha256: string; flags: string[] };
  ffmpeg: string;
  encode: { codec: "libx264"; profile: "high"; crf: number; preset: string; pix_fmt: "yuv420p"; colour: "bt709/tv" };
  render_s: number;
  concat_s: number;
  frame_md5: string;
  motion_blur: unknown;
  camera: boolean;
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
  const first = Object.values(sb.screens)[0];
  const palette = first ? samplePalette(isAbsolute(first.file) ? first.file : resolve(dir, first.file)) : null;
  return { storyboard: sb, screens, cameras, palette, tokens: motionTokens(sb.theme.name, sb.theme.overrides) };
}

/** Write the page for a storyboard and return its path (dir/.motion/film.html). */
export function writePage(dir: string, sb: Storyboard): { html: string; cameras: ReturnType<typeof sceneCameras> } {
  const cameras = sceneCameras(sb);
  const data = pageData(dir, sb, cameras);
  mkdirSync(join(dir, ".motion"), { recursive: true });
  const html = join(dir, ".motion", "film.html");
  writeFileSync(html, motionPage(data, data.tokens, sb.output.out_w, sb.output.out_h));
  return { html, cameras };
}

export interface RenderOptions { workers?: number; framesDir?: string }

/** Render storyboard.json in dir to out/<id>.mp4 plus render.json and out/<id>.frames.md5. */
export async function renderMotion(dir: string, o: RenderOptions = {}): Promise<{ out: string; manifest: RenderManifest }> {
  let raw = readFileSync(join(dir, "storyboard.json"));
  let sb = validateStoryboard(JSON.parse(raw.toString("utf8")));
  if (!Object.keys(sb.screens).length) { // first render of a hand-written storyboard: ingest once, keep the result
    await ingest(dir, sb);
    raw = Buffer.from(JSON.stringify(sb, null, 2) + "\n");
    writeFileSync(join(dir, "storyboard.json"), raw);
    sb = validateStoryboard(JSON.parse(raw.toString("utf8")));
  }
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
  const blur = await blurPlan(html, sb, frames);
  const rasterScale = allTimelines(sb.layout, sb.scenes).some(list => list.some(scene => scene.pattern === "zoom-tour")) ? 2 : 1;
  mkdirSync(join(dir, "out"), { recursive: true });
  const out = join(dir, "out", `${sb.id}.mp4`);
  const crf = 18;
  const r = await renderFrames({ html, width, height, fps, frames, workers: sb.output.workers, plan: blur.plan, mp4: out, crf,
    preset: sb.output.preset, shell, rasterScale, ...(o.framesDir ? { framesDir: o.framesDir } : {}) });
  const md5 = r.md5.map((h, i) => `${String(i + 1).padStart(6, "0")} ${h}`).join("\n") + "\n";
  writeFileSync(join(dir, "out", `${sb.id}.frames.md5`), md5);
  const manifest: RenderManifest = {
    version: 1, storyboard_sha256: createHash("sha256").update(raw).digest("hex"), out: `out/${sb.id}.mp4`,
    frames, fps, width, height, workers: r.workers, warmup: 3, raster_scale: rasterScale,
    shell: { version: r.shell.version, sha256: r.shell.sha256, flags: r.flags }, ffmpeg: ffmpegVersion(),
    encode: { codec: "libx264", profile: "high", crf, preset: sb.output.preset, pix_fmt: "yuv420p", colour: "bt709/tv" },
    render_s: +r.render_s.toFixed(2), concat_s: +r.concat_s.toFixed(2),
    frame_md5: createHash("sha256").update(md5).digest("hex"), motion_blur: blur.metrics, camera: Object.keys(cameras).length > 0,
  };
  writeFileSync(join(dir, "render.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { out, manifest };
}
