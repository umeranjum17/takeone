#!/usr/bin/env node
// Offline output acceptance: no desktop, credentials, model calls or npm additions.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULTS } from '../src/camera/defaults.ts';
import type { CameraFrame, Beat, TakeMeta } from '../src/camera/types.ts';
import { makeTake } from '../src/make.ts';
import { encodingOptions, measureCaptions, renderTake } from '../src/render/render.ts';
import { cameraFilter } from '../src/render/camera-filter.ts';
import { bandFrames, bandLayout, stageFrames, stageGeometry, takeCaptions, type Band } from '../src/render/stage.ts';
import { idleSqueezes, warp } from '../src/render/pace.ts';

export interface Metric { value: number; target: number; direction: 'max' | 'min'; unit: string; goalPassed: boolean }
export type Metrics = Record<string, Metric>;
const metric = (value: number, target: number, unit = '', direction: 'max' | 'min' = 'max'): Metric => ({ value, target, direction, unit, goalPassed: direction === 'max' ? value <= target : value >= target });
const delta = (a: number[]) => a.slice(1).map((v, i) => v - a[i]!);
const peak = (a: number[]) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const sign = (v: number, epsilon: number) => Math.abs(v) <= epsilon ? 0 : Math.sign(v);

/** Opposite movement must be separated by a contiguous rest, not tiny sign noise. */
export function reversals(velocity: number[], fps: number, epsilon: number): number[] {
  let previous = 0, hold = 0;
  const holds: number[] = [];
  for (const v of velocity) {
    const s = sign(v, epsilon);
    if (!s) { hold++; continue; }
    if (previous && s !== previous) holds.push(hold / fps);
    previous = s; hold = 0;
  }
  return holds;
}

export function cameraMetrics(frames: CameraFrame[], fps: number, outW: number, outH: number, minShot: number): Metrics {
  if (frames.length < 3 || frames.some(f => ![f.t, f.x, f.y, f.w, f.h].every(Number.isFinite) || f.w <= 0 || f.h <= 0)) throw new Error('invalid camera path');
  const zoomV = delta(frames.map(f => -Math.log(f.w))).map(v => v * fps);
  // Project the source origin into output space, which includes zoom-induced pan.
  const vx = delta(frames.map(f => -f.x * outW / f.w)).map(v => v * fps);
  const vy = delta(frames.map(f => -f.y * outH / f.h)).map(v => v * fps);
  const ax = delta(vx).map(v => v * fps), ay = delta(vy).map(v => v * fps);
  const holds = reversals(zoomV, fps, 0.005);
  return {
    max_upscale: metric(Math.max(...frames.map(f => outW / f.w)), 1, 'output px/source px'),
    zoom_speed: metric(peak(zoomV), 1, 'ln/s'),
    zoom_acceleration: metric(peak(delta(zoomV).map(v => v * fps)), 4, 'ln/s²'),
    zoom_opposite_hold: metric(holds.length ? Math.min(...holds) : minShot, minShot, 's', 'min'),
    pan_acceleration: metric(Math.max(...ax.map((v, i) => Math.hypot(v, ay[i]!))), 9000, 'px/s²'),
    pan_bounce: metric([...reversals(vx, fps, 1), ...reversals(vy, fps, 1)].filter(h => h < minShot).length, 0, 'flips'),
  };
}

/** Baselines relax only today's failing values; passing values retain the goal. */
export function regressions(metrics: Metrics, baseline: Metrics): string[] {
  const failures: string[] = [];
  for (const [name, m] of Object.entries(metrics)) {
    const b = baseline[name];
    if (!Number.isFinite(m.value) || !b || !Number.isFinite(b.value) || b.direction !== m.direction || b.target !== m.target) { failures.push(`${name}: missing/invalid baseline or measurement`); continue; }
    const limit = m.direction === 'max' ? Math.max(m.target, b.value) : Math.min(m.target, b.value);
    // Only machine round-off is ignored. No percentage slack hiding regressions.
    const tolerance = Math.max(1, Math.abs(limit)) * 1e-6;
    if (m.direction === 'max' ? m.value > limit + tolerance : m.value < limit - tolerance) failures.push(`${name}: ${m.value} vs limit ${limit} (goal ${m.target})`);
  }
  for (const name of Object.keys(baseline)) if (!metrics[name]) failures.push(`${name}: measurement disappeared`);
  return failures;
}

function command(bin: string, args: string[]): Buffer {
  return execFileSync(bin, args, { maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
function ffmpeg(args: string[]): Buffer { return command('ffmpeg', ['-nostdin', '-v', 'error', ...args]); }
function json<T>(file: string): T { return JSON.parse(readFileSync(file, 'utf8')) as T; }
function save(file: string, value: unknown) { writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
function sha(file: string): string { return createHash('sha256').update(readFileSync(file)).digest('hex'); }

function frameRows(video: string, filter: string): Buffer {
  return ffmpeg(['-i', video, '-vf', filter, '-pix_fmt', 'gray', '-f', 'rawvideo', '-']);
}
/** Squared luma gradients per pixel. A native crop supplies the text/contrast reference. */
export function gradientEnergy(pixels: Uint8Array, width: number): number {
  if (width < 2 || pixels.length % width || pixels.length < width * 2) throw new Error('invalid sharpness crop');
  let energy = 0;
  for (let y = 1; y < pixels.length / width; y++) for (let x = 1; x < width; x++) {
    const i = y * width + x;
    energy += (pixels[i]! - pixels[i - 1]!) ** 2 + (pixels[i]! - pixels[i - width]!) ** 2;
  }
  return energy / ((width - 1) * (pixels.length / width - 1));
}

export function lumaStats(pixels: Uint8Array): { mean: number; variance: number } {
  if (!pixels.length) throw new Error('empty flat-surface sample');
  const mean = pixels.reduce((sum, value) => sum + value, 0) / pixels.length;
  const variance = pixels.reduce((sum, value) => sum + (value - mean) ** 2, 0) / pixels.length;
  return { mean, variance };
}

/** Absolute output gates shared by the harness and corrupted-render regressions. */
export function zoomAcceptance(reference: Uint8Array, decoded: Uint8Array, flatReference: { mean: number; variance: number }, flat: { mean: number; variance: number }) {
  const referenceEnergy = gradientEnergy(reference, 800);
  if (referenceEnergy < 10) throw new Error('sharpness reference has no usable text edges');
  const energy = gradientEnergy(decoded, 800);
  const ratio = energy / referenceEnergy;
  const target = 0.75;
  const flatTarget = 0.05;
  const sharpnessPassed = Number.isFinite(ratio) && ratio >= target;
  const flatPassed = flat.variance <= flatReference.variance + flatTarget && Math.abs(flat.mean - flatReference.mean) <= 4;
  return { ratio, referenceEnergy, energy, target, sharpnessPassed, flat, flatReference, flatTarget, flatPassed, passed: sharpnessPassed && flatPassed };
}

/** Decode native-size zoomed UI text through the actual camera and encoder. */
export function zoomSharpness(source: string, output: string) {
  mkdirSync(output, { recursive: true });
  const size = JSON.parse(command('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', source]).toString()).streams[0];
  if (size?.width !== 3840 || size?.height !== 2160) throw new Error('sharpness fixture must contain native 3840x2160 pixels');
  const reference = ffmpeg(['-i', source, '-vf', 'crop=800:160:530:310:exact=1', '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-']);
  const referenceEnergy = gradientEnergy(reference, 800);
  if (referenceEnergy < 10) throw new Error('sharpness reference has no usable text edges');
  const flatReference = lumaStats(ffmpeg(['-i', source, '-vf', 'crop=160:30:850:450:exact=1', '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-']));
  if (flatReference.variance > 0.05) throw new Error('sharpness fixture white-card patch is not flat');
  const measurements = [];
  for (const quality of ['standard', 'master'] as const) {
    const d = { ...DEFAULTS, quality };
    const video = join(output, `zoom-${quality}.mp4`);
    const filter = cameraFilter([{ t: 0, x: 520.25, y: 270.5, w: 1920, h: 1080 }], 3840, 2160, d);
    ffmpeg(['-y', '-loop', '1', '-i', source, '-vf', filter, '-t', '0.1', '-r', '60', ...encodingOptions(d), video]);
    const decoded = ffmpeg(['-i', video, '-vf', 'crop=800:160:10:40:exact=1', '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-']);
    ffmpeg(['-y', '-i', video, '-vf', 'crop=800:160:10:40:exact=1', '-frames:v', '1', join(output, `zoom-${quality}.png`)]);
    // Match the native stage dimensions at a held integer-pixel zoom. Kernel
    // rounding must not invent texture that the encoder amplifies on flat UI.
    const flatVideo = join(output, `flat-${quality}.mp4`);
    const flatFilter = `format=${quality === 'master' ? 'yuv444p' : 'yuv420p'},pad=4262:2398:211:119:color=0x2a2d38,`
      + cameraFilter([{ t: 0, x: 211, y: 119, w: 1920, h: 1080 }], 4262, 2398, d);
    ffmpeg(['-y', '-loop', '1', '-i', source, '-vf', flatFilter, '-t', '0.1', '-r', '60', ...encodingOptions(d), flatVideo]);
    const flat = lumaStats(ffmpeg(['-i', flatVideo, '-vf', 'crop=160:30:850:450:exact=1', '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-']));
    measurements.push({ quality, ...zoomAcceptance(reference, decoded, flatReference, flat), video, flatVideo });
  }
  return measurements;
}

export function widestRun(row: Uint8Array): number {
  let max = 0, run = 0, previous = -1;
  for (const v of row) { run = v === previous ? run + 1 : 1; previous = v; max = Math.max(max, run); }
  return max;
}

/** Subpixel edge centroid, measured from decoded output, around a predicted card edge. */
export function edgePosition(row: Uint8Array, predicted: number): number | null {
  const lo = Math.max(1, Math.floor(predicted - 5)), hi = Math.min(row.length - 1, Math.ceil(predicted + 5));
  let sum = 0, weighted = 0;
  for (let x = lo; x <= hi; x++) {
    const weight = Math.abs(row[x]! - row[x - 1]!);
    sum += weight; weighted += (x - 0.5) * weight;
  }
  return sum >= 20 ? weighted / sum : null;
}
function judder(video: string, frames: CameraFrame[], meta: TakeMeta, d: typeof DEFAULTS, required: boolean, band: Band | null): { rms: number; samples: number } | null {
  // A 3-row strip through the straight card edge avoids corners, captions and rescaling.
  // A banded card never moves, so track the source sidebar divider moving inside it instead.
  const rows = frameRows(video, `crop=iw:3:0:${Math.floor(d.out_h / 2)}:exact=1`);
  const st = stageGeometry(meta.width, meta.height, d);
  const source = band ? 319 : st.screenX;
  const [lo, hi] = band ? [band.stage.screenX + 8, band.stage.screenX + band.stage.baseW - 8] : [8, d.out_w - 8];
  const residuals: (number | null)[] = [];
  for (let i = 0; i < Math.min(frames.length, rows.length / (3 * d.out_w)); i++) {
    const f = frames[i]!;
    const expected = (source - f.x) * d.out_w / f.w;
    const row = rows.subarray(i * 3 * d.out_w + d.out_w, i * 3 * d.out_w + 2 * d.out_w);
    const edge = expected > lo && expected < hi && f.t > 0.5 ? edgePosition(row, expected) : null;
    residuals.push(edge === null ? null : edge - expected);
  }
  const jitter: number[] = [];
  for (let i = 2; i < residuals.length; i++) {
    const a = residuals[i - 2], b = residuals[i - 1], c = residuals[i];
    // Only include moving camera, to keep long rest periods from diluting RMS.
    if (a != null && b != null && c != null && peak([frames[i]!.x - frames[i - 1]!.x, frames[i]!.w - frames[i - 1]!.w]) > 0.01) jitter.push(c - 2 * b + a);
  }
  if (!jitter.length) {
    const moving = frames.some((f, i) => i > 0 && peak([f.x - frames[i - 1]!.x, f.y - frames[i - 1]!.y, f.w - frames[i - 1]!.w]) > 0.01);
    if (moving) {
      if (required) throw new Error('no moving visible edge samples for judder');
      return null;
    }
    return { rms: 0, samples: 0 }; // Explicitly no motion at the native-resolution cap.
  }
  return { rms: Math.sqrt(jitter.reduce((s, v) => s + v * v, 0) / jitter.length), samples: jitter.length };
}

function outputCaptions(dir: string, meta: TakeMeta, d: typeof DEFAULTS, duration: number) {
  const beats = json<Beat[]>(join(dir, 'analysis/beats.json')).map(b => ({ ...b, actions: b.actions.map(a => {
    const v = a as { t?: number; t0?: number; t1?: number };
    return { ...v, ...(v.t === undefined ? {} : { t: v.t * 1000 }), ...(v.t0 === undefined ? {} : { t0: v.t0 * 1000 }), ...(v.t1 === undefined ? {} : { t1: v.t1 * 1000 }) };
  }) }));
  const start = meta.trim_start ?? 0;
  const squeezes = idleSqueezes(beats, start, meta.trim_end!, d);
  return takeCaptions(meta, t => warp(t - start, squeezes, d.idle_speed), duration);
}

function captions(video: string, dir: string, meta: TakeMeta, d: typeof DEFAULTS, duration: number, band: Band | null) {
  const expected = outputCaptions(dir, meta, d, duration);
  const assTime = (s: string) => s.split(':').reduce((n, part) => n * 60 + Number(part), 0);
  const pills = readFileSync(join(dir, 'captions.ass'), 'utf8').split('\n').flatMap(line => {
    if (!line.startsWith('Dialogue:') || !line.includes('\\p1}')) return [];
    const fields = line.split(',');
    const position = line.match(/\\move\([\d.]+,[\d.]+,([\d.]+),([\d.]+)/);
    const shape = line.match(/}m (.*)$/);
    if (!position || !shape) throw new Error('unrecognized caption pill geometry');
    const coords = [...shape[1]!.matchAll(/-?\d+(?:\.\d+)?/g)].map(m => Number(m[0]));
    const xs = coords.filter((_, i) => i % 2 === 0), ys = coords.filter((_, i) => i % 2 === 1);
    return [{ t0: assTime(fields[1]!), t1: assTime(fields[2]!), x0: Number(position[1]) + Math.min(...xs), x1: Number(position[1]) + Math.max(...xs), y0: Number(position[2]) + Math.min(...ys), y1: Number(position[2]) + Math.max(...ys) }];
  });
  const times = [...new Set(expected.flatMap(c => [c.t0, c.t1]))].sort((a, b) => a - b);
  const checks = [];
  for (let i = 1; i < times.length; i++) {
    const a = times[i - 1]!, b = times[i]!;
    if (b - a < 0.5) continue; // fade-in/out aren't legibility checkpoints
    const t = (a + b) / 2;
    const active = expected.filter(c => c.t0 <= t && c.t1 > t);
    if (!active.length) continue;
    const png = join(dir, `ocr-${i}.png`);
    // Banded text has the band to itself, pill or not.
    const boxes = band ? [{ x0: 4, x1: d.out_w - 4, y0: band.top + 4, y1: d.out_h - 4 }] : pills.filter(p => p.t0 <= t && p.t1 > t);
    if (!boxes.length) throw new Error('missing caption strip geometry');
    const x = Math.max(0, Math.floor(Math.min(...boxes.map(p => p.x0)) - 4));
    const y = Math.max(0, Math.floor(Math.min(...boxes.map(p => p.y0)) - 4));
    const w = Math.min(d.out_w - x, Math.ceil(Math.max(...boxes.map(p => p.x1)) + 4) - x);
    const h = Math.min(d.out_h - y, Math.ceil(Math.max(...boxes.map(p => p.y1)) + 4) - y);
    ffmpeg(['-y', '-ss', String(t), '-i', video, '-vf', `crop=${w}:${h}:${x}:${y}:exact=1`, '-frames:v', '1', png]);
    const actual = command('tesseract', [png, 'stdout', '--psm', '6']).toString().replace(/\s+/g, ' ').trim();
    const text = active.map(c => c.text).join(' ');
    checks.push({ t, expected: text, actual, exact: text === actual });
  }
  if (expected.length && !checks.length) throw new Error('caption OCR yielded no checkpoints');
  return checks;
}

export function compare(video: string, golden: string, output: string, vmaf: boolean) {
  const count = (file: string): number => {
    const probe = JSON.parse(command('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'json', file]).toString());
    const n = Number(probe.streams[0]?.nb_read_frames);
    if (!Number.isFinite(n) || n < 1) throw new Error('invalid golden/candidate frame count');
    return n;
  };
  const candidateFrames = count(video), goldenFrames = count(golden);
  const stats = join(output, 'ssim.log');
  ffmpeg(['-i', video, '-i', golden, '-filter_complex', `[0:v]setpts=PTS-STARTPTS[a];[1:v]setpts=PTS-STARTPTS[b];[a][b]ssim=stats_file=${stats}`, '-f', 'null', '-']);
  const scores = [...readFileSync(stats, 'utf8').matchAll(/n:(\d+).*All:([\d.]+)/g)].map(m => ({ frame: Number(m[1]), ssim: Number(m[2]) }));
  if (!scores.length) throw new Error('SSIM produced no scores');
  let vmafScore: number | null = null;
  if (vmaf) {
    const log = join(output, 'vmaf.json');
    ffmpeg(['-i', video, '-i', golden, '-filter_complex', `[0:v]setpts=PTS-STARTPTS[a];[1:v]setpts=PTS-STARTPTS[b];[a][b]libvmaf=log_fmt=json:log_path=${log}:n_threads=2`, '-f', 'null', '-']);
    vmafScore = json<{ pooled_metrics: { vmaf: { mean: number } } }>(log).pooled_metrics.vmaf.mean;
  }
  return { candidateFrames, goldenFrames, timelineMismatch: candidateFrames !== goldenFrames, minSSIM: Math.min(...scores.map(s => s.ssim)), framesBelow095: scores.filter(s => s.ssim < 0.95), vmaf: vmafScore, mode: vmaf ? 'SSIM + VMAF' : 'SSIM only: ffmpeg has no libvmaf' };
}

async function main() {
  const args = process.argv.slice(2);
  const allowed = ['--init-baseline', '--ratchet', '--accept-golden', '--reuse'];
  if (args.some(a => !allowed.includes(a))) throw new Error(`usage: node scripts/quality.ts [${allowed.join('] [')}]`);
  const root = resolve('tmp/quality'), baselineDir = resolve('scripts/quality-baseline');
  mkdirSync(root, { recursive: true });
  const baselineFile = join(baselineDir, 'metrics.json');
  const initialize = args.includes('--init-baseline');
  if (initialize && existsSync(baselineFile)) throw new Error('baseline exists; use --ratchet (cannot loosen limits)');
  const stored = initialize ? null : json<Record<string, Metrics>>(baselineFile);
  const vmaf = command('ffmpeg', ['-hide_banner', '-filters']).toString().includes('libvmaf');
  const report: Record<string, unknown> = { version: 1, dirty: Boolean(command('git', ['status', '--porcelain']).toString().trim()), harnessSha256: sha(resolve('scripts/quality.ts')), revision: command('git', ['rev-parse', 'HEAD']).toString().trim(), ffmpeg: command('ffmpeg', ['-version']).toString().split('\n')[0], tesseract: command('tesseract', ['--version']).toString().split('\n')[0], vmafAvailable: vmaf, fixtures: {} };
  const baselines: Record<string, Metrics> = {};
  const failures: string[] = [];
  const sharpness = zoomSharpness(join(baselineDir, 'tidewater-4k.png'), join(root, 'sharpness'));
  report.sharpness = { sourceSha256: sha(join(baselineDir, 'tidewater-4k.png')), sourceWidth: 3840, sourceHeight: 2160, measurements: sharpness };
  failures.push(...sharpness.filter(m => !m.sharpnessPassed).map(m => `zoom sharpness ${m.quality}: ${m.ratio} < ${m.target}`));
  failures.push(...sharpness.filter(m => !m.flatPassed).map(m => `flat card ${m.quality}: variance ${m.flat.variance} (limit ${m.flatTarget}), mean ${m.flat.mean} vs reference ${m.flatReference.mean}`));
  for (const fixture of ['synth', 'portrait']) {
    console.error(`quality: ${fixture}`);
    const dir = join(root, fixture);
    const d = { ...DEFAULTS, fps: 60, caption_font: 'Liberation Sans', ...(fixture === 'portrait' ? { out_w: 1080, out_h: 1920 } : {}) };
    const video = join(dir, 'out', `${fixture === 'synth' ? 'synth-demo' : 'portrait'}.mp4`);
    if (!args.includes('--reuse')) {
      command(process.execPath, [resolve(`scripts/synth-${fixture === 'synth' ? 'take' : 'portrait'}.ts`), dir]);
      if (fixture === 'portrait') {
        const meta = json<Record<string, unknown>>(join(dir, 'take.json'));
        save(join(dir, 'take.json'), { ...meta, title: 'Explore the demo', captions: [{ t: 3, text: 'Tap to see details' }] });
      }
      await makeTake(dir, { noJev: true, camera: d });
    }
    const original = sha(video);
    await renderTake(dir, d);
    const deterministic = original === sha(video);
    const meta = json<TakeMeta>(join(dir, 'take.json'));
    const camera = json<CameraFrame[]>(join(dir, 'camera.json'));
    let band = meta.title || meta.captions?.length ? bandLayout(meta.width, meta.height, d) : null;
    if (band) {
      const duration = camera.at(-1)!.t + 1 / d.fps;
      const captions = outputCaptions(dir, meta, d, duration);
      const ink = await measureCaptions(dir, captions, d, band);
      band = bandLayout(meta.width, meta.height, d, captions, ink);
    }
    const frames = band ? bandFrames(camera, band, d) : stageFrames(camera, meta.width, meta.height, stageGeometry(meta.width, meta.height, d), d);
    const probe = JSON.parse(command('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', video]).toString());
    const stream = probe.streams[0];
    const timestamps = JSON.parse(command('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', video]).toString()).frames.map((f: { best_effort_timestamp_time: string }) => Number(f.best_effort_timestamp_time));
    const hashes = ffmpeg(['-i', video, '-f', 'framemd5', '-']).toString().split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(',').at(-1)!.trim());
    let hitches = 0;
    hashes.forEach((h, i) => { if (i && h === hashes[i - 1] && frames[i] && peak(['x', 'y', 'w'].map(k => frames[i]![k as 'x'] - frames[i - 1]![k as 'x'])) > 0.01) hitches++; });
    const rest = frames.find(f => f.t >= 0.7 && f.t < 1.2) ?? frames[0]!;
    const row = ffmpeg(['-ss', String(rest.t), '-i', video, '-vf', 'crop=iw:1:0:10:exact=1', '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-']);
    const edge = judder(video, frames, meta, d, fixture === 'synth', band);
    const ocr = captions(video, dir, meta, d, frames.at(-1)!.t, band);
    const metrics: Metrics = {
      ...cameraMetrics(frames, d.fps, d.out_w, d.out_h, d.min_shot),
      default_fps_error: metric(Math.abs(DEFAULTS.fps - 60), 0, 'fps'),
      fps_error: metric(Math.abs(Number(stream.avg_frame_rate.split('/')[0]) / Number(stream.avg_frame_rate.split('/')[1]) - 60), 0, 'fps'),
      cadence_error: metric(peak(delta(timestamps).map(v => v - 1 / 60)), 0.000002, 's'),
      size_error: metric(Math.abs(stream.width - d.out_w) + Math.abs(stream.height - d.out_h), 0, 'px'),
      codec_error: metric(Number(stream.codec_name !== 'h264') + Number(stream.profile !== 'High') + Number(stream.pix_fmt !== 'yuv420p'), 0),
      colour_error: metric(['color_space', 'color_transfer', 'color_primaries'].filter(k => stream[k] !== 'bt709').length + Number(stream.color_range !== 'tv'), 0),
      frame_count_error: metric(Math.abs(Number(stream.nb_read_frames) - camera.length), 1, 'frames'),
      hitches: metric(hitches, 0, 'frames'),
      determinism_error: metric(Number(!deterministic), 0),
      ...(edge ? { subpixel_judder: metric(edge.rms, 0.15, 'px/frame²') } : {}),
      caption_ocr_errors: metric(ocr.filter(c => !c.exact).length, 0, 'checkpoints'),
      banding: metric(widestRun(row), 64, 'px'),
    };
    for (const key of ['color_space', 'color_transfer', 'color_primaries', 'color_range']) metrics[key + '_error'] = metric(Number(stream[key] !== (key === 'color_range' ? 'tv' : 'bt709')), 0);
    const texts = [meta.title, ...(meta.captions ?? []).map(c => c.text)].filter((t): t is string => Boolean(t));
    texts.forEach((text, index) => {
      const checks = ocr.filter(c => c.expected.includes(text));
      metrics[`caption_ocr_item_${index}`] = metric(Number(!checks.length || checks.some(c => !c.exact)), 0);
    });
    // Motion blur does not exist yet. Never invent a passing ghosting measurement.
    const golden = join(baselineDir, `${fixture}.mp4`);
    const regression = initialize ? null : compare(video, golden, dir, vmaf);
    const fixtureFailures = initialize ? Object.entries(metrics).filter(([, m]) => !Number.isFinite(m.value)).map(([k]) => `${k}: nonfinite measurement`) : regressions(metrics, stored![fixture]!);
    if (regression && !args.includes('--accept-golden')) {
      if (regression.timelineMismatch) fixtureFailures.push(`golden timeline: ${regression.candidateFrames} frames vs ${regression.goldenFrames}; human review required`);
      if (!Number.isFinite(regression.minSSIM) || (regression.vmaf !== null && !Number.isFinite(regression.vmaf))) fixtureFailures.push('similarity score is not finite');
      if (regression.vmaf !== null && regression.vmaf < 95) fixtureFailures.push(`VMAF: ${regression.vmaf} < 95`);
    }
    failures.push(...fixtureFailures.map(f => `${fixture}: ${f}`));
    baselines[fixture] = metrics;
    (report.fixtures as Record<string, unknown>)[fixture] = { metrics, sha256: sha(video), goldenSha256: existsSync(golden) ? sha(golden) : null, stream, source: JSON.parse(command('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', join(dir, 'screen.webm')]).toString()).streams[0], cameraFrames: camera.length, decodedFrames: hashes.length, judderSamples: edge?.samples ?? 0, judderStatus: edge ? (edge.samples ? 'measured' : 'not-applicable: no camera motion at native cap') : 'not-applicable: optional fixture has no measurable judder', ocr, regression, motionBlurGhosting: { status: 'not-applicable', reason: 'motion blur ghosting is qualified separately; see docs/motion-blur.md' }, failures: fixtureFailures };
  }
  report.failures = failures;
  save(join(root, 'metrics.json'), report);
  if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; return; }
  if (initialize || args.includes('--ratchet')) save(baselineFile, baselines);
  if (initialize || args.includes('--accept-golden')) {
    for (const fixture of ['synth', 'portrait']) copyFileSync(join(root, fixture, 'out', `${fixture === 'synth' ? 'synth-demo' : 'portrait'}.mp4`), join(baselineDir, `${fixture}.mp4`));
  }
  console.error(`quality: passed; metrics ${join(root, 'metrics.json')}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(e => {
  mkdirSync(resolve('tmp/quality'), { recursive: true });
  save(resolve('tmp/quality/error.json'), { error: String(e), revision: command('git', ['rev-parse', 'HEAD']).toString().trim() });
  console.error(e); process.exitCode = 1;
});
