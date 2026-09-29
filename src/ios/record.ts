/**
 * `takeone record --ios-sim`: record the booted iOS Simulator into a take.
 *
 * macOS only. Video-only: `xcrun simctl io booted recordVideo` writes the
 * file and there is no touch API, so no events.jsonl is written
 * (take.events "none", pointer "none") and the core degrades to change
 * regions and cuts. The desktop record/session/taps path is untouched.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { processStartTicks } from "../takes.ts";

export interface IosSimRecordOptions {
  takesRoot?: string;
  stateDirPath?: string;
  /** Injectable for tests; defaults to process.platform. */
  platform?: NodeJS.Platform;
}

export interface IosTakeJson {
  id: string;
  stream: { w: number; h: number };
  scale: number;
  offset_ms: number;
  pointer: "none";
  events: "none";
}

export interface IosSimRecordResult {
  takeDir: string;
  takeJson: IosTakeJson;
  frames: number;
}

export class IosRecordError extends Error {
  code: string;
  hint: string;
  constructor(code: string, message: string, hint: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

/** True only on macOS; simctl exists nowhere else. */
export function isMacOS(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}

/** Throw the capture-style refusal unless this machine can run simctl. */
export function refuseUnlessMac(platform: NodeJS.Platform = process.platform): void {
  if (!isMacOS(platform)) {
    throw new IosRecordError(
      "unsupported-platform",
      `iOS Simulator recording needs macOS (this machine is ${platform})`,
      "run `takeone record --ios-sim` on a Mac with Xcode installed",
    );
  }
}

/**
 * Udids of booted simulators from `xcrun simctl list devices -j`.
 * Empty when none is booted.
 */
export function parseBootedDevices(json: string): string[] {
  let parsed: { devices?: Record<string, Array<{ udid?: unknown; state?: unknown }>> };
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const group of Object.values(parsed.devices ?? {})) {
    for (const d of group ?? []) {
      if (typeof d.udid === "string" && d.state === "Booted") out.push(d.udid);
    }
  }
  return out;
}

/**
 * offset_ms from the recorder's start line: ms between spawn and the first
 * output line (simctl announces the recording), to one decimal. Zero when
 * the recorder never prints, so the event clock starts at the first frame.
 */
export function offsetMsFromStartLine(spawnWallMs: number, startLineWallMs: number | null): number {
  if (startLineWallMs === null) return 0;
  return Math.round((startLineWallMs - spawnWallMs) * 10) / 10;
}

/** Stream size in device pixels, read back from the recorded file. */
export function probeVideoSize(file: string): { w: number; h: number } {
  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file],
    { encoding: "utf8" },
  );
  const m = /(\d+),(\d+)/.exec(probe.stdout ?? "");
  const w = Number(m?.[1]);
  const h = Number(m?.[2]);
  if (probe.status !== 0 || !Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w <= 0 || h <= 0) {
    throw new IosRecordError(
      "unreadable-video",
      `cannot read video size from ${file}`,
      "the simctl recording may have been stopped before it wrote a frame",
    );
  }
  return { w, h };
}

/** Frame count of the recorded file (VFR, so duration alone says nothing). */
export function probeFrameCount(file: string): number {
  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file],
    { encoding: "utf8" },
  );
  const n = Number((probe.stdout ?? "").trim());
  return probe.status === 0 && Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function takeId(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Write take.json + frames.tsv for a recorded video file. No events.jsonl:
 * there is no touch API on the Simulator, so the core works from change
 * regions and cuts.
 */
export async function writeIosTake(
  takeDir: string,
  videoFile: string,
  offsetMs: number,
): Promise<{ takeJson: IosTakeJson; frames: number }> {
  const stream = probeVideoSize(videoFile);
  const takeJson: IosTakeJson = {
    id: basename(takeDir),
    stream,
    // ponytail: fixed 2x; the true point ratio is unknowable because simctl
    // records the host window's pixels, and with no mapped input scale only
    // sizes change-region padding.
    scale: 2,
    offset_ms: offsetMs,
    pointer: "none",
    events: "none",
  };
  await writeFile(join(takeDir, "take.json"), `${JSON.stringify(takeJson, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(takeDir, "frames.tsv"), "0\t0\n", { mode: 0o600 });
  return { takeJson, frames: probeFrameCount(videoFile) };
}

function runXcrun(args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    const child = spawn("xcrun", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (err += c.toString()));
    child.on("error", (e) =>
      rej(
        new IosRecordError(
          "missing-tool",
          `xcrun would not start: ${e.message}`,
          "install Xcode with the iOS Simulator on this Mac",
        ),
      ),
    );
    child.on("close", (code) => {
      if (code === 0) res(out);
      else {
        rej(
          new IosRecordError(
            "simctl-failed",
            `xcrun ${args.join(" ")} failed (${code}): ${err.trim().slice(0, 200)}`,
            "check that a simulator is booted (`xcrun simctl list devices booted`)",
          ),
        );
      }
    });
  });
}

/** 12 h: the stop signal, not the deadline, ends an interactive recording. */
const MAX_SECONDS = 12 * 3600;

export async function runIosSimRecord(options: IosSimRecordOptions = {}): Promise<IosSimRecordResult> {
  refuseUnlessMac(options.platform);
  const root = options.takesRoot !== undefined ? resolve(options.takesRoot) : defaultTakesRoot();
  const stateDirPath =
    options.stateDirPath !== undefined ? resolve(options.stateDirPath) : defaultStateDir();

  const booted = parseBootedDevices(await runXcrun(["simctl", "list", "devices", "-j"]));
  if (booted.length === 0) {
    throw new IosRecordError(
      "no-simulator",
      "no booted simulator (xcrun simctl shows none)",
      "boot one with `xcrun simctl boot <device>` or open the Simulator app",
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

    // Record to a temp .mov (simctl picks the container from the extension),
    // then rename to screen.webm: the core sniffs the codec, not the name,
    // and an H.264 MP4 under that name decodes fine.
    const raw = join(tmpdir(), `takeone-ios-${id}.mov`);
    const t0 = Date.now();
    let startLineWall: number | null = null;
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
      const rec = spawn("xcrun", ["simctl", "io", "booted", "recordVideo", "--codec=h264", raw], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const onOutput = (): void => {
        if (startLineWall === null) startLineWall = Date.now();
      };
      rec.stdout?.on("data", onOutput);
      rec.stderr?.on("data", onOutput);
      let recErr = "";
      rec.stderr?.on("data", (c: Buffer) => (recErr += c.toString()));
      // SIGINT is the documented stop: simctl finalizes the file, so any
      // exit after the stop signal is a clean stop. An exit before it is a
      // real failure.
      let stopping = false;
      const recDone = new Promise<void>((res, rej) => {
        rec.once("error", (e: Error) =>
          rej(
            new IosRecordError(
              "missing-tool",
              `simctl recordVideo would not start: ${e.message}`,
              "install Xcode with the iOS Simulator on this Mac",
            ),
          ),
        );
        rec.once("close", (code) => {
          if (stopping || code === 0) res();
          else {
            rej(
              new IosRecordError(
                "simctl-failed",
                `simctl recordVideo exited early (${code}): ${recErr.trim().slice(0, 200)}`,
                "check that a simulator is booted (`xcrun simctl list devices booted`)",
              ),
            );
          }
        });
      });
      const deadline = setTimeout(() => stopResolve(), MAX_SECONDS * 1000);
      try {
        await Promise.race([
          recDone,
          stop.then(() => {
            stopping = true;
            rec.kill("SIGINT");
            return recDone;
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
      const offsetMs = offsetMsFromStartLine(t0, startLineWall);
      await rename(raw, join(takeDir, "screen.webm")).catch(async () => {
        // SIGINT arrived before simctl wrote anything: fail loudly instead
        // of shipping an empty take.
        throw new IosRecordError(
          "unreadable-video",
          "simctl wrote no video file",
          "record for at least a few seconds before stopping",
        );
      });
      const { takeJson, frames } = await writeIosTake(takeDir, join(takeDir, "screen.webm"), offsetMs);
      wroteFiles = true;
      return { takeDir, takeJson, frames };
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
    throw new IosRecordError("pid-unavailable", "cannot read process start time", "check /proc is mounted");
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
    throw new IosRecordError(
      "already-recording",
      "another recorder owns the PID marker",
      "run `takeone stop` before recording again",
    );
  }
}
