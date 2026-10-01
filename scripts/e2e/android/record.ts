#!/usr/bin/env node
// Real emulator proof: kernel touches drive the installed offline Tidewater app.
// Video and events come from the ordinary Android recorder, never from a synth.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runAndroidRecord } from "../../../src/android/record.ts";

const [serial, rootArg] = process.argv.slice(2);
if (!serial?.startsWith("emulator-") || !rootArg) throw new Error("usage: node scripts/e2e/android/record.ts emulator-PORT <output-root>");
const root = resolve(rootArg);
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8" });
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
if (!adb("shell", "id").includes("uid=0")) throw new Error("the test emulator needs adb root for kernel touch injection");
const size = adb("shell", "wm", "size").match(/(\d+)x(\d+)/)!;
const W = Number(size[1]), H = Number(size[2]);
if (W !== 1080 || H !== 2400 || !adb("shell", "wm", "density").includes("420")) throw new Error("the Tidewater proof requires a 1080x2400, density-420 test emulator");
const dump = adb("shell", "getevent", "-lp");
const block = dump.split(/(?=add device \d+:)/).find(b => b.includes('"virtio_input_multi_touch_1"'));
const input = block?.match(/add device \d+: (\S+)/)?.[1];
const maxX = Number(block?.match(/ABS_MT_POSITION_X[^\n]*max (\d+)/)?.[1]);
const maxY = Number(block?.match(/ABS_MT_POSITION_Y[^\n]*max (\d+)/)?.[1]);
if (!input || !maxX || !maxY) throw new Error("no emulator primary touch screen");
adb("shell", "am", "force-stop", "design.takeone.tidewater");
adb("shell", "am", "start", "-n", "design.takeone.tidewater/.TidewaterActivity");
// Slow emulator boots must not become a blank opening in the recorded demo.
const appPid = adb("shell", "pidof", "design.takeone.tidewater").trim();
const loadDeadline = Date.now() + 30_000;
while (!adb("logcat", "-d", "--pid", appPid, "-s", "TidewaterDemo:I").includes("board ready")) {
  if (Date.now() > loadDeadline) throw new Error("Tidewater board did not finish loading");
  await sleep(250);
}
await sleep(500);
let ready!: () => void;
const flowing = new Promise<void>(r => { ready = r; });
const recording = runAndroidRecord({ serial, takesRoot: root, stateDirPath: join(root, "recorder-state"),
  onReady: dir => { console.log(`video ready: ${dir}`); ready(); } });
await Promise.race([flowing, recording.then(() => { throw new Error("recorder ended before ready"); })]);
const tap = (x: number, y: number) => {
  const values = [[3, 47, 0], [3, 53, Math.round(x / 1080 * (maxX + 1))],
    [3, 54, Math.round(y / 2400 * (maxY + 1))], [3, 48, 1280], [3, 49, 1280], [3, 58, 1024], [3, 57, 1], [0, 0, 0]];
  // One remote shell keeps round-trip latency out of the touch hold duration.
  const down = values.map(([type, code, value]) => `sendevent ${input} ${type} ${code} ${value}`).join("; ");
  adb("shell", `${down}; sleep 0.06; sendevent ${input} 3 58 0; sendevent ${input} 3 57 -1; sendevent ${input} 0 0 0`);
  console.log(`tapped display (${Math.round(x / 1080 * W)}, ${Math.round(y / 2400 * H)})`);
};
try {
  await sleep(2500); tap(880, 114);       // New task
  await sleep(3500); tap(540, 1390);      // Priority
  await sleep(3500); tap(450, 1510);      // High
  await sleep(3500); tap(780, 1585);      // Create task
  await sleep(2200);
} finally { process.emit("SIGINT"); }
const result = await recording;
const metaPath = join(result.takeDir, "take.json");
const meta = JSON.parse(readFileSync(metaPath, "utf8"));
const touches = readFileSync(join(result.takeDir, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
const clicks = touches.filter(e => e.k === "btn" && e.down);
if (clicks.length !== 4) throw new Error(`expected four real taps; got ${clicks.length}`);
meta.title = "Tidewater · From plan to priority";
const captions = ["Start a new task", "Choose a priority", "Make it high priority", "Add the launch brief"];
meta.captions = clicks.map((e, i) => ({ t: Math.max(0, (e.t - meta.offset_ms) / 1000), d: 2.6, text: captions[i] }));
writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
