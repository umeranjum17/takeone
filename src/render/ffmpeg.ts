import { spawn } from "node:child_process";

/** Run ffmpeg, resolve with its stderr, and include its final 20 stderr lines on failure. */
export function runFfmpeg(args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const process = spawn("ffmpeg", ["-nostdin", ...args], { stdio: ["ignore", "ignore", "pipe"], signal });
    let stderr = "";
    process.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-100_000);
    });
    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) {
        resolve(stderr);
        return;
      }
      const lastLines = stderr.split("\n").slice(-20).join("\n");
      reject(new Error(`ffmpeg exited ${code}\n${lastLines}`));
    });
  });
}
