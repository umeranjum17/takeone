/**
 * `takeone record` orchestration: capture + taps + stop handling + take.json.
 */

import { mkdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveEngine, type SourceRequest } from "@desklink/host";
import { alignClock, clockWarning, type ClockAlign } from "./clock.js";
import { pickMonitor, type MonitorInfo } from "./mapping.js";
import { getMonitors, hyprlandSockets } from "./hyprland.js";
import { startCapture, DEFAULT_BITRATE_KBPS, DEFAULT_FPS, RecordError } from "./session.js";
import { startTaps, type TapHandle } from "./taps.js";
import { consumeToken } from "./token.js";
import { processStartTicks } from "./takes.js";
import type { TakeMeta } from "./types.js";

export const VERSION = "0.1.0";

export interface RecordOptions {
  fps?: number;
  bitrateKbps?: number;
  takesRoot?: string;
  stateDirPath?: string;
  /** Portal (default) or an explicit X display; x11 skips the consent dialog. */
  source?: SourceRequest;
  /** "own" keeps today's taps; "none" never opens evdev or Hyprland. */
  events?: "own" | "none";
  /** Hard stop: seconds of recording before an automatic stop. */
  maxSeconds?: number;
  /** Fired once capture is established and frames are flowing. */
  onRecording?: (takeDir: string) => void;
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

/**
 * Hidden-cursor policy from `TAKEONE_CURSOR`. "hidden" forces the request;
 * "embedded" models a source that cannot hide the cursor, so the system cursor
 * is kept; anything else is the default auto policy. An X11 source is always
 * asked for hidden (its frames never carry the cursor), so "embedded" is a
 * no-op there.
 */
export function cursorPolicyFromEnv(): "hidden" | "embedded" | undefined {
  const value = process.env.TAKEONE_CURSOR;
  return value === "hidden" || value === "embedded" ? value : undefined;
}

async function writePidFile(stateDirPath: string, takeDir: string, startedAt: string): Promise<void> {
  await mkdir(stateDirPath, { recursive: true, mode: 0o700 });
  const startTicks = processStartTicks(process.pid);
  if (startTicks === null) throw new RecordError("pid-unavailable", "cannot read process start time", "check /proc is mounted");
  const payload = JSON.stringify({ pid: process.pid, start_ticks: startTicks, take: takeDir, started_at: startedAt });
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
  const tapsEnabled = (options.events ?? "own") !== "none";
  // A cursor-free session makes the engine the pointer source; Hyprland is the
  // fallback if the source cannot hide the cursor.
  const cursorPolicy = cursorPolicyFromEnv();
  if (options.maxSeconds !== undefined && (!Number.isFinite(options.maxSeconds) || options.maxSeconds <= 0)) {
    throw new RecordError("invalid-arguments", "--max-seconds must be a positive number of seconds", "pass e.g. --max-seconds 60");
  }

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
  let taps: TapHandle | null = null;
  let capture: Awaited<ReturnType<typeof startCapture>> | null = null;
  let consentGranted = false;
  let discardTake = false;
  // The stop handlers are registered before the consent dialog can appear, so
  // `takeone stop` always works - including while waiting on the prompt.
  let resolveStopped!: (at: { date: Date; monoNs: bigint }) => void;
  const stopped = new Promise<{ date: Date; monoNs: bigint }>((resolveP) => {
    resolveStopped = resolveP;
  });
  let stopRequested = false;
  let maxTimer: NodeJS.Timeout | undefined;
  const onStop = (): void => {
    if (stopRequested) return;
    stopRequested = true;
    const monoNs = process.hrtime.bigint();
    resolveStopped({ date: new Date(), monoNs });
  };
  process.on("SIGINT", onStop);
  process.on("SIGTERM", onStop);
  try {
    await writePidFile(stateDirPath, takeDir, startedAt.toISOString());
  } catch (error) {
    process.off("SIGINT", onStop);
    process.off("SIGTERM", onStop);
    await rm(takeDir, { recursive: true, force: true });
    throw error;
  }
  try {
    if (stopRequested) throw new RecordError("capture-stopped", "recording stopped during setup", "run `takeone record` again");
    const tapStartedAt = new Date();
    const t0ns = process.hrtime.bigint();
    // Armed at take start so the finished take is never longer than asked.
    if (options.maxSeconds !== undefined) {
      maxTimer = setTimeout(onStop, options.maxSeconds * 1000);
      maxTimer.unref?.();
    }
    if (tapsEnabled) {
      taps = await startTaps({
        eventsPath: join(takeDir, "events.jsonl"),
        t0ns,
        // An X11 source is always cursor-free and always asked for hidden, so
        // the engine owns the pointer track there whatever the policy says.
        externalPointer: cursorPolicy !== "embedded" || (options.source ?? { kind: "portal" }).kind === "x11",
      });
    }
    if (stopRequested) throw new RecordError("capture-stopped", "recording stopped during setup", "run `takeone record` again");
    let mapping: { monitor: MonitorInfo; scale: number } | null = null;
    let monitorRecord: unknown = null;
    capture = await startCapture({
      engine,
      takeDir,
      stateDir: stateDirPath,
      fps,
      bitrateKbps,
      source: options.source ?? { kind: "portal" },
      cursor: cursorPolicy,
      onCursor: (sample) => {
        taps?.enginePointer(sample.x, sample.y, sample.visible, sample.hotspot);
      },
      savedToken: async () => {
        if (stopRequested) throw new RecordError("capture-stopped", "recording stopped during setup", "run `takeone record` again");
        const token = await consumeToken(stateDirPath, () => stopRequested);
        if (stopRequested) throw new RecordError("capture-stopped", "recording stopped during setup", "run `takeone record` again");
        return token;
      },
      interrupted: stopped,
      onConsent: async () => {
        consentGranted = true;
        // `none` still leaves an (empty) events file so takes keep one shape.
        if (taps !== null) await taps.confirmConsent();
        else await writeFile(join(takeDir, "events.jsonl"), "", { mode: 0o600 });
      },
      // `none` never touches Hyprland at all: no mapping, no pointer polls.
      onGeometry: tapsEnabled
        ? async (geometry) => {
            const hypr = hyprlandSockets();
            if (hypr !== null) {
              try {
                mapping = pickMonitor(await getMonitors(hypr.socket), geometry);
                monitorRecord = mapping?.monitor ?? null;
              } catch {}
            }
            taps!.setMapping(mapping);
          }
        : undefined,
    });
    if (stopRequested) throw new RecordError("capture-stopped", "recording stopped during setup", "run `takeone record` again");
    // The engine owns the pointer only for a cursor-free session; otherwise
    // Hyprland must supply the track after all. The open reply decides, not the
    // pre-open guess: an X11 `embedded` request comes back cursor-free too.
    if (taps !== null) taps.setExternalPointer(capture.cursor.free);
    try {
      options.onRecording?.(takeDir);
    } catch {
      // a reporting hook must never fail the take
    }
    const stoppedAt = await stopped;
    clearTimeout(maxTimer);

    if (taps !== null) await taps.stop();
    const finalMetrics = await capture.stop();

    const frames = capture.frames();
    const clock = alignClock(frames.map((frame) => ({ ...frame, recvMs: frame.recvMs - Number(t0ns) / 1e6 })));
    const firstFrameMs = clock === null || frames[0] === undefined ? 0 : frames[0].rtpTs / 90 + clock.offsetMs;
    const durationMs = Math.max(0, Number(stoppedAt.monoNs - t0ns) / 1e6);
    const warnings = [...(taps?.warnings ?? [])];
    if (capture.cursor.fallback !== null) {
      warnings.push(capture.cursor.fallback);
      console.error(capture.cursor.fallback);
    }
    const clockWarn = clockWarning(clock);
    if (clockWarn !== null) warnings.push(clockWarn);

    const takeJson: TakeJson = {
      id: takeDir.slice(root.length + 1),
      stream: { w: capture.geometry.encoded.width, h: capture.geometry.encoded.height },
      scale: (mapping as { monitor: MonitorInfo; scale: number } | null)?.scale ?? 1,
      offset_ms: clock?.offsetMs ?? 0,
      started_at: tapStartedAt.toISOString(),
      stopped_at: stoppedAt.date.toISOString(),
      fps,
      bitrate_kbps: bitrateKbps,
      geometry: capture.geometry,
      monitor: monitorRecord,
      pointer: taps?.pointerMode ?? "none",
      events: taps?.eventsMode ?? "none",
      cursor_free: capture.cursor.free,
      warnings,
      clock,
      trim: computeTrim(taps === null ? { inputMs: [] } : taps.summary, durationMs, firstFrameMs),
      auto_trim: true,
      duration_ms: durationMs,
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
  } catch (error) {
    discardTake = !consentGranted && (stopRequested || (error instanceof RecordError &&
      (error.code === "consent-cancelled" || error.code === "consent-timeout")));
    throw error;
  } finally {
    try {
      clearTimeout(maxTimer);
      if (taps !== null) await taps.stop().catch(() => undefined);
      if (capture !== null) await capture.stop().catch(() => undefined);
      if (discardTake) await rm(takeDir, { recursive: true, force: true });
    } finally {
      await rm(join(stateDirPath, "recording.pid"), { force: true }).catch(() => undefined);
      process.off("SIGINT", onStop);
      process.off("SIGTERM", onStop);
    }
  }
}

/**
 * Auto-trim bounds (design section 5 step 6). The start is the first input
 * event (click/key/wheel; pointer moves are not actions) that lands more than
 * 1 s after the first video frame, minus 0.5 s. Consent clicks happen before
 * any frame, so they never anchor the trim; the terminal that started the
 * recording is cut instead.
 */
export function computeTrim(
  summary: { inputMs: number[] },
  durationMs: number,
  firstFrameMs = 0,
): { start: number; end: number } {
  const first = summary.inputMs.find((t) => t > firstFrameMs + 1000);
  return { start: first === undefined ? 0 : Math.max(0, first - 500), end: durationMs };
}
