// Output gates for a rendered motion film: frozen time and, when a bed is muxed, loudness.
// Adapted from motion-video-kit by echris6 (MIT, see THIRD_PARTY_NOTICES.md): the YDIF < 0.35 frozen-time
// metric, the "no motionless stretch over 0.6 s" and "frozen <= 1 s per 30 s" numbers, and the ebur128 recipe.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Storyboard } from "./types.ts";

const execFileAsync = promisify(execFile);

export const FROZEN_SAMPLE_FPS = 10;
export const FROZEN_YDIF = 0.35;
export const FROZEN_LONGEST_S = 0.6;
export const FROZEN_PER_30S = 1.0;
/** The per-30 s total only applies to films at least this long; shorter ones report it and gate on the longest run. */
export const FROZEN_TOTAL_MIN_FILM_S = 10;
export const TRUE_PEAK_MAX_DBTP = -1;
export const LOUDNESS_BAND_LUFS: [number, number] = [-19, -14];

export interface FrozenReport { total: number; longest: number; runs: [number, number][]; per_30s: number; film_s: number; passed: boolean }

/** Runs of consecutive frozen samples outside the allow windows. Sample i (1-based) covers ((i-1)/fps, i/fps]; sample 0 is dropped. */
export function frozenRuns(ydif: number[], fps: number, allow: [number, number][] = []): { total: number; longest: number; runs: [number, number][] } {
  const runs: [number, number][] = [];
  let from = -1;
  const close = (end: number) => { if (from >= 0) runs.push([from / fps, end / fps]); from = -1; };
  for (let i = 1; i < ydif.length; i++) {
    const mid = (i - 0.5) / fps;
    const frozen = ydif[i]! < FROZEN_YDIF && !allow.some(([a, b]) => mid >= a && mid < b);
    if (frozen) { if (from < 0) from = i - 1; } else close(i - 1);
  }
  close(ydif.length - 1);
  return { total: runs.reduce((s, [a, b]) => s + b - a, 0), longest: runs.reduce((m, [a, b]) => Math.max(m, b - a), 0), runs };
}

/** The storyboard's end-card windows: the one place a motionless hold is the design. */
export function frozenAllowList(sb: Storyboard): [number, number][] {
  return sb.scenes.filter((s) => s.pattern === "end-card").map((s) => [s.at ?? 0, (s.at ?? 0) + s.d]);
}

export async function measureFrozen(film: string, sb: Storyboard, filmSeconds: number): Promise<FrozenReport> {
  const { stdout } = await execFileAsync("ffmpeg", ["-nostdin", "-v", "error", "-threads", "2", "-filter_threads", "2", "-i", film,
    "-vf", `fps=${FROZEN_SAMPLE_FPS},scale=320:-2,format=gray,signalstats,metadata=print:key=lavfi.signalstats.YDIF:file=-`, "-an", "-f", "null", "-"],
    { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
  // ffmpeg prints tiny values as 8.68e-05: a plain [\d.]+ parse would read that as 8.68 and hide a frozen sample.
  const ydif = [...stdout.matchAll(/YDIF=([\d.eE+-]+)/g)].map((m) => Number(m[1]));
  if (ydif.length < 2 || ydif.some((v) => !Number.isFinite(v))) throw new Error(`hyperframes engine: frozen-time check could not read ${film}`);
  const r = frozenRuns(ydif, FROZEN_SAMPLE_FPS, frozenAllowList(sb));
  const per30 = r.total * 30 / filmSeconds;
  const passed = r.longest <= FROZEN_LONGEST_S + 1e-9 && (filmSeconds < FROZEN_TOTAL_MIN_FILM_S || per30 <= FROZEN_PER_30S);
  return { ...r, per_30s: per30, film_s: filmSeconds, passed };
}

export interface LoudnessReport { integrated: number; true_peak: number; lra: number; passed: boolean; failures: string[] }

export function parseLoudness(meta: string): { integrated: number; true_peak: number; lra: number } {
  const last = (key: string): number => {
    const all = [...meta.matchAll(new RegExp(`lavfi\\.r128\\.${key}=(\\S+)`, "g"))].map((m) => Number(m[1]));
    return all.length ? all[all.length - 1]! : NaN;
  };
  const peaks = [...meta.matchAll(/lavfi\.r128\.true_peaks_ch\d+=(\S+)/g)].map((m) => Number(m[1]));
  const peak = peaks.length ? Math.max(...peaks) : NaN;
  return { integrated: last("I"), lra: last("LRA"), true_peak: peak > 0 ? 20 * Math.log10(peak) : -Infinity };
}

export async function measureLoudness(film: string, band: [number, number] = LOUDNESS_BAND_LUFS): Promise<LoudnessReport> {
  const { stdout } = await execFileAsync("ffmpeg", ["-nostdin", "-v", "error", "-threads", "2", "-i", film, "-map", "0:a:0",
    "-af", "ebur128=metadata=1:peak=true,ametadata=print:file=-", "-f", "null", "-"], { timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  const m = parseLoudness(stdout);
  const failures: string[] = [];
  if (!Number.isFinite(m.integrated)) failures.push("the audio bed is silent");
  else if (m.integrated < band[0] || m.integrated > band[1]) failures.push(`integrated loudness ${m.integrated.toFixed(1)} LUFS is outside ${band[0]}..${band[1]} LUFS; change audio.volume`);
  if (m.true_peak > TRUE_PEAK_MAX_DBTP) failures.push(`true peak ${m.true_peak.toFixed(1)} dBTP is above ${TRUE_PEAK_MAX_DBTP} dBTP; lower audio.volume`);
  return { ...m, passed: failures.length === 0, failures };
}
