/**
 * `takeone record --android <serial>`: record a phone or emulator into a take.
 *
 * One more producer of the take directory (`take.json`, `screen.webm`,
 * `frames.tsv`, `events.jsonl`); the desktop record/session/taps path is
 * untouched. Demos are hand-driven: video comes from the vendored
 * scrcpy-server (real PTS, host-stamped) and touches from `getevent -lt`
 * (arrival-stamped on the host clock), so no device clock is ever compared.
 */

import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { processStartTicks } from "../takes.ts";
import { touchEvents } from "./touch.ts";
import { captureAndroidVideo } from "./video.ts";

export interface AndroidRecordOptions {
  serial: string;
  /** Calibration knob: added to every touch timestamp (ms). */
  touchOffsetMs?: number;
  takesRoot?: string;
  stateDirPath?: string;
}

export interface AndroidTakeJson {
  id: string;
  stream: { w: number; h: number };
  scale: number;
  offset_ms: number;
  pointer: "mapped";
  events: "on";
}

export interface AndroidRecordResult {
  takeDir: string;
  takeJson: AndroidTakeJson;
  frames: number;
  events: number;
}

export class AndroidRecordError extends Error {
  code: string;
  hint: string;
  constructor(code: string, message: string, hint: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

/** Touch axis maxima from one `getevent -lp` dump. */
export interface TouchAxes {
  axisMaxX: number;
  axisMaxY: number;
}

/**
 * Pick the touch axes from `adb shell getevent -lp`: the device with
 * INPUT_PROP_DIRECT wins, else every device with ABS_MT_POSITION_X merges
 * (the emulator case) and the widest range wins. Null when no touch device.
 */
export function parseTouchDevices(lp: string): TouchAxes | null {
  const blocks = lp.split(/^add device \d+:.*$/m).slice(1);
  const found: Array<{ direct: boolean; maxX: number; maxY: number }> = [];
  for (const block of blocks) {
    const props = block.split("input props:")[1] ?? "";
    const maxX = block.match(/ABS_MT_POSITION_X\s*:[^\n]*max\s+(\d+)/);
    const maxY = block.match(/ABS_MT_POSITION_Y\s*:[^\n]*max\s+(\d+)/);
    if (!maxX || !maxY) continue;
    found.push({
      direct: props.includes("INPUT_PROP_DIRECT"),
      maxX: Number(maxX[1]),
      maxY: Number(maxY[1]),
    });
  }
  if (found.length === 0) return null;
  const direct = found.find((d) => d.direct);
  if (direct) return { axisMaxX: direct.maxX, axisMaxY: direct.maxY };
  return {
    axisMaxX: Math.max(...found.map((d) => d.maxX)),
    axisMaxY: Math.max(...found.map((d) => d.maxY)),
  };
}

/** Effective size: `Override size` wins over `Physical size`. */
export function parseWmSize(out: string): { w: number; h: number } | null {
  const over = out.match(/Override size:\s*(\d+)x(\d+)/);
  const m = over ?? out.match(/(\d+)x(\d+)/);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return Number.isSafeInteger(w) && Number.isSafeInteger(h) && w > 0 && h > 0
    ? { w, h }
    : null;
}

/** Effective density: `Override density` wins over `Physical density`. */
export function parseWmDensity(out: string): number | null {
  const over = out.match(/Override density:\s*(\d+)/);
  const phys = out.match(/Physical density:\s*(\d+)/);
  const n = Number((over ?? phys)?.[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function runAdb(serial: string, args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    const child = spawn("adb", ["-s", serial, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (err += c.toString()));
    child.on("error", (e) =>
      rej(new AndroidRecordError("adb-failed", `adb not runnable: ${e.message}`, "install platform-tools and retry")),
    );
    child.on("close", (code) => {
      if (code === 0) res(out);
      else {
        rej(
          new AndroidRecordError(
            "adb-failed",
            `adb ${args.join(" ")} failed (${code}): ${err.trim().slice(0, 200)}`,
            `check that device ${serial} is attached (adb devices)`,
          ),
        );
      }
    });
  });
}

function takeId(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** The scrcpy encoder may stream below display size; mapping uses the stream. */
function androidScale(density: number, displayW: number, streamW: number): number {
  return Math.round(((density / 160) * (streamW / displayW)) * 1e4) / 1e4;
}

/** 12 h: the stop signal, not the deadline, ends an interactive recording. */
const MAX_SECONDS = 12 * 3600;
/** Wheel tail so a fling reads as one scroll; must stay under 500 ms. */
const FLING_TAIL_MS = 300;

export async function runAndroidRecord(options: AndroidRecordOptions): Promise<AndroidRecordResult> {
  const serial = options.serial;
  if (!serial) {
    throw new AndroidRecordError(
      "invalid-arguments",
      "record --android needs a device serial",
      "pick one from `adb devices`",
    );
  }
  const touchOffsetMs = options.touchOffsetMs ?? 0;
  if (!Number.isSafeInteger(touchOffsetMs)) {
    throw new AndroidRecordError(
      "invalid-arguments",
      "--touch-offset-ms must be an integer",
      "run `takeone --help`",
    );
  }
  const root = options.takesRoot !== undefined ? resolve(options.takesRoot) : defaultTakesRoot();
  const stateDirPath =
    options.stateDirPath !== undefined ? resolve(options.stateDirPath) : defaultStateDir();

  const [lp, sizeOut, densityOut] = await Promise.all([
    runAdb(serial, ["shell", "getevent", "-lp"]),
    runAdb(serial, ["shell", "wm", "size"]),
    runAdb(serial, ["shell", "wm", "density"]),
  ]);
  const axes = parseTouchDevices(lp);
  if (!axes) {
    throw new AndroidRecordError(
      "no-touch-device",
      "no touch device reported by getevent -lp",
      "the device must expose ABS_MT_POSITION_X",
    );
  }
  const display = parseWmSize(sizeOut);
  if (!display) {
    throw new AndroidRecordError(
      "adb-failed",
      `cannot parse wm size: ${sizeOut.trim().slice(0, 100)}`,
      `check that device ${serial} is attached`,
    );
  }
  const density = parseWmDensity(densityOut);
  if (density === null) {
    throw new AndroidRecordError(
      "adb-failed",
      `cannot parse wm density: ${densityOut.trim().slice(0, 100)}`,
      `check that device ${serial} is attached`,
    );
  }

  await mkdir(root, { recursive: true });
  const startedAt = new Date();
  const id = takeId(startedAt);
  let takeDir = join(root, id);
  for (let suffix = 1; ; suffix++) {
    try {
      await mkdir(takeDir, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      takeDir = join(root, `${id}-${suffix}`);
    }
  }
  let wroteFiles = false;
  try {
    await writePidFile(stateDirPath, takeDir, startedAt);

    const t0 = Date.now();
    let stopResolve!: () => void;
    const stop = new Promise<void>((r) => {
      stopResolve = r;
    });
    const onSignal = (): void => {
      stopResolve();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    try {
      const getevent = spawn("adb", ["-s", serial, "shell", "getevent", "-lt"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let touchLog = "";
      let pending = "";
      let firstTouchArrival = 0;
      getevent.stdout?.on("data", (chunk: Buffer) => {
        // Stamp the arrival of the first real event line: getevent prints
        // non-event chatter (device list) before the first touch arrives,
        // and stamping that would shift every touch to take start.
        pending += chunk.toString();
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          touchLog += `${line}\n`;
          if (!firstTouchArrival && /^\[\s*\d+\.\d+\]/.test(line)) firstTouchArrival = Date.now();
        }
      });
      const geteventDone = new Promise<never>((_, rej) => {
        getevent.once("error", (e: Error) =>
          rej(
            new AndroidRecordError(
              "adb-failed",
              `getevent would not start: ${e.message}`,
              `check that device ${serial} is attached`,
            ),
          ),
        );
        getevent.once("close", (code) =>
          rej(
            new AndroidRecordError(
              "adb-failed",
              `getevent exited early (${code})`,
              `check that device ${serial} is still attached`,
            ),
          ),
        );
      });
      // The stop signal (Ctrl-C, SIGTERM, `takeone stop`) ends the capture;
      // a dying getevent aborts it, because touches would be lost silently.
      let firstFrameWall = 0;
      const capture = captureAndroidVideo(serial, MAX_SECONDS, join(takeDir, "screen.webm"), {
        stop,
        onFirstFrame: (wallMs) => {
          firstFrameWall = wallMs;
        },
      });
      let summary;
      try {
        summary = await Promise.race([capture, geteventDone]);
        touchLog += pending;
      } catch (error) {
        stopResolve();
        await capture.catch(() => undefined);
        if (error instanceof AndroidRecordError) throw error;
        throw new AndroidRecordError(
          "adb-failed",
          `android capture failed: ${(error as Error).message}`,
          `check that device ${serial} is attached (adb devices)`,
        );
      } finally {
        getevent.kill("SIGKILL");
      }

      const raw = touchEvents(touchLog.split("\n"), {
        axisMaxX: axes.axisMaxX,
        axisMaxY: axes.axisMaxY,
        W: summary.width,
        H: summary.height,
        flingTailMs: FLING_TAIL_MS,
      });
      const shift = (firstTouchArrival || firstFrameWall || t0) - t0 + touchOffsetMs;
      const events = raw
        .map((e) => ({ ...e, t: Math.max(0, Math.round(e.t + shift)) }))
        .sort((a, b) => a.t - b.t);
      const takeJson: AndroidTakeJson = {
        id: basename(takeDir),
        stream: { w: summary.width, h: summary.height },
        scale: androidScale(density, display.w, summary.width),
        offset_ms: Math.round((firstFrameWall - t0 + summary.spreadMs.min) * 10) / 10,
        pointer: "mapped",
        events: "on",
      };
      await writeFile(join(takeDir, "take.json"), `${JSON.stringify(takeJson, null, 2)}\n`, {
        mode: 0o600,
      });
      await writeFile(join(takeDir, "frames.tsv"), "0\t0\n", { mode: 0o600 });
      await writeFile(join(takeDir, "events.jsonl"), events.length > 0 ? `${events.map((e) => JSON.stringify(e)).join("\n")}\n` : "", {
        mode: 0o600,
      });
      wroteFiles = true;
      return { takeDir, takeJson, frames: summary.frames, events: events.length };
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      await rm(join(stateDirPath, "recording.pid"), { force: true });
    }
  } finally {
    if (!wroteFiles) await rm(takeDir, { recursive: true, force: true });
  }
}

function defaultTakesRoot(): string {
  return process.env["TAKEONE_DIR"] ?? join(homedir(), "Videos", "takeone");
}

function defaultStateDir(): string {
  return process.env["TAKEONE_STATE_DIR"] ?? join(homedir(), ".local", "state", "takeone");
}

async function writePidFile(stateDirPath: string, takeDir: string, startedAt: Date): Promise<void> {
  await mkdir(stateDirPath, { recursive: true, mode: 0o700 });
  const startTicks = processStartTicks(process.pid);
  if (startTicks === null) {
    throw new AndroidRecordError(
      "pid-unavailable",
      "cannot read process start time",
      "check /proc is mounted",
    );
  }
  const payload = JSON.stringify({
    pid: process.pid,
    start_ticks: startTicks,
    take: takeDir,
    started_at: startedAt.toISOString(),
  });
  try {
    await writeFile(join(stateDirPath, "recording.pid"), payload, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new AndroidRecordError(
      "already-recording",
      "another recorder owns the PID marker",
      "run `takeone stop` before recording again",
    );
  }
}
