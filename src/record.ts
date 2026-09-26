/**
 * `takeone record` orchestration: capture + taps + stop handling + take.json.
 */

import { mkdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveEngine } from "@desklink/host";
import { alignClock, SPREAD_WARN_MS, type ClockAlign } from "./clock.js";
import { pickMonitor, type MonitorInfo } from "./mapping.js";
import { getMonitors, hyprlandSockets } from "./hyprland.js";
import { startCapture, DEFAULT_BITRATE_KBPS, DEFAULT_FPS, RecordError } from "./session.js";
import { startTaps, type TapHandle } from "./taps.js";
import { consumeToken } from "./token.js";
import { withPidLock } from "./takes.js";
import type { TakeMeta } from "./types.js";

export const VERSION = "0.1.0";

export interface RecordOptions {
  fps?: number;
  bitrateKbps?: number;
  takesRoot?: string;
  stateDirPath?: string;
}

export interface RecordResult {
  takeDir: string;
  takeJson: TakeJson;
}

export interface TakeJson extends TakeMeta {
  id: string;
  started_at: string;
  stopped_at: string;
  fps: number;
  bitrate_kbps: number;
  geometry: unknown;
  monitor: unknown;
  pointer: "mapped" | "none";
  events: "on" | "none";
  warnings: string[];
  clock: ClockAlign | null;
  metrics: unknown | null;
  versions: { takeone: string; engine: string; protocol: number; node: string };
}

function takeId(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function defaultTakesRoot(): string {
  return process.env.TAKEONE_DIR ?? join(homedir(), "Videos", "takeone");
}

export function defaultStateDir(): string {
  return process.env.TAKEONE_STATE_DIR ?? join(homedir(), ".local", "state", "takeone");
}

async function writePidFile(stateDirPath: string, takeDir: string, startedAt: string): Promise<void> {
  await mkdir(stateDirPath, { recursive: true, mode: 0o700 });
  const payload = JSON.stringify({ pid: process.pid, take: takeDir, started_at: startedAt });
  const pidPath = join(stateDirPath, "recording.pid");
  try {
    await writeFile(pidPath, payload, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new RecordError("already-recording", "another recorder owns the PID marker", "run `takeone stop` before recording again");
  }
}

/**
 * Runs until stopped (SIGINT/SIGTERM, what `takeone stop` sends). Resolves
 * with the finished take's summary, or rejects with a structured RecordError.
 */
export async function runRecord(options: RecordOptions = {}): Promise<RecordResult> {
  const fps = options.fps ?? DEFAULT_FPS;
  const bitrateKbps = options.bitrateKbps ?? DEFAULT_BITRATE_KBPS;
  const root = options.takesRoot !== undefined ? resolve(options.takesRoot) : defaultTakesRoot();
  const stateDirPath =
    options.stateDirPath !== undefined ? resolve(options.stateDirPath) : defaultStateDir();

  const engine = resolveEngine();
  if (engine === null) {
    throw new RecordError(
      "engine-missing",
      "the desklink-host engine binary was not found",
      "run `takeone doctor` for the exact missing piece",
    );
  }

  await mkdir(root, { recursive: true });
  const startedAt = new Date();
  const id = takeId(startedAt);
  let takeDir = join(root, id);
  for (let suffix = 1; ; suffix++) {
    try { await mkdir(takeDir, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      takeDir = join(root, `${id}-${suffix}`);
    }
  }
  try {
    await withPidLock(stateDirPath, () => writePidFile(stateDirPath, takeDir, startedAt.toISOString()));
  } catch (error) {
    await rm(takeDir, { recursive: true, force: true });
    throw error;
  }

  let taps: TapHandle | null = null;
  let capture: Awaited<ReturnType<typeof startCapture>> | null = null;
  // The stop handlers are registered before the consent dialog can appear, so
  // `takeone stop` always works - including while waiting on the prompt.
  let resolveStopped!: (at: Date) => void;
  const stopped = new Promise<Date>((resolveP) => {
    resolveStopped = resolveP;
  });
  const onStop = (): void => {
    process.off("SIGINT", onStop);
    process.off("SIGTERM", onStop);
    resolveStopped(new Date());
  };
  process.on("SIGINT", onStop);
  process.on("SIGTERM", onStop);
  try {
    // Consume the single-use restore token before sending it.
    const savedToken = await consumeToken(stateDirPath);
    capture = await startCapture({
      engine,
      takeDir,
      stateDir: stateDirPath,
      fps,
      bitrateKbps,
      savedToken,
      interrupted: stopped,
    });

    // Coordinate-mapping self-check at record start: no monitor matching the
    // stream size within 2 px means no-pointer mode.
    let mapping: { monitor: MonitorInfo; scale: number } | null = null;
    let monitorRecord: unknown = null;
    const hypr = hyprlandSockets();
    if (hypr !== null) {
      const monitors = await getMonitors(hypr.socket);
      const picked = pickMonitor(monitors, capture.geometry);
      if (picked !== null) {
        mapping = picked;
        monitorRecord = picked.monitor;
      }
    }

    const t0ns = capture.startedNs;
    taps = await startTaps({
      eventsPath: join(takeDir, "events.jsonl"),
      mapping,
      t0ns,
    });

    const stoppedAt = await stopped;

    const finalMetrics = await capture.stop();
    if (taps !== null) await taps.stop();

    const clock = alignClock(capture.frames().map((frame) => ({ ...frame, recvMs: frame.recvMs - Number(t0ns) / 1e6 })));
    const durationMs = Math.max(0, stoppedAt.getTime() - startedAt.getTime());
    const warnings = [...taps.warnings];
    if (clock !== null && clock.spreadMs > SPREAD_WARN_MS) {
      warnings.push(`clock offset spread ${clock.spreadMs.toFixed(1)} ms exceeds ${SPREAD_WARN_MS} ms`);
    }

    const takeJson: TakeJson = {
      id: takeDir.slice(root.length + 1),
      stream: { w: capture.geometry.encoded.width, h: capture.geometry.encoded.height },
      scale: mapping?.scale ?? 1,
      offset_ms: clock?.offsetMs ?? 0,
      started_at: startedAt.toISOString(),
      stopped_at: stoppedAt.toISOString(),
      fps,
      bitrate_kbps: bitrateKbps,
      geometry: capture.geometry,
      monitor: monitorRecord,
      pointer: taps.pointerMode,
      events: taps.eventsMode,
      warnings,
      clock,
      trim: computeTrim(taps.summary, durationMs),
      metrics: finalMetrics,
      versions: {
        takeone: VERSION,
        engine: capture.engineVersion,
        protocol: 2,
        node: process.version,
      },
    };
    await writeFile(join(takeDir, "take.json"), `${JSON.stringify(takeJson, null, 2)}\n`, { mode: 0o600 });
    return { takeDir, takeJson };
  } finally {
    await rm(join(stateDirPath, "recording.pid"), { force: true }).catch(() => undefined);
    if (taps !== null) await taps.stop().catch(() => undefined);
    if (capture !== null) await capture.stop().catch(() => undefined);
  }
}

/**
 * Auto-trim bounds (design section 5 step 6). The start is the first input
 * event (click/key/wheel; pointer moves are not actions) that lands more than
 * 1 s into the take, minus 0.5 s. The end is the stop keypress minus 0.3 s
 * when a key was pressed near the stop; otherwise the take's end.
 */
export function computeTrim(
  summary: { firstInputMs: number | null; lastKeyMs: number | null },
  durationMs: number,
): { start: number; end: number } {
  let start = 0;
  if (summary.firstInputMs !== null && summary.firstInputMs > 1000) {
    start = Math.max(0, summary.firstInputMs - 500);
  }
  let end = durationMs;
  if (summary.lastKeyMs !== null && durationMs - summary.lastKeyMs <= 5000) {
    end = Math.max(0, summary.lastKeyMs - 300);
  }
  return { start, end: Math.max(start, Math.min(end, durationMs)) };
}
