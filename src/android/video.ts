/**
 * Android video capture via the vendored scrcpy-server v4.0 jar.
 *
 * The server streams raw H.264 NAL units with per-frame PTS over an adb
 * forward. Unlike a plain Annex-B pipe (which loses timing), this module
 * keeps each frame's PTS in a Matroska transport so the muxed MP4
 * carries real frame timing from 0 — the same real-time alignment the
 * take directory needs for `screen.webm`.
 *
 * Direct run: `node src/android/video.ts <serial> <seconds> <out.webm>`
 */
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { connect, createServer, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AndroidVideoMux } from "./mux.ts";

export const SCRCPY_SERVER_VERSION = "4.0";
const SCRCPY_JAR = "scrcpy-server-v4.0";
const DEVICE_PATH = "/data/local/tmp/takeone-scrcpy-server.jar";
const VIDEO_BIT_RATE = 8_000_000;
const MAX_FPS = 60;
const PTS_MASK = (1n << 61n) - 1n;
const PACKET_FLAG_CONFIG = 1n << 62n;
const PACKET_FLAG_KEY_FRAME = 1n << 61n;
export const SCRCPY_CODEC_H264 = 0x68323634;

/** One parsed video-socket frame: a new size, or one media payload with PTS. */
export type ScrcpyVideoEvent =
  | { type: "size"; width: number; height: number }
  | { type: "media"; config: boolean; keyframe: boolean; pts: bigint; payload: Buffer };

const DEVICE_NAME_BYTES = 64;

/**
 * Video-socket bytes → sizes and timestamped payloads (v4.0 `Streamer`).
 * Layout: one dummy byte, 64 bytes of device name, a u32 codec id, then
 * 12-byte headers — a session packet (top bit set: flags, width, height)
 * or a media packet (pts-and-flags u64, size u32, payload). The PTS is the
 * low 61 bits of pts-and-flags, in microseconds — kept, not discarded.
 */
export class ScrcpyVideoParser {
  private buffer = Buffer.alloc(0);
  private preamble = 1 + DEVICE_NAME_BYTES + 4;

  push(chunk: Buffer): ScrcpyVideoEvent[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const events: ScrcpyVideoEvent[] = [];
    for (;;) {
      if (this.preamble > 0) {
        if (this.buffer.length < this.preamble) return events;
        const codec = this.buffer.readUInt32BE(this.preamble - 4);
        if (codec !== SCRCPY_CODEC_H264) {
          throw new Error(`unsupported scrcpy video codec 0x${codec.toString(16)}`);
        }
        this.buffer = this.buffer.subarray(this.preamble);
        this.preamble = 0;
        continue;
      }
      if (this.buffer.length < 12) return events;
      if ((this.buffer.readUInt32BE(0) & 0x80000000) !== 0) {
        events.push({
          type: "size",
          width: this.buffer.readUInt32BE(4),
          height: this.buffer.readUInt32BE(8),
        });
        this.buffer = this.buffer.subarray(12);
        continue;
      }
      const ptsAndFlags = this.buffer.readBigUInt64BE(0);
      const size = this.buffer.readUInt32BE(8);
      if (size === 0 || size > 8 * 1024 * 1024) throw new Error(`bad scrcpy media size ${size}`);
      if (this.buffer.length < 12 + size) return events;
      events.push({
        type: "media",
        config: (ptsAndFlags & PACKET_FLAG_CONFIG) !== 0n,
        keyframe: (ptsAndFlags & PACKET_FLAG_KEY_FRAME) !== 0n,
        pts: ptsAndFlags & PTS_MASK,
        payload: this.buffer.subarray(12, 12 + size),
      });
      this.buffer = this.buffer.subarray(12 + size);
    }
  }
}

/** The Annex-B start code each payload needs before ffmpeg reads it. */
const ANNEX_B = Buffer.from([0, 0, 0, 1]);

/** One media payload → one Annex-B access unit (config units stay ahead of their IDR).
 *
 * Some encoders emit payloads pre-framed with start codes, others emit raw
 * NALUs; a second prefix corrupts the stream (ffmpeg then fails to split
 * NAL units), so the prefix goes on only when no start code is present. */
export function toAccessUnit(payload: Buffer): Buffer {
  if (
    payload.length >= 4 &&
    payload[0] === 0 &&
    payload[1] === 0 &&
    ((payload[2] === 0 && payload[3] === 1) || payload[2] === 1)
  ) {
    return payload;
  }
  return Buffer.concat([ANNEX_B, payload]);
}

function verifiedJar(jar: string): string | undefined {
  const hashFile = `${jar}.sha256`;
  if (!existsSync(jar) || !existsSync(hashFile)) return undefined;
  const expected = readFileSync(hashFile, "utf8").split(/\s+/)[0]?.trim();
  const actual = createHash("sha256").update(readFileSync(jar)).digest("hex");
  if (!expected || actual !== expected) {
    throw new Error("the vendored scrcpy server failed its pinned hash check");
  }
  return jar;
}

/** The vendored jar, hash-verified. Throws when missing or mismatched. */
export function resolveJar(start = dirname(fileURLToPath(import.meta.url))): string {
  let dir = start;
  for (let depth = 0; depth < 8; depth += 1) {
    const verified = verifiedJar(join(dir, "resources", "scrcpy", SCRCPY_JAR));
    if (verified !== undefined) return verified;
    // src/android/video.ts and dist/android/video.js both sit two levels under the root.
    const rootCandidate = verifiedJar(join(dir, "..", "..", "resources", "scrcpy", SCRCPY_JAR));
    if (rootCandidate !== undefined) return rootCandidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("the vendored scrcpy server is not installed");
}

function runAdb(serial: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((res, rej) => {
    const child = spawn("adb", ["-s", serial, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rej(new Error(`adb ${args[0]} timed out`));
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (err += c.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      rej(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) res(out);
      else rej(new Error(`adb ${args.join(" ")} failed (${code}): ${err.trim().slice(0, 300)}`));
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const server = createServer();
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? res(port) : rej(new Error("no free port"))));
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait until the server listens on its abstract socket (else the first connect hits a dead end). */
async function waitForAbstractSocket(serial: string, scid: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const unix = await runAdb(serial, ["shell", "cat", "/proc/net/unix"], 10_000).catch(() => "");
    if (unix.includes(`scrcpy_${scid}`)) return;
    if (Date.now() >= deadline) throw new Error("timed out waiting for the scrcpy server socket");
    await sleep(250);
  }
}

async function connectVideo(port: number, timeoutMs: number): Promise<Socket> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const socket: Socket = await new Promise((res) => {
      const s = connect(port, "127.0.0.1");
      s.once("connect", () => res(s));
      s.once("error", () => res(s));
    });
    if (!(socket as { destroyed?: boolean }).destroyed && socket.connecting === false) {
      // The forward accepts TCP before the server listens, so wait for the
      // first video byte — only that proves the server is behind it.
      const first = await new Promise<Buffer | null>((res) => {
        const timer = setTimeout(() => res(null), Math.max(500, deadline - Date.now()));
        socket.once("data", (c: Buffer) => {
          clearTimeout(timer);
          res(c);
        });
        socket.once("error", () => {
          clearTimeout(timer);
          res(null);
        });
      });
      if (first !== null) {
        socket.unshift(first);
        return socket;
      }
      socket.destroy();
    } else {
      socket.destroy();
    }
    if (Date.now() >= deadline) throw new Error("timed out waiting for the scrcpy server");
    await sleep(250);
  }
}

/** Optional controls for an open-ended capture (e.g. `takeone record --android`).
 * `stop` ends the capture at the next 100 ms tick like the deadline does;
 * `onFirstFrame` reports the host wall time (ms) of the first video frame. */
export interface CaptureControls {
  stop?: Promise<void>;
  onFirstFrame?: (wallMs: number) => void;
}

export interface CaptureSummary {
  frames: number;
  width: number;
  height: number;
  sizeChanges: number;
  /** recv−pts transport latency per frame, ms. */
  spreadMs: { min: number; max: number; mean: number };
  logPath: string;
}

/**
 * Capture `seconds` of H.264 from `serial` into `outPath` (an MP4
 * regardless of extension — the take dir names it `screen.webm`).
 * Verifies the jar hash before pushing, and removes the pushed jar and
 * the adb forward afterwards.
 */
export async function captureAndroidVideo(
  serial: string,
  seconds: number,
  outPath: string,
  controls: CaptureControls = {},
): Promise<CaptureSummary> {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new RangeError(`seconds must be positive, got ${seconds}`);
  const jar = resolveJar();
  await runAdb(serial, ["push", jar, DEVICE_PATH]);
  const port = await freePort();
  // Always exactly 8 hex digits starting 1-7: a positive signed 32-bit
  // int (or the server dies in Integer.parseInt) in the server's canonical
  // socket-name form. Shorter scids mismatch `localabstract:scrcpy_<scid>`:
  // the forward then accepts TCP with nobody home and no bytes arrive.
  const scid = Math.floor(0x10000000 + Math.random() * (0x7fffffff - 0x10000000)).toString(16);
  await runAdb(serial, ["forward", `tcp:${port}`, `localabstract:scrcpy_${scid}`]);
  let server: ChildProcess | undefined;
  let ffmpeg: ChildProcess | undefined;
  let socket: Socket | undefined;
  try {
    server = spawn(
      "adb",
      [
        "-s",
        serial,
        "shell",
        `CLASSPATH=${DEVICE_PATH} app_process / com.genymobile.scrcpy.Server ${SCRCPY_SERVER_VERSION}`,
        `tunnel_forward=true scid=${scid} video=true audio=false control=false cleanup=false`,
        `video_bit_rate=${VIDEO_BIT_RATE} max_fps=${MAX_FPS}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let serverLog = "";
    server.stdout?.on("data", (c: Buffer) => (serverLog += c.toString()));
    server.stderr?.on("data", (c: Buffer) => (serverLog += c.toString()));
    const failEarly = new Promise<never>((_, rej) => {
      server?.once("error", rej);
      server?.once("close", (code) =>
        rej(new Error(`scrcpy server exited early (${code}): ${serverLog.trim().slice(0, 300)}`)),
      );
    });
    const withLog = (error: unknown): Error =>
      new Error(`${(error as Error).message}. server said: ${serverLog.trim().slice(0, 300) || "(nothing)"}`);

    // The forward accepts TCP before the server listens, and an early
    // connection meets a dead end (observed: the server aborts and no
    // bytes ever arrive). So wait until the server's abstract socket
    // exists before the first connect.
    try {
      await Promise.race([waitForAbstractSocket(serial, scid, 15_000), failEarly]);
    } catch (error) {
      throw withLog(error);
    }

    let socketOrFail: Socket;
    try {
      socketOrFail = await Promise.race([connectVideo(port, 20_000), failEarly]);
    } catch (error) {
      throw withLog(error);
    }
    socket = socketOrFail;
    server?.removeAllListeners("close");

    ffmpeg = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y", // never prompt: stdin is the video pipe, not a terminal
        "-f",
        "matroska",
        "-i",
        "pipe:0",
        "-c:v",
        "copy",
        "-f",
        "mp4",
        resolve(outPath),
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    let ffmpegErr = "";
    ffmpeg.stderr?.on("data", (c: Buffer) => (ffmpegErr += c.toString()));
    const ffmpegDone = new Promise<void>((res, rej) => {
      ffmpeg?.once("error", rej);
      ffmpeg?.once("close", (code) =>
        code === 0 ? res() : rej(new Error(`ffmpeg exited (${code}): ${ffmpegErr.trim().slice(0, 300)}`)),
      );
    });

    const parser = new ScrcpyVideoParser();
    const mux = new AndroidVideoMux();
    const log: Array<[number, bigint]> = [];
    let width = 0;
    let height = 0;
    let sizeChanges = 0;
    let pts0: bigint | undefined;
    let startWall = 0;
    let deadline = 0;
    let stopping = false;
    const ffmpegDead: Promise<never> = ffmpegDone.then(
      () => {
        throw new Error("ffmpeg exited before the capture finished");
      },
      (error: unknown) => {
        throw error;
      },
    );
    ffmpegDead.catch(() => {
      stopping = true;
    });

    const writeUnit = async (unit: Buffer): Promise<void> => {
      const stdin = ffmpeg?.stdin;
      if (!stdin || stdin.destroyed || stopping) return;
      // A stuck ffmpeg must never stall the capture past its deadline.
      if (!stdin.write(unit)) await Promise.race([new Promise<void>((r) => stdin.once("drain", r)), sleep(5_000)]);
    };

    const onData = async (chunk: Buffer): Promise<void> => {
      for (const event of parser.push(chunk)) {
        if (event.type === "size") {
          width = event.width;
          height = event.height;
          sizeChanges += 1;
          continue;
        }
        const recvMs = Date.now();
        // Config packets (SPS/PPS) carry no display timestamp — the
        // first one usually reads pts=0 while real frames carry
        // uptime-based PTS. Anchoring to one would pace every frame
        // thousands of seconds late, so only real frames set pts0.
        // Config still goes to the muxer first: the IDR needs it.
        if (event.config) {
          mux.configure(event.payload);
          continue;
        }
        if (pts0 === undefined) {
          pts0 = event.pts;
          startWall = recvMs;
          deadline = startWall + seconds * 1000;
        }
        log.push([recvMs, event.pts]);
        if (!stopping) await writeUnit(mux.frame(event.pts, event.keyframe, event.payload, width, height));
      }
    };
    const queue = Promise.resolve();
    let pending = queue;
    let pipelineError: unknown;
    socket.on("data", (chunk: Buffer) => {
      pending = pending.then(() => onData(chunk)).catch((error: unknown) => {
        pipelineError = error;
        stopping = true;
      });
    });
    const socketClosed = new Promise<void>((res) => {
      socket?.once("close", res);
      socket?.once("error", res);
    });

    let stopFired = false;
    controls.stop?.then(
      () => { stopFired = true; },
      () => { stopFired = true; },
    );
    // Wait for the first frame (proves video flows), then run to deadline.
    // Every wait below is bounded: the capture always ends on its own.
    for (let waited = 0; pts0 === undefined; waited += 100) {
      if (pipelineError !== undefined) throw pipelineError;
      if (stopFired) throw new Error("stopped before any video arrived");
      if (waited > 15_000) throw withLog(new Error("no video frames arrived in 15 s"));
      await Promise.race([sleep(100), socketClosed.then(() => { throw new Error("video socket closed before first frame"); }), ffmpegDead]);
    }
    if (pipelineError !== undefined) throw pipelineError;
    controls.onFirstFrame?.(startWall);
    const runEnd = await Promise.race([
      (async (): Promise<"done" | "stopped"> => {
        while (!stopping && Date.now() < deadline) {
          if (stopFired) return "stopped";
          await sleep(100);
        }
        return "done";
      })(),
      socketClosed.then(() => (Date.now() < deadline ? (true as const) : ("done" as const))),
      ffmpegDead,
    ]);
    const elapsedMs = Math.max(0, Date.now() - startWall);
    stopping = true;
    socket?.destroy();
    await Promise.race([pending, sleep(5_000)]);
    if (pipelineError !== undefined) throw pipelineError;
    if (runEnd === true) throw withLog(new Error("video socket closed mid-capture"));
    try {
      ffmpeg?.stdin?.end(mux.finish(elapsedMs));
    } catch {
      /* already gone */
    }
    const ffmpegFinished = await Promise.race([
      ffmpegDone.then(() => true),
      sleep(10_000).then(() => false),
    ]);
    ffmpeg?.kill("SIGKILL");
    if (!ffmpegFinished) {
      throw new Error(`ffmpeg timed out: ${ffmpegErr.trim().slice(0, 300) || "(nothing)"}`);
    }

    if (log.length === 0) throw new Error("captured no frames");
    const offsetsMs = log.map(([recvMs, pts]) => recvMs - (startWall + Number(pts - pts0!) / 1000));
    const min = Math.min(...offsetsMs);
    const max = Math.max(...offsetsMs);
    const mean = offsetsMs.reduce((a, b) => a + b, 0) / offsetsMs.length;
    const logPath = `${resolve(outPath)}.frames.log`;
    writeFileSync(logPath, log.map(([recvMs, pts]) => `${recvMs},${pts}`).join("\n") + "\n");
    return { frames: log.length, width, height, sizeChanges, spreadMs: { min, max, mean }, logPath };
  } finally {
    // Hard teardown: every await above is bounded, and cleanup is too.
    socket?.destroy();
    try {
      ffmpeg?.stdin?.destroy();
    } catch {
      /* already gone */
    }
    ffmpeg?.kill("SIGKILL");
    server?.kill("SIGKILL");
    await runAdb(serial, ["forward", "--remove", `tcp:${port}`], 10_000).catch(() => undefined);
    await runAdb(serial, ["shell", "rm", "-f", DEVICE_PATH], 10_000).catch(() => undefined);
  }
}

function printUsage(): void {
  console.error("usage: video.ts <serial> <seconds> <out.webm>");
}

const invokedAsMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedAsMain) {
  const [serial, secondsRaw, out] = process.argv.slice(2);
  const seconds = Number(secondsRaw);
  if (!serial || !Number.isFinite(seconds) || seconds <= 0 || !out) {
    printUsage();
    process.exit(2);
  }
  try {
    const summary = await captureAndroidVideo(serial, seconds, out);
    const spread = summary.spreadMs;
    console.log(
      `frames=${summary.frames} size=${summary.width}x${summary.height} sizeChanges=${summary.sizeChanges} log=${summary.logPath}\n` +
        `recv-pts spread ms: min=${spread.min.toFixed(1)} max=${spread.max.toFixed(1)} mean=${spread.mean.toFixed(1)}`,
    );
  } catch (error) {
    console.error(`video capture failed: ${(error as Error).message}`);
    process.exit(1);
  }
}
