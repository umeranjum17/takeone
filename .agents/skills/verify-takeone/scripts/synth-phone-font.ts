#!/usr/bin/env node
// Offline large-font phone take: the Tidewater phone board (scripts/e2e/scene.html +
// scripts/e2e/android/mobile.css, as the Android fixture builds it) with every font size
// multiplied by the font scale, which is what Android WebView text zoom does at
// Settings > Font size = largest (font_scale 1.3). Captured at 360x800 CSS px, dsf 3
// (1080x2400) by the pinned headless shell, then encoded as a 10 s take with one tap.
//
//   node .agents/skills/verify-takeone/scripts/synth-phone-font.ts <take-dir> [font-scale=1.3]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { ingest } from "../../../../src/motion/ingest.ts";
import type { Storyboard } from "../../../../src/motion/types.ts";

const [dirArg, scaleArg = "1.3"] = process.argv.slice(2);
const scale = Number(scaleArg);
if (!dirArg || !(scale >= 1 && scale <= 2)) {
  console.error("usage: synth-phone-font.ts <take-dir> [font-scale 1..2, default 1.3]");
  process.exit(2);
}
const dir = resolve(dirArg), repo = resolve(import.meta.dirname, "../../../..");
mkdirSync(join(dir, "page"), { recursive: true });

// Same transform as scripts/e2e/android/build.sh, then text zoom on every px font size.
let page = readFileSync(join(repo, "scripts/e2e/scene.html"), "utf8")
  .replace("<head>", '<head><meta name="viewport" content="width=device-width, initial-scale=1">')
  .replace("</style>", readFileSync(join(repo, "scripts/e2e/android/mobile.css"), "utf8") + "\n</style>")
  .replace('$("title").value = ""', '$("title").value = "Prepare launch brief"')
  .replace('$("notes").value = ""', '$("notes").value = "Share the Tidewater release plan with Umer."')
  .replace('setTimeout(() => $("title").focus(), 50);', "");
for (let n = 0; n < 3; n++) page = page.replace('<section class="abs col"', `<section id="col${n}" class="abs col"`);
page = page.replace(/(font-size:\s*|font:[^;]*?\s)(\d+(?:\.\d+)?)px/g, (_, lead: string, px: string) => `${lead}${+(Number(px) * scale).toFixed(2)}px`);
writeFileSync(join(dir, "page/phone.html"), page);

// Two real states of the page: the board, then the New task sheet the tap opens.
const sb = { source: { kind: "html", file: "page/phone.html", viewport: [360, 800], dsf: 3,
  states: { board: [], sheet: ["click #newTask"] } }, screens: {}, regions: [], crops: {} } as unknown as Storyboard;
await ingest(dir, sb);
const W = 1080, H = 2400, tapAt = 4000;
execFileSync("ffmpeg", ["-nostdin", "-y", "-v", "error",
  "-loop", "1", "-t", "4", "-i", join(dir, "sources/board.png"), "-loop", "1", "-t", "6", "-i", join(dir, "sources/sheet.png"),
  "-filter_complex", `[0:v][1:v]concat=n=2:v=1,fps=30,scale=${W}:${H},format=yuv420p`,
  "-c:v", "libx264", "-threads", "2", "-preset", "veryfast", "-f", "mp4", join(dir, "screen.webm")], { stdio: "inherit" });

// The tap lands on "+ New task" (right:22px top:24px 110x40 CSS px in mobile.css), dsf 3.
const [x, y] = [Math.round((360 - 22 - 55) * 3), Math.round((24 + 20) * 3)];
const events = [{ t: tapAt - 10, k: "ptr", x, y }, { t: tapAt, k: "btn", b: "left", down: true },
  { t: tapAt + 80, k: "btn", b: "left", down: false }, { t: tapAt + 82, k: "ptr-lost" }];
writeFileSync(join(dir, "events.jsonl"), events.map(e => JSON.stringify(e)).join("\n") + "\n");
writeFileSync(join(dir, "frames.tsv"), "0\t0\n");
const id = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(basename(dir)) ? basename(dir) : "phone-font";
writeFileSync(join(dir, "take.json"), JSON.stringify({ id, stream: { w: W, h: H }, scale: 3, pointer: "mapped",
  events: "on", offset_ms: 0, device: "android", title: "Plan the launch",
  captions: [{ t: 4.2, d: 3, text: "Add a task in one tap" }] }, null, 1) + "\n");
console.log(`large-font (x${scale}) phone take written to ${dir}`);
