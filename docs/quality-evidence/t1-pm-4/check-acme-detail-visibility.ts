import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { stageFrames, stageGeometry } from "../../../src/render/stage.ts";
import { DEFAULTS } from "../../../src/camera/defaults.ts";
import { idleSqueezes, warp } from "../../../src/render/pace.ts";
const dir = process.argv[2] ?? "tmp/t1-pm-4-acme";
const candidate = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const meta = JSON.parse(readFileSync(`${dir}/take.json`, "utf8"));
const camera = JSON.parse(readFileSync(`${dir}/camera.json`, "utf8"));
const events = readFileSync(`${dir}/events.jsonl`, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).filter(e => e.k === "ptr").sort((a, b) => a.t - b.t);
const d = { ...DEFAULTS, fps: 60, caption_font: "Liberation Sans" };
const sourceBeats = JSON.parse(readFileSync(`${dir}/analysis/beats.json`, "utf8")).map((beat: any) => ({
  ...beat,
  actions: beat.actions.map((action: any) => ({
    ...action,
    ...(action.t === undefined ? {} : { t: action.t * 1000 }),
    ...(action.t0 === undefined ? {} : { t0: action.t0 * 1000 }),
    ...(action.t1 === undefined ? {} : { t1: action.t1 * 1000 }),
    ...(action.path ? { path: action.path.map((p: any) => ({ ...p, t: p.t * 1000 })) } : {}),
  })),
}));
const squeezes = idleSqueezes(sourceBeats, meta.trim_start ?? 0, meta.trim_end ?? 44, d);
const speed = d.idle_speed;
const sourceTime = (out: number) => {
  let lo = 0, hi = meta.trim_end ?? 44;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const warped = warp(mid - (meta.trim_start ?? 0), squeezes, speed);
    if (warped < out) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
};
const st = stageGeometry(meta.width, meta.height, d);
const staged = stageFrames(camera, meta.width, meta.height, st, d);
const at = (t: number) => {
  let i = 0;
  while (i + 1 < events.length && events[i + 1]!.t < t * 1000) i++;
  const a = events[i]!, b = events[Math.min(i + 1, events.length - 1)]!;
  const u = b.t === a.t ? 0 : Math.max(0, Math.min(1, (t * 1000 - a.t) / (b.t - a.t)));
  return [a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u];
};
const inside = (f: any, b: number[]) => f.x <= b[0] && f.y <= b[1] && f.x + f.w >= b[0] + b[2] && f.y + f.h >= b[1] + b[3];
const rows = staged.map((f: any, i: number) => ({ f, source: sourceTime(f.t), i })).filter(({ f }: any) => f.t >= 16 && f.t <= 30);
let cursorMiss = 0, thumbMiss = 0, firstMiss: any = null;
for (const { f, source, i } of rows) {
  const [x, y] = at(source);
  const cursor = [x - 8 + st.screenX, y - 8 + st.screenY, 32, 40];
  let hx = 300;
  if (source >= 25.8) hx = 750;
  else if (source > 22.8) hx = Math.round(300 + Math.floor((source - 22.8) / 0.15 + 1) * 450 / 20);
  const thumb = [hx - 12 + st.screenX, 808 + st.screenY, 24, 24];
  const missedCursor = !inside(f, cursor), missedThumb = !inside(f, thumb);
  cursorMiss += Number(missedCursor); thumbMiss += Number(missedThumb);
  if (!firstMiss && (missedCursor || missedThumb)) firstMiss = { outputTime: f.t, sourceTime: source, crop: f, cursor, thumb, missedCursor, missedThumb };
}
const result = { squeezes, candidate, interval: [16, 30], frames: rows.length, cursorMiss, thumbMiss, firstMiss };
console.log(JSON.stringify(result, null, 2));
writeFileSync(`${dir}/detail-visibility.json`, JSON.stringify(result, null, 2) + "\n");
