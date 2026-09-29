#!/usr/bin/env node
// Generate a synthetic portrait (phone-shaped) take: a 1080x2400 testsrc2
// H.264 MP4 named screen.webm, plus take.json, frames.tsv and an events.jsonl
// with 3 taps and 1 swipe emitted per the touch -> Event mapping (tap = ptr,
// btn down/up, ptr-lost >=1 ms after up; swipe = ptr, wheel tail, ptr-lost).
//
//   node scripts/synth-portrait.ts <output-dir>

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const W = 1080;
const H = 2400;
const DUR = 10;

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/synth-portrait.ts <output-dir>");
  process.exit(2);
}
mkdirSync(dir, { recursive: true });

const rawId = basename(dir);
const id = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(rawId) ? rawId : "portrait-demo";

writeFileSync(join(dir, "take.json"), JSON.stringify({
  id,
  stream: { w: W, h: H },
  scale: 3,
  pointer: "mapped",
  events: "on",
  offset_ms: 0,
}, null, 1) + "\n");
writeFileSync(join(dir, "frames.tsv"), "0\t0\n");

type E = Record<string, unknown>;
const evts: E[] = [];
const ptr = (t: number, x: number, y: number): void => {
  evts.push({ t, k: "ptr", x, y });
};
const btn = (t: number, down: boolean): void => {
  evts.push({ t, k: "btn", b: "left", down });
};
const lost = (t: number): void => {
  evts.push({ t, k: "ptr-lost" });
};
const wheel = (t: number, dy: number): void => {
  evts.push({ t, k: "wheel", dx: 0, dy });
};

/** Tap: ptr -> down -> up -> ptr-lost 2 ms after up. */
function tap(x: number, y: number, downT: number): void {
  ptr(downT - 10, x, y);
  btn(downT, true);
  btn(downT + 80, false);
  lost(downT + 82);
}

tap(300, 600, 1000);
tap(780, 1200, 3000);
tap(540, 2000, 5000);

// Swipe: ptr, then a wheel tail spaced 100 ms (< 500 ms), then ptr-lost.
ptr(6990, 540, 1800);
for (let t = 7100; t <= 7600; t += 100) wheel(t, 120);
lost(7602);

evts.sort((a, b) => (a["t"] as number) - (b["t"] as number));
writeFileSync(join(dir, "events.jsonl"), evts.map((e) => JSON.stringify(e)).join("\n") + "\n");

console.log("encoding screen.webm ...");
execFileSync("ffmpeg", [
  "-y", "-v", "error",
  "-f", "lavfi", "-i", `testsrc2=s=${W}x${H}:d=${DUR}`,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "mp4",
  join(dir, "screen.webm"),
], { stdio: ["ignore", "ignore", "inherit"] });
console.log(`portrait take written to ${dir}`);
