// Thin adapter from a motion storyboard to a HyperFrames project, and back to one MP4.
// HyperFrames owns capture + encode; TakeOne owns the storyboard, the local planner and the screen/type grammar.
// The emitted project is offline: every file:// asset is vendored under assets/, scripts are inlined, and
// the render fails instead of falling back to a network URL.
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { filmDuration, readingFloor } from "./storyboard.ts";
import { measureFrozen, measureLoudness } from "./gates.ts";
import { writePage } from "./motion.ts";
import type { RenderManifest } from "./motion.ts";
import type { Storyboard } from "./types.ts";

export const HYPERFRAMES_VERSION = "0.8.200";
export const HYPERFRAMES_SHELL_VERSION = "156.0.8078.47";
export const HYPERFRAMES_SHELL_SHA256 = "201ce52b0e6e571702a9bd747f2552e3d17818f1789e0967e6392d5e1a6167da";
const SHELL_BIN = "chrome-headless-shell-linux64/chrome-headless-shell";
const GSAP = fileURLToPath(new URL("../../resources/motion/vendor/gsap.min.js", import.meta.url));
const execFileAsync = promisify(execFile);


export interface HyperframesRuntime {
  version: string;
  cli: string;
  browser: string;
  browserVersion: string;
  browserSha256: string;
}

export function hyperframesCache(): string {
  return join(process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"), "takeone", "hyperframes", HYPERFRAMES_VERSION);
}

function shellPath(root: string): string {
  return join(root, "shell", "chrome-headless-shell", `linux-${HYPERFRAMES_SHELL_VERSION}`, SHELL_BIN);
}

function packageJson(root: string): string {
  return join(root, "node_modules", "hyperframes", "package.json");
}

function binPath(root: string): string {
  return join(root, "node_modules", "hyperframes", "bin", "hyperframes.mjs");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** The installed pin, or a clear install hint. Also accepts TAKEONE_HYPERFRAMES for an existing checkout. */
export async function pinnedHyperframes(): Promise<HyperframesRuntime> {
  const root = hyperframesCache();
  const envCli = process.env["TAKEONE_HYPERFRAMES"];
  const cli = envCli ?? binPath(root);
  if (!existsSync(cli)) {
    throw new Error(`hyperframes ${HYPERFRAMES_VERSION} is not installed; run \`takeone motion install-hyperframes\` or pass --engine legacy`);
  }
  const pkgFile = packageJson(root);
  if (!envCli) {
    if (!existsSync(pkgFile)) throw new Error(`hyperframes ${HYPERFRAMES_VERSION} is incomplete at ${root}; run \`takeone motion install-hyperframes\``);
    const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as { version?: string };
    if (pkg.version !== HYPERFRAMES_VERSION) {
      throw new Error(`hyperframes ${pkg.version ?? "unknown"} at ${root} is not the ${HYPERFRAMES_VERSION} pin; run \`takeone motion install-hyperframes\``);
    }
  }
  const browser = process.env["TAKEONE_HYPERFRAMES_BROWSER"] ?? shellPath(root);
  if (!existsSync(browser)) {
    throw new Error(`chrome-headless-shell ${HYPERFRAMES_SHELL_VERSION} is not installed; run \`takeone motion install-hyperframes\``);
  }
  const browserSha = sha256File(browser);
  if (browserSha !== HYPERFRAMES_SHELL_SHA256) {
    throw new Error(`chrome-headless-shell ${HYPERFRAMES_SHELL_VERSION} sha256 ${browserSha.slice(0, 12)}… is not the pin`);
  }
  const browserVersion = execFileSync(browser, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
  if (!browserVersion.endsWith(HYPERFRAMES_SHELL_VERSION)) {
    throw new Error(`${browser} reports ${browserVersion}, not chrome-headless-shell ${HYPERFRAMES_SHELL_VERSION}`);
  }
  return { version: HYPERFRAMES_VERSION, cli, browser, browserVersion, browserSha256: browserSha };
}

/** Install the pinned pair into TakeOne's cache. Idempotent; needs network, npm and ~370 MB once. */
export async function installHyperframes(): Promise<HyperframesRuntime> {
  try { return await pinnedHyperframes(); } catch { /* install a verified pair */ }
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("the pinned HyperFrames pair is Linux x86_64 only");
  const root = hyperframesCache();
  mkdirSync(root, { recursive: true });
  execFileSync("npm", ["install", "--prefix", root, "--no-audit", "--no-fund", "--no-save", `hyperframes@${HYPERFRAMES_VERSION}`],
    { stdio: "inherit", timeout: 300_000 });
  const browsersCli = join(root, "node_modules", "@puppeteer", "browsers", "lib", "main-cli.js");
  if (!existsSync(browsersCli)) throw new Error("hyperframes did not install @puppeteer/browsers; reinstall the pin");
  execFileSync(process.execPath, [browsersCli, "install", `chrome-headless-shell@${HYPERFRAMES_SHELL_VERSION}`, "--path", join(root, "shell")],
    { stdio: "inherit", timeout: 300_000 });
  return await pinnedHyperframes();
}

export interface HyperframesProject {
  dir: string;
  html: string;
  duration: number;
  frames: number;
  fps: number;
  width: number;
  height: number;
  videos: number;
  audio: boolean;
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The clip pattern's final fitted window, repeated here so the emitted video needs no JS layout pass. */
function clipWindow(width: number, height: number, W: number, H: number, scale = 1): { left: number; top: number; width: number; height: number; radius: number } {
  const u = Math.min(W, H);
  const m = Math.max(u * 0.06, W * 0.06), mb = Math.max(u * 0.06, H * 0.06);
  const top = Math.max(u * 0.12, H * 0.06 + u * 0.048), cy = (top + H - mb) / 2;
  const aw = W - 2 * m, ah = H - top - mb, ar = width / height;
  const fit: [number, number] = aw / ah > ar ? [ah * ar, ah] : [aw, aw / ar];
  const s = Math.min(scale, 1), w = fit[0] * s, h = fit[1] * s;
  return { left: (W - w) / 2, top: cy - h / 2, width: w, height: h, radius: u * 0.018 };
}

type Spot = "bottom-left" | "bottom-right" | "top-left" | "top-right" | "bottom-center" | "top-center";
const SPOTS: Spot[] = ["bottom-left", "bottom-right", "top-left", "top-right", "bottom-center", "top-center"];
/** Frames a second the chip's clearance is measured at. */
const CHIP_FPS = 10;
/** Share of a chip box's 32 px row stretches that hold three or more glyph strokes, above which page text sits under it.
 * Measured on real page footage: headings and body copy read 5-23%; illustrations, photos and flat panels under 0.5%. */
const TEXT_RUNS = 0.02;
/** Luma step between neighbouring pixels that reads as a glyph stroke's edge. */
const STROKE_STEP = 24;

/** A fill clip's label chip box in output px. The text width is set at 0.62 em a character, wider than the semibold
 * body face's mean, so the box measured for text covers at least the drawn chip. */
function chipBox(label: string, spot: Spot, W: number, H: number): { x: number; y: number; w: number; h: number } {
  const u = Math.min(W, H), w = label.length * u * 0.05 * 0.62 + 2 * u * 0.036, h = u * 0.05 + 2 * u * 0.022;
  const x = spot.endsWith("left") ? W * 0.05 : spot.endsWith("right") ? W * 0.95 - w : (W - w) / 2;
  return { x, y: spot.startsWith("bottom") ? H * 0.95 - h : H * 0.05, w, h };
}

/** Whether page text sits under a box of a grey frame: rows of glyph strokes, not the edges of a drawing or a panel. */
function textUnder(g: Uint8Array, W: number, H: number, b: { x: number; y: number; w: number; h: number }): boolean {
  const pad = Math.min(W, H) * 0.01;
  const x0 = Math.max(1, Math.round(b.x - pad)), x1 = Math.min(W, Math.round(b.x + b.w + pad));
  const y0 = Math.max(0, Math.round(b.y - pad)), y1 = Math.min(H, Math.round(b.y + b.h + pad));
  let runs = 0, stretches = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x + 32 <= x1; x += 16) {
    let strokes = 0, inside = false;
    for (let j = x; j < x + 32; j++) {
      const step = Math.abs(g[y * W + j]! - g[y * W + j - 1]!) > STROKE_STEP;
      if (step && !inside) strokes++;
      inside = step;
    }
    stretches++;
    if (strokes >= 3) runs++;
  }
  return stretches > 0 && runs > TEXT_RUNS * stretches;
}

/**
 * Where and when a fill clip's label chip can sit without covering the page's own text: the earliest window in the scene,
 * in the first spot that is clear of text for the whole time the chip is shown, measured on the clip's frames as the film
 * draws them (cover-fitted to the output, ten a second). When no spot stays clear that long, the chip is shown for its
 * reading time only; null when even that finds no clear window.
 */
export function chipPlacement(video: string, start: number, d: number, want: number, label: string, W: number, H: number): { spot: Spot; at: number; shown: number } | null {
  const n = Math.ceil(d * CHIP_FPS);
  const raw = execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-threads", "2", "-filter_threads", "2", "-ss", start.toFixed(3), "-t", d.toFixed(3), "-i", video,
    "-vf", `fps=${CHIP_FPS},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},format=gray`, "-f", "rawvideo", "-"], { maxBuffer: W * H * (n + 2) });
  const decoded = Math.floor(raw.length / (W * H));
  if (decoded === 0) throw new Error(`hyperframes engine: ${video} has no frame at ${start.toFixed(3)} s to place the label ${JSON.stringify(label)} on`);
  // A clip that ends inside its scene holds its last frame there, as the video element does.
  const frames = Array.from({ length: Math.max(n, decoded) }, (_, k) => raw.subarray(Math.min(k, decoded - 1) * W * H, (Math.min(k, decoded - 1) + 1) * W * H));
  const covered = SPOTS.map((spot) => frames.map((g) => textUnder(g, W, H, chipBox(label, spot, W, H))));
  for (const shown of [want, Math.min(want, readingFloor(label))]) {
    const span = Math.ceil(shown * CHIP_FPS - 1e-9);
    for (let k = 0; k + span <= n; k++) {
      const spot = SPOTS.findIndex((_, i) => covered[i]!.slice(k, k + span).every((c) => !c));
      if (spot >= 0) return { spot: SPOTS[spot]!, at: k / CHIP_FPS, shown };
    }
  }
  return null;
}

function videoLayers(sb: Storyboard, data: { clips: Record<string, { video: string; start: number; width: number; height: number }> }): string {
  const { out_w: W, out_h: H } = sb.output;
  return sb.scenes.map((s, i) => {
    if (s.pattern !== "clip") return "";
    if (s.cuts?.length) throw new Error("hyperframes engine: clip cuts are not supported yet; render with --engine legacy");
    const clip = s.clip ? data.clips[s.clip] : undefined;
    if (!clip) throw new Error(`hyperframes engine: clip scene ${i} names no ingested clip`);
    const u = Math.min(W, H);
    // A fill clip's label chip never covers the page's own text: it takes the earliest clear window in the first clear spot.
    const want = s.label ? Math.min(s.d, Math.max(2, readingFloor(s.label))) : 0;
    const chip = s.fill && s.label ? chipPlacement(fileURLToPath(clip.video), clip.start, s.d, want, s.label, W, H) : undefined;
    if (chip === null) {
      console.warn(`motion: scene ${i + 1}: page text crosses every spot the label ${JSON.stringify(s.label)} could sit in for ${readingFloor(s.label!).toFixed(1)} s, `
        + "so the clip plays framed with the label above it instead of edge to edge");
    }
    if (s.fill && chip !== null) {
      // Edge to edge: the footage is the frame. The label sits on an ink chip inside the 5% safe inset, sized to read on a phone,
      // and leaves once read so it stops covering the page under it.
      const [v, h] = (chip?.spot ?? "bottom-left").split("-") as [string, string];
      const across = h === "center" ? `left:50%;transform:translateX(-50%)` : `${h}:${W * 0.05}px`;
      const label = s.label
        ? `<div data-safe style="position:absolute;z-index:${i + 2};${across};${v}:${H * 0.05}px;padding:${u * 0.022}px ${u * 0.036}px;border-radius:${u * 0.06}px;background:var(--text);color:var(--page);font:600 ${u * 0.05}px/1 var(--body);white-space:pre;visibility:hidden" data-start="${(s.at ?? 0) + chip!.at}" data-duration="${chip!.shown}">${esc(s.label)}</div>`
        : "";
      return `<video class="clip" data-start="${s.at ?? 0}" data-duration="${s.d}" data-track-index="${i}" data-playback-start="${clip.start}" data-media-start-basis="global" src="${clip.video}" muted playsinline preload="auto" style="position:absolute;z-index:${i + 1};left:0;top:0;width:${W}px;height:${H}px;object-fit:cover;display:block;background:var(--page);visibility:hidden"></video>${label}`;
    }
    const win = clipWindow(clip.width, clip.height, W, H, s.scale ?? 1);
    const label = s.label
      ? `<div data-safe style="position:absolute;z-index:${i + 2};left:${win.left}px;top:${win.top}px;transform:translateY(-100%);padding-bottom:${Math.min(W, H) * 0.018}px;color:var(--text);font:${Math.min(W, H) * 0.028}px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;white-space:pre;visibility:hidden" data-start="${s.at ?? 0}" data-duration="${s.d}">${esc(s.label)}</div>`
      : "";
    return `<video class="clip" data-start="${s.at ?? 0}" data-duration="${s.d}" data-track-index="${i}" data-playback-start="${clip.start}" data-media-start-basis="global" src="${clip.video}" muted playsinline preload="auto" style="position:absolute;z-index:${i + 1};left:${win.left}px;top:${win.top}px;width:${win.width}px;height:${win.height}px;object-fit:contain;display:block;background:var(--page);border-radius:${win.radius}px;visibility:hidden"></video>${label}`;
  }).join("\n");
}

/** Write a self-contained HyperFrames project at <take>/.motion/hyperframes/. */
export function buildHyperframesProject(dir: string, sb: Storyboard, alpha = false): HyperframesProject {
  if (sb.layout.kind !== "single") throw new Error("hyperframes engine supports the single layout only; render with --engine legacy");
  const projectDir = join(dir, ".motion", "hyperframes");
  rmSync(projectDir, { recursive: true, force: true });
  const assets = join(projectDir, "assets");
  mkdirSync(assets, { recursive: true });

  const duration = filmDuration(sb);
  const frames = Math.round(duration * sb.output.fps);
  const { html: page, data } = writePage(dir, sb);
  let doc = readFileSync(page, "utf8");

  const clips = data.clips as Record<string, { video: string; start: number; width: number; height: number }>;
  const videos = videoLayers(sb, { clips });
  const audio = data.audio
    ? `<audio id="hf-audio" src="${data.audio.url}" data-start="0" data-duration="${duration}" data-track-index="0" data-volume="${data.audio.volume}"${data.audio.start ? ` data-playback-start="${data.audio.start}"` : ""} preload="auto"></audio>`
    : "";
  doc = doc.replace('<div id="stage">',
    `<div id="stage" data-composition-id="main" data-start="0" data-duration="${duration}" data-width="${sb.output.out_w}" data-height="${sb.output.out_h}" data-fps="${sb.output.fps}">${videos}${audio}`);

  const scripts: string[] = [];
  for (const m of doc.matchAll(/<script(?: src="([^"]+)")?>([\s\S]*?)<\/script>/g)) {
    if (m[1]) {
      const src = m[1].startsWith("file:") ? fileURLToPath(m[1]) : resolve(dir, m[1]);
      if (!existsSync(src)) throw new Error(`hyperframes engine: page script ${m[1]} is missing`);
      scripts.push(readFileSync(src, "utf8"));
    } else scripts.push(m[2]!);
  }
  doc = doc.replace(/<script(?: src="[^"]+")?>[\s\S]*?<\/script>/g, "");

  const inline = `${readFileSync(GSAP, "utf8")}\n${scripts.join("\n")}`;
  const bridge = `;(async()=>{window.HYPERFRAMES_ENGINE=true;await window.ready;
const vids=[...document.querySelectorAll('video[data-start]')];
await Promise.all(vids.map(v=>v.readyState>=2?Promise.resolve():new Promise(ok=>{const done=()=>{clearTimeout(timer);ok();};const timer=setTimeout(done,15000);v.addEventListener('loadeddata',done,{once:true});v.addEventListener('error',done,{once:true});})));
installSeek(0);
const dur=${duration};
window.__hfSeek=(s)=>{const t=Math.max(0,Math.min(dur,s));window.__apply(t*1000);
 for(const l of document.querySelectorAll('div[data-safe][data-start]')){const a=Number(l.dataset.start),d=Number(l.dataset.duration);l.style.visibility=t>=a&&t<a+d?'visible':'hidden';}
 for(const v of document.querySelectorAll('video[data-start]')){const a=Number(v.dataset.start)||0,d=Number(v.dataset.duration)||0,o=Number(v.dataset.playbackStart||v.dataset.mediaStart||0);const on=t>=a&&t<a+d;v.style.visibility=on?'visible':'hidden';if(on){const at=Math.max(0,t-a)+o;if(Math.abs(v.currentTime-at)>1/120){try{v.currentTime=at;}catch{void 0;}}}}
};
window.__timelines=window.__timelines||{};
window.__timelines['main']={duration:()=>dur,totalDuration:()=>dur,pause(){},seek(s){window.__hfSeek(s);return this;},time(s){if(s!==undefined)this.seek(s);return s??0;},totalTime(s){if(s!==undefined)this.seek(s);return s??0;}};
window.__hfSeek(0);window.__hfReady=true;})();`;
  doc = doc.replace("</head>", () => `<script>${inline}${bridge}</script>\n</head>`);
  // An alpha film is the motion layer alone: the themed backdrop (page, stage and every scene's fill) is dropped, not matted out.
  if (alpha) doc = doc.replace("</head>", () => "<style>html,body,#stage,.layer{background:transparent!important}</style>\n</head>");

  const vendored = new Map<string, string>();
  const vendor = (url: string): string => {
    const hit = vendored.get(url);
    if (hit) return hit;
    const path = fileURLToPath(url);
    if (!existsSync(path)) throw new Error(`hyperframes engine: ${path} is missing`);
    const dirAsset = statSync(path).isDirectory();
    const name = `${createHash("sha1").update(url).digest("hex").slice(0, 8)}-${basename(path.replace(/\/+$/, ""))}${dirAsset ? "" : ""}`;
    cpSync(path, join(assets, name), { recursive: dirAsset });
    const rel = `assets/${name}${dirAsset ? "/" : ""}`;
    vendored.set(url, rel);
    return rel;
  };
  doc = doc.replace(/file:\/\/\/[^"'\s<>)\\]+/g, (url) => vendor(url));
  if (doc.includes("file://")) throw new Error("hyperframes engine: a file:// URL survived asset vendoring");

  writeFileSync(join(projectDir, "index.html"), doc);
  writeFileSync(join(projectDir, "hyperframes.json"), JSON.stringify({ paths: { blocks: "compositions", components: "compositions/components", assets: "assets" } }, null, 2) + "\n");
  writeFileSync(join(projectDir, "meta.json"), JSON.stringify({ id: sb.id, name: "motion" }, null, 2) + "\n");
  validateHyperframesProject(projectDir);
  return { dir: projectDir, html: join(projectDir, "index.html"), duration, frames, fps: sb.output.fps, width: sb.output.out_w, height: sb.output.out_h, videos: sb.scenes.filter((s) => s.pattern === "clip").length, audio: Boolean(data.audio) };
}

/** Static gates: no network, every referenced asset exists, composition timing is present. */
export function validateHyperframesProject(projectDir: string): void {
  const html = readFileSync(join(projectDir, "index.html"), "utf8");
  if (!html.includes('data-composition-id="main"')) throw new Error("hyperframes engine: composition root is missing");
  if (!/data-duration="[\d.]+"/.test(html)) throw new Error("hyperframes engine: composition duration is missing");
  if (!/data-fps="\d+"/.test(html)) throw new Error("hyperframes engine: composition fps is missing");
  for (const m of html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)) throw new Error(`hyperframes engine: network reference ${m[1]}`);
  for (const m of html.matchAll(/url\((['"]?)(https?:\/\/[^)'"]+)\1\)/g)) throw new Error(`hyperframes engine: network reference ${m[2]}`);
  for (const m of html.matchAll(/assets\/[^"'\s)\\]+/g)) {
    const rel = m[0].replace(/[?#].*$/, "");
    if (!existsSync(join(projectDir, rel))) throw new Error(`hyperframes engine: asset ${rel} is missing`);
  }
  if (!existsSync(join(projectDir, "assets", "gsap.min.js")) && !html.includes("GSAP 3.13.0")) {
    throw new Error("hyperframes engine: GSAP is not vendored");
  }
  if (!readdirSync(join(projectDir, "assets")).some((f) => f.endsWith(".ttf"))) throw new Error("hyperframes engine: no vendored font");
}

function probe(out: string): { duration: number; frames: number; width: number; height: number; fps: number; video: string; audioStreams: number } {
  const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,nb_frames,r_frame_rate,duration", "-of", "json", out], { encoding: "utf8", timeout: 60_000 })) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; nb_frames?: string; r_frame_rate?: string; duration?: string }[];
  };
  const streams = info.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  if (!video) throw new Error(`hyperframes engine: ${out} has no video stream`);
  const audioStreams = streams.filter((s) => s.codec_type === "audio").length;
  const [num, den] = (video.r_frame_rate ?? "0/1").split("/").map(Number);
  const fps = num && den ? num / den : 0;
  let frames = Number(video.nb_frames ?? 0);
  if (!frames) {
    const counted = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "json", out], { encoding: "utf8", timeout: 300_000 })) as { streams?: { nb_read_frames?: string }[] };
    frames = Number(counted.streams?.[0]?.nb_read_frames ?? 0);
  }
  const duration = Number(video.duration ?? info.format?.duration ?? 0);
  return { duration, frames, width: video.width ?? 0, height: video.height ?? 0, fps, video: video.codec_name ?? "", audioStreams };
}

export interface HyperframesRenderOptions {
  workers?: number;
  /** Write out/<id>.mov, ProRes 4444 with a real alpha channel over a transparent backdrop, instead of the opaque MP4. */
  alpha?: boolean;
}

/** [lowest alpha, share of fully transparent pixels] over the first, middle and last frames of an alpha film. */
async function alphaCoverage(file: string, frames: number, width: number, height: number): Promise<{ min: number; clear: number }> {
  let min = 255, clear = 0, seen = 0;
  for (const n of [0, Math.floor(frames / 2), frames - 1]) {
    const { stdout } = await execFileAsync("ffmpeg", ["-nostdin", "-v", "error", "-threads", "2", "-filter_threads", "2", "-i", file,
      "-vf", `select=eq(n\\,${n}),format=rgba,alphaextract,format=gray`, "-frames:v", "1", "-f", "rawvideo", "-"],
      { encoding: "buffer", maxBuffer: width * height + 1024, timeout: 300_000 }) as { stdout: Buffer };
    if (stdout.length !== width * height) throw new Error(`hyperframes engine: could not read the alpha of frame ${n} of ${file}`);
    let zero = 0;
    for (const a of stdout) { if (a < min) min = a; if (a === 0) zero++; }
    clear += zero / stdout.length;
    seen++;
  }
  return { min, clear: clear / seen };
}

/** Render the emitted project and prove the file is the requested duration, frame count and size. */
export async function renderHyperframes(dir: string, sb: Storyboard, o: HyperframesRenderOptions = {}): Promise<{ out: string; manifest: RenderManifest }> {
  const hf = await pinnedHyperframes();
  const project = buildHyperframesProject(dir, sb, o.alpha);
  const ext = o.alpha ? "mov" : "mp4";
  const out = join(dir, "out", `${sb.id}.${ext}`);
  mkdirSync(join(dir, "out"), { recursive: true });
  const workers = Math.max(1, Math.min(o.workers ?? sb.output.workers ?? 2, 16));
  const started = performance.now();
  await execFileAsync(process.execPath, [hf.cli, "render", "-c", "index.html", "-o", out, "-w", String(workers),
    "--fps", String(sb.output.fps), ...(o.alpha ? ["--format", "mov"] : ["--crf", "10"]), "--video-frame-format", "png", "--no-best-effort", "--quiet", "--frames-cache-dir", "off"], {
    cwd: project.dir,
    env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: "1", HYPERFRAMES_NO_UPDATE_CHECK: "1", HYPERFRAMES_BROWSER_PATH: hf.browser },
    maxBuffer: 20 * 1024 * 1024,
    timeout: 900_000,
  });
  const p = probe(out);
  if (p.frames !== project.frames) throw new Error(`hyperframes engine: rendered ${p.frames} frames, expected ${project.frames}`);
  if (Math.abs(p.duration - project.duration) > 1.5 / project.fps) throw new Error(`hyperframes engine: rendered ${p.duration.toFixed(3)} s, expected ${project.duration.toFixed(3)} s`);
  if (p.width !== project.width || p.height !== project.height) throw new Error(`hyperframes engine: rendered ${p.width}x${p.height}, expected ${project.width}x${project.height}`);
  if (Math.abs(p.fps - project.fps) > 0.01) throw new Error(`hyperframes engine: rendered ${p.fps} fps, expected ${project.fps}`);
  if (p.audioStreams > (project.audio ? 1 : 0)) throw new Error(`hyperframes engine: expected ${project.audio ? 1 : 0} audio stream, found ${p.audioStreams}`);
  if (project.audio && p.audioStreams !== 1) throw new Error("hyperframes engine: audio was not muxed");
  if (o.alpha) {
    if (p.video !== "prores") throw new Error(`hyperframes engine: alpha film is ${p.video}, not ProRes`);
    const { min, clear } = await alphaCoverage(out, p.frames, p.width, p.height);
    if (min !== 0 || clear < 0.01) throw new Error(`hyperframes engine: the ProRes film has no transparent backdrop (lowest alpha ${min}, ${(clear * 100).toFixed(1)}% clear)`);
  }
  const gates: NonNullable<RenderManifest["gates"]> = { frozen: await measureFrozen(out, sb, project.duration) };
  if (project.audio) gates.loudness = await measureLoudness(out);
  const raw = readFileSync(join(dir, "storyboard.json"));
  const manifest: RenderManifest = {
    version: 1,
    engine: "hyperframes",
    storyboard_sha256: createHash("sha256").update(raw).digest("hex"),
    out: `out/${sb.id}.${ext}`,
    frames: p.frames,
    fps: p.fps,
    width: p.width,
    height: p.height,
    workers,
    render_s: (performance.now() - started) / 1000,
    concat_s: 0,
    gates,
    hyperframes: {
      version: hf.version,
      cli: hf.cli,
      shell_version: HYPERFRAMES_SHELL_VERSION,
      shell_sha256: hf.browserSha256,
      browser: hf.browser,
    },
  };
  writeFileSync(join(dir, "render.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const f = gates.frozen, l = gates.loudness;
  // Warn rather than fail: the local plan's zoom-tour on one screenshot is a real still hold today, and the film is otherwise good.
  if (!f.passed) process.stderr.write(`takeone motion: warning: ${out} has frozen time outside the end card: longest ${f.longest.toFixed(1)} s (max 0.6), ${f.per_30s.toFixed(1)} s per 30 s (max 1.0) at ${f.runs.map(([x, y]) => `${x.toFixed(1)}-${y.toFixed(1)} s`).join(", ")}; give the held scene motion or shorten it\n`);
  if (l && !l.passed) throw new Error(`hyperframes engine: ${out} audio fails the loudness gate: ${l.failures.join("; ")}`);
  if (!o.alpha) await writeScenes(dir, sb, out);
  return { out, manifest };
}

/** A frame whose luma spans fewer levels than this is one flat colour: a blank (black or bare) frame. */
export const BLANK_LUMA_RANGE = 12;

/** [min, max] luma of a clip's first and last decoded frames. */
async function edgeLuma(file: string, frames: number): Promise<[number, number][]> {
  const { stdout } = await execFileAsync("ffmpeg", ["-nostdin", "-v", "error", "-threads", "2", "-filter_threads", "2", "-i", file,
    "-vf", `select=eq(n\\,0)+eq(n\\,${frames - 1}),signalstats,metadata=print:file=-`, "-f", "null", "-"], { timeout: 300_000, maxBuffer: 1024 * 1024 });
  const lo = [...stdout.matchAll(/YMIN=(\d+)/g)].map((m) => Number(m[1])), hi = [...stdout.matchAll(/YMAX=(\d+)/g)].map((m) => Number(m[1]));
  if (lo.length < 1 || hi.length !== lo.length) throw new Error(`hyperframes engine: could not read the edge frames of ${file}`);
  const edges = lo.map((l, k): [number, number] => [l, hi[k]!]);
  return [edges[0]!, edges.at(-1)!];
}

export interface SceneCut { index: number; file: string; start: number; end: number; title: string; pattern: string; frames: number }

/** One file per scene, cut from the film on its exact frames, and out/scenes.json listing each one's start, end and title. */
export async function writeScenes(dir: string, sb: Storyboard, film: string): Promise<SceneCut[]> {
  const scenesDir = join(dir, "out", "scenes");
  rmSync(scenesDir, { recursive: true, force: true });
  mkdirSync(scenesDir, { recursive: true });
  const fps = sb.output.fps, audio = Boolean(sb.audio);
  const threads = process.env.TAKEONE_RENDER_THREADS ?? "2";
  const cuts: SceneCut[] = [];
  for (const [i, s] of sb.scenes.entries()) {
    const a = Math.round((s.at ?? 0) * fps), b = Math.round(((s.at ?? 0) + s.d) * fps);
    const title = s.title ?? s.label ?? s.logo ?? s.text ?? s.pattern;
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || s.pattern;
    const name = `${String(i + 1).padStart(2, "0")}-${slug}.mp4`;
    await execFileAsync("ffmpeg", ["-nostdin", "-v", "error", "-y", "-i", film,
      "-vf", `trim=start_frame=${a}:end_frame=${b},setpts=PTS-STARTPTS`,
      ...(audio ? ["-af", `atrim=start=${a / fps}:end=${b / fps},asetpts=PTS-STARTPTS`, "-c:a", "aac", "-b:a", "192k"] : ["-an"]),
      "-c:v", "libx264", "-crf", "10", "-preset", "medium", "-pix_fmt", "yuv420p", "-threads", threads, "-filter_threads", threads,
      "-movflags", "+faststart", join(scenesDir, name)], { timeout: 900_000 });
    const p = probe(join(scenesDir, name));
    if (p.frames !== b - a) throw new Error(`hyperframes engine: scene ${i + 1} cut ${p.frames} frames, expected ${b - a}`);
    const [first, last] = await edgeLuma(join(scenesDir, name), b - a);
    for (const [edge, [lo, hi]] of [["first", first!], ["last", last!]] as const) {
      if (hi - lo < BLANK_LUMA_RANGE) throw new Error(`hyperframes engine: scene ${i + 1} (${name}) ${edge} frame is blank (luma ${lo}-${hi}); a cut-ready clip opens and ends on picture`);
    }
    cuts.push({ index: i + 1, file: `out/scenes/${name}`, start: a / fps, end: b / fps, title, pattern: s.pattern, frames: b - a });
  }
  writeFileSync(join(dir, "out", "scenes.json"), `${JSON.stringify({ film: `out/${basename(film)}`, fps, scenes: cuts }, null, 2)}\n`);
  return cuts;
}

