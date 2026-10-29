/**
 * Webcam capture for `takeone record --webcam`: one ffmpeg child reads a V4L2 camera into the take
 * directory while the screen is recorded, and reports when its first frame arrived on the event
 * clock so the renderer can line the face up with the screen.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { WebcamClip } from "./camera/types.ts";

/** A structured failure in the shape `takeone record` prints: a code, a message and a hint. */
export class WebcamError extends Error {
  readonly code: string;
  readonly hint: string;
  constructor(code: string, message: string, hint: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

export const WEBCAM_FILE = "webcam.mkv";

/** V4L2 nodes, lowest first. A camera registers two (video and metadata); the first one that opens is the picture. */
export function webcamDevices(dev = "/dev"): string[] {
  try {
    return readdirSync(dev).filter((name) => /^video\d+$/.test(name))
      .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5))).map((name) => join(dev, name));
  } catch {
    return [];
  }
}

/** The camera to record: the one asked for, else the first V4L2 node. Throws before any screen-share prompt. */
export function pickWebcam(requested: string | undefined, devices = webcamDevices()): string {
  if (requested !== undefined) {
    if (!existsSync(requested)) throw new WebcamError("webcam-missing", `no camera at ${requested}`, "run `takeone record --webcam` to use the first camera, or pass a /dev/videoN that exists");
    return requested;
  }
  const first = devices[0];
  if (first === undefined) throw new WebcamError("webcam-missing", "no camera found (no /dev/video* device)", "plug in a camera, or record without --webcam");
  return first;
}

/** ffmpeg input arguments for one camera; the first try asks for 720p, the retry takes the camera's own size. */
export function v4l2Input(device: string, size: string | null): string[] {
  return ["-f", "v4l2", "-framerate", "30", ...(size ? ["-video_size", size] : []), "-i", device];
}

export interface WebcamCapture {
  /** Finish the file and return the clip entry for take.json. */
  stop(): Promise<WebcamClip>;
}

/**
 * Start recording `input` (default: the camera) into `<takeDir>/webcam.mkv` and resolve once its first
 * frame is encoded. `clockMs` reads the event clock (ms since take start), which stamps that frame.
 */
export async function startWebcam(options: { takeDir: string; device: string; clockMs: () => number; input?: string[][] }): Promise<WebcamCapture> {
  const { takeDir, device, clockMs } = options;
  const attempts = options.input ?? [v4l2Input(device, "1280x720"), v4l2Input(device, null)];
  const file = join(takeDir, WEBCAM_FILE);
  let failure = "";
  for (const input of attempts) {
    const child = spawn("ffmpeg", ["-nostdin", "-v", "error", "-y", ...input, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20",
      "-pix_fmt", "yuv420p", "-progress", "pipe:1", "-stats_period", "0.1", "-f", "matroska", file], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
    child.on("error", (error) => { stderr += String(error); });
    // The progress line arrives within one stats period of the frame, so the frame is stamped that much earlier.
    const first = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 10_000);
      let buffer = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        buffer += chunk;
        if (/^frame=[1-9]/m.test(buffer)) { clearTimeout(timer); resolve(clockMs() - 100); }
        buffer = buffer.slice(-200);
      });
      void closed.then(() => { clearTimeout(timer); resolve(null); });
    });
    if (first !== null) {
      return {
        async stop() {
          child.kill("SIGINT");
          await closed;
          return { file: WEBCAM_FILE, start_ms: first, device };
        },
      };
    }
    child.kill("SIGKILL");
    await closed;
    failure = stderr.trim().split("\n").slice(-3).join(" | ");
  }
  throw new WebcamError("webcam-failed", `the camera ${device} produced no frames${failure ? `: ${failure}` : ""}`, "close any other app using the camera, or record without --webcam");
}
