// Frame-stepped CDP renderer: N fixed workers, each a pinned headless shell, seek -> capture -> encode.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { launch, navigate, shellFlags, type Browser } from "./cdp.ts";
import { pinnedShell, type Shell } from "./shell.ts";
import { averagePngs } from "./png.ts";

export const WARMUP = 3;
export const SETTLE = 2;
export const MOTION_CRF = 10;

export interface FramePlan {
  /** Sub-frame offsets (in frames, centred on 0) per output frame; absent or [0] = one sample. */
  samples?: (number[] | undefined)[];
}

export interface FrameJob {
  html: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  workers: number;
  /** Pages may hand out a sub-range: page time of output frame i is (i + firstFrame) / fps. */
  firstFrame?: number;
  plan?: FramePlan;
  /** Encode to this MP4 (H.264 High, yuv420p, bt709 tagged). */
  mp4?: string;
  crf?: number;
  preset?: string;
  /** Keep every PNG here (frame 1 = 000001.png). */
  framesDir?: string;
  shell?: Shell;
  /** Supersample moving bitmap cameras, then downsample in the encoder. */
  rasterScale?: 1 | 2;
}

export interface FrameResult {
  md5: string[];
  render_s: number;
  concat_s: number;
  workers: number;
  shell: Shell;
  flags: string[];
  requests: string[];
}

/** Open a motion page in a fresh pinned shell and wait until it is seekable. Fails on any non-local request. */
export async function openPage(shell: Shell, html: string, width: number, height: number, requests: string[], rasterScale: 1 | 2 = 1): Promise<Browser> {
  const b = await launch(shell.path, { width, height, dsf: rasterScale });
  try {
    const errors: string[] = [];
    b.on("Network.requestWillBeSent", (p) => {
      const url = String((p["request"] as { url?: string })?.url ?? "");
      if (!/^(file|data|blob|about):/.test(url)) requests.push(url);
    });
    b.on("Runtime.exceptionThrown", (p) => errors.push(JSON.stringify(p["exceptionDetails"]).slice(0, 400)));
    await b.send("Network.enable");
    await b.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await b.send("Runtime.enable");
    await b.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: rasterScale, mobile: false });
    await navigate(b, pathToFileURL(html).href);
    await b.evaluate(`(async () => { await window.ready; installSeek(${SETTLE}); })()`);
    if (errors.length) throw new Error(`motion page error: ${errors[0]}`);
    return b;
  } catch (e) {
    await b.close();
    throw e;
  }
}

async function capture(b: Browser): Promise<Buffer> {
  const { data } = await b.send<{ data: string }>("Page.captureScreenshot", { format: "png", optimizeForSpeed: true });
  return Buffer.from(data, "base64");
}

/** One output frame: a plain capture, or the average of sub-frame captures (motion blur). */
async function frameAt(b: Browser, i: number, fps: number, offsets: number[] | undefined): Promise<Buffer> {
  if (!offsets || offsets.length < 2) {
    await b.evaluate(`__seek(${(i * 1000) / fps})`);
    return capture(b);
  }
  const shots: Buffer[] = [];
  for (const o of offsets) {
    await b.evaluate(`__seek(${((i + o) * 1000) / fps})`);
    shots.push(await capture(b));
  }
  return averagePngs(shots);
}

export function encoder(out: string, fps: number, crf: number, preset: string, width: number, height: number): ChildProcess {
  return spawn("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "image2pipe", "-c:v", "png", "-framerate", String(fps), "-i", "-",
    "-vf", `scale=${width}:${height}:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv`,
    "-c:v", "libx264", "-threads", "2", "-profile:v", "high", "-crf", String(crf), "-preset", preset, "-r", String(fps),
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", out],
  { stdio: ["pipe", "ignore", "inherit"] });
}
const finished = (p: ChildProcess) => new Promise<void>((ok, bad) => {
  p.once("error", bad);
  p.once("close", c => c === 0 ? ok() : bad(new Error(`ffmpeg exited ${c}`)));
});

export async function encodeFrames(child: ChildProcess, frames: AsyncIterable<Uint8Array>): Promise<void> {
  try {
    await Promise.all([finished(child), pipeline(frames, child.stdin!)]);
  } finally {
    child.stdin?.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

export function ffmpegVersion(): string {
  return execFileSync("ffmpeg", ["-version"], { encoding: "utf8" }).split("\n")[0] ?? "";
}

/** Fixed contiguous slices balanced by capture cost, including subframe seeks. The plan and
 * worker count determine the boundaries; each frame is encoded in timeline order. */
export function workerCuts(frames: number, workers: number, plan?: FramePlan): number[] {
  const costs = [0];
  for (let i = 0; i < frames; i++) costs.push(costs[i]! + Math.max(1, plan?.samples?.[i]?.length ?? 1));
  const cuts = [0];
  for (let w = 1; w < workers; w++) {
    const target = costs[frames]! * w / workers;
    let cut = cuts[w - 1]! + 1;
    const limit = frames - (workers - w);
    while (cut < limit && Math.abs(costs[cut + 1]! - target) < Math.abs(costs[cut]! - target)) cut++;
    cuts.push(cut);
  }
  return [...cuts, frames];
}

/** Render frames [0, frames) of a motion page. Workers own contiguous slices; each first renders WARMUP discarded
 * frames before its slice so raster caches carry the same history as a serial run. */
export async function renderFrames(job: FrameJob): Promise<FrameResult> {
  const shell = job.shell ?? await pinnedShell();
  const workers = Math.max(1, Math.min(job.workers, job.frames));
  const cuts = workerCuts(job.frames, workers, job.plan);
  const first = job.firstFrame ?? 0;
  const requests: string[] = [];
  if (job.framesDir) { await rm(job.framesDir, { recursive: true, force: true }); await mkdir(job.framesDir, { recursive: true }); }
  const mp4 = job.mp4 ? resolve(job.mp4) : undefined;
  const segs = mp4 ? Array.from({ length: workers }, (_, w) => `${mp4}.seg${w}.mp4`) : [];
  const t0 = performance.now();
  const results = await Promise.allSettled(Array.from({ length: workers }, async (_, w) => {
    const f0 = cuts[w]!, f1 = cuts[w + 1]!;
    const b = await openPage(shell, job.html, job.width, job.height, requests, job.rasterScale);
    const enc = job.mp4 ? encoder(segs[w]!, job.fps, job.crf ?? MOTION_CRF, job.preset ?? "medium", job.width, job.height) : null;
    const md5: string[] = [];
    async function* frames() {
      for (let n = WARMUP; n > 0; n--) { const i = Math.max(0, f0 - n); await frameAt(b, i + first, job.fps, undefined); }
      for (let i = f0; i < f1; i++) {
        const png = await frameAt(b, i + first, job.fps, job.plan?.samples?.[i]);
        md5.push(createHash("md5").update(png).digest("hex"));
        if (job.framesDir) await writeFile(join(job.framesDir, `${String(i + 1).padStart(6, "0")}.png`), png);
        yield png;
      }
    }
    try {
      if (enc) await encodeFrames(enc, frames());
      else for await (const _png of frames()) { }
    } finally {
      await b.close();
    }
    return md5;
  }));
  const failed = results.find(result => result.status === "rejected");
  if (failed) {
    await Promise.all(segs.map(f => rm(f, { force: true })));
    throw failed.reason;
  }
  const parts = (results as PromiseFulfilledResult<string[]>[]).map(result => result.value);
  const render_s = (performance.now() - t0) / 1000;
  if (requests.length) throw new Error(`motion page tried to fetch ${requests[0]}; renders are offline`);
  let concat_s = 0;
  if (mp4) {
    const t1 = performance.now(), list = `${mp4}.segs.txt`;
    await writeFile(list, segs.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
    try {
      await finished(spawn("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", mp4], { stdio: ["ignore", "ignore", "inherit"] }));
    } finally {
      await Promise.all([list, ...segs].map((f) => rm(f, { force: true })));
    }
    concat_s = (performance.now() - t1) / 1000;
  }
  return { md5: parts.flat(), render_s, concat_s, workers, shell, flags: shellFlags({ width: job.width, height: job.height, dsf: job.rasterScale ?? 1 }, "<profile>"), requests };
}

/** Evaluate an expression in a seekable page (planning passes: motion-blur speeds, measurements). */
export async function withPage<T>(html: string, width: number, height: number, fn: (b: Browser) => Promise<T>, shell?: Shell): Promise<T> {
  const requests: string[] = [];
  const b = await openPage(shell ?? await pinnedShell(), html, width, height, requests);
  try { const value = await fn(b); if (requests.length) throw new Error(`motion page tried to fetch ${requests[0]}`); return value; } finally { await b.close(); }
}
