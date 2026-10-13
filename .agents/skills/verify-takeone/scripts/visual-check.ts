#!/usr/bin/env node
// verify-takeone visual defect check for one rendered take (make/render or motion). Settled holds of
// the decoded film (and transition midpoints) are compared with the take's own source pixels, mapped
// by its sidecars (camera.json, camera.cmd, stage.png, beats/decisions, storyboard). Exit 1 names each
// defect with its frame time and a crop; exit 2 is a usage or input error. See ../SKILL.md.
//
//   node visual-check.ts <take-dir> --name <cell> --out <dir> [--theme <name>] [--film <mp4>] [--ref <mp4|png>]...
//     [--at <s,s,...>] [--debug]   (--at checks those times as holds; --debug also writes the predicted picture)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolveTheme } from "../../../../src/themes.ts";
import { sourceViewport, stageGeometry } from "../../../../src/render/stage.ts";
import { edgeCuts } from "../../../../src/render/framing.ts";
import { cameraViewport } from "../../../../src/motion/camera.ts";
import { heroSize } from "../../../../src/motion/geometry.ts";

// Limits, measured on main 868ff39 (SKILL.md "Visual defect pass" gives the measurement behind each).
export const LIMIT = {
  stretch: 0.01,   // |x scale / y scale - 1| of the screen inside the film
  match: 0.5,      // registration NCC (worst 5% of samples dropped) below this: the film does not show its take where the sidecars say
  axis: 0.05,      // NCC drop for a 3% scale error on one axis; below it that axis has no detail to measure
  strip: 8,        // px (at 1080 short side) of solid uniform band along a film or screen edge
  flatSd: 9,       // luma sd of a line that counts as one solid colour (stage grain is c0s=10)
  same: 24,        // luma: a pixel agrees with the expected film; also the strip colour tolerance
  cuts: 1,         // words or controls (edgeCuts dense stretches) cut by a frame or crop edge at a hold
  inside: 0.98,    // share of the held element inside the visible frame
  cover: 0.15,     // share of the held element covered by a caption, title, cursor or other overlay
};

type Rect = { x: number; y: number; w: number; h: number };
type Map2 = { ax: number; bx: number; ay: number; by: number }; // output px = a * source px + b
type Img = { w: number; h: number; p: Uint8Array };
interface View { m: Map2; clip: Rect; screen: string; W: number; H: number; win?: Rect }
interface Model {
  ow: number; oh: number; fps: number; dur: number; fade: number;
  view(k: number): View | null;
  source(v: View, t: number): Img;
  stage?: (v: View, X: number, Y: number) => number;
  element(v: View, t: number): { name: string; r: Rect } | null;
  pills(t: number): Rect[];
  windows: number[];
}

process.on("uncaughtException", e => { console.error(e); process.exit(2); }); // an error is not a defect
const { values: o, positionals } = parseArgs({ allowPositionals: true, options: {
  name: { type: "string" }, out: { type: "string" }, theme: { type: "string", default: "midnight" },
  film: { type: "string" }, ref: { type: "string", multiple: true, default: [] }, samples: { type: "string", default: "12" },
  at: { type: "string" }, debug: { type: "boolean", default: false } } });
const take = positionals[0] ? resolve(positionals[0]) : "";
if (!take || !o.name || !o.out || !existsSync(join(take, "take.json"))) {
  console.error("usage: visual-check.ts <take-dir> --name <cell> --out <dir> [--theme name] [--film mp4] [--ref mp4|png]...");
  process.exit(2);
}
const out = resolve(o.out), name = o.name;
mkdirSync(out, { recursive: true });
const json = (f: string) => JSON.parse(readFileSync(join(take, f), "utf8"));
const meta = json("take.json");
const film = resolve(o.film ?? [join(take, "out", `${meta.id}.mp4`), join(take, "out", "motion.mp4")].find(existsSync) ?? join(take, "out", `${meta.id}.mp4`));
const ff = (args: string[], max = 1 << 28) => execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-threads", "2", "-filter_threads", "2", ...args], { maxBuffer: max });
const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate:format=duration", "-of", "json", film], { encoding: "utf8" }));
const [ow, oh] = [probe.streams[0].width as number, probe.streams[0].height as number];
const [num, den = "1"] = String(probe.streams[0].r_frame_rate).split("/"), fps = Number(num) / Number(den), dur = Number(probe.format.duration);
const unit = Math.min(ow, oh) / 1080;

const decode = (file: string, w: number, h: number, t?: number): Img => {
  for (let back = 0; back <= 0.5; back += 0.1) {
    const p = ff([...(t === undefined ? [] : ["-ss", Math.max(0, t - back).toFixed(3)]), "-i", file, "-frames:v", "1", "-vf", "format=gray", "-f", "rawvideo", "-"]);
    if (p.length === w * h) return { w, h, p };
    if (t === undefined) break;
  }
  throw new Error(`${file}: no ${w}x${h} frame near ${t ?? 0} s`);
};
const size = (file: string) => {
  const s = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", file], { encoding: "utf8" })).streams[0];
  return { w: s.width as number, h: s.height as number };
};
const cut = (a: Rect, b: Rect): Rect => {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
};
const mapRect = (m: Map2, r: Rect): Rect => ({ x: m.ax * r.x + m.bx, y: m.ay * r.y + m.by, w: m.ax * r.w, h: m.ay * r.h });
const frame: Rect = { x: 0, y: 0, w: ow, h: oh };

/** make/render takes: the product's own stage geometry, card and clock (camera.cmd), and stage.png. */
function makeModel(): Model {
  const W = meta.width as number, H = meta.height as number, cam = json("camera.json") as Rect[];
  const cmd = readFileSync(join(take, "camera.cmd"), "utf8");
  let d = { ...resolveTheme(o.theme), out_w: ow, out_h: oh };
  if (meta.device !== undefined && H > W) d = { ...d, corner_radius: 36, stage_margin: Math.max(0.16, d.stage_margin) };
  const band = /\[camera\]null\[screen\]/.test(cmd);
  const at = cmd.match(/\[stage\]\[screen\]overlay=(\d+):(\d+)/), card = cmd.match(/v360=[^;]*?:w=(\d+):h=(\d+)/);
  if (!at || (band && !card)) throw new Error("camera.cmd: no screen overlay; unsupported render graph");
  const st = stageGeometry(W, H, d);
  if (!band && (st.screenX !== +at[1]! || st.screenY !== +at[2]!)) throw new Error(`geometry: checker stage (${st.screenX},${st.screenY}) != camera.cmd overlay (${at[1]},${at[2]})`);
  const box: Rect = band ? { x: +at[1]!, y: +at[2]!, w: +card![1]!, h: +card![2]! } : frame;
  // Output clock: the setpts warp render wrote (identity without squeezes). Edit clocks are not parsed.
  const pts = cmd.match(/^\[0:v\]setpts='([^']*)'/)?.[1];
  if (!pts) throw new Error("camera.cmd: edit-clock takes (cuts/speed) are not supported by this check");
  const expr = pts === "PTS-STARTPTS" ? "T" : pts.replace(/\/TB$/, "");
  if (!/^[\dT.+\-*/(),clip ]+$/.test(expr)) throw new Error(`camera.cmd: unexpected setpts ${pts}`);
  const outT = new Function("T", "clip", `return ${expr}`) as (T: number, c: (v: number, a: number, b: number) => number) => number;
  const outAt = (T: number) => outT(T, (v, a, b) => Math.min(b, Math.max(a, v)));
  const t0 = meta.trim_start ?? 0;
  const srcAt = (t: number) => { let lo = 0, hi = 1e4; for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (outAt(mid) < t) lo = mid; else hi = mid; } return t0 + hi; };
  const stagePng = join(take, "stage.png"), ss = size(stagePng), stage = decode(stagePng, ss.w, ss.h);
  const beats = json("analysis/beats.json") as { id: string; t0: number; t1: number; zones: { name: string; type: string; bbox: number[] }[] }[];
  const decided = new Map(readFileSync(join(take, "analysis/decisions.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).map(x => [x.beat, x.A]));
  const span = beats.map(b => ({ b, a: outAt(b.t0 - t0), z: outAt(b.t1 - t0) }));
  const secs = (s: string) => s.split(":").reduce((n, p) => n * 60 + Number(p), 0);
  const ass = existsSync(join(take, "captions.ass")) ? readFileSync(join(take, "captions.ass"), "utf8") : "";
  const pillList = [...ass.matchAll(/^Dialogue: 2,([\d:.]+),([\d:.]+),.*?\\move\([\d.]+,[\d.]+,([\d.]+),([\d.]+)[^}]*\\p1\}(.*)$/gm)].map(p => {
    const n = p[5]!.match(/-?[\d.]+/g)!.map(Number), xs = n.filter((_, i) => i % 2 === 0), ys = n.filter((_, i) => i % 2 === 1);
    return { a: secs(p[1]!), b: secs(p[2]!), r: { x: +p[3]! + Math.min(...xs), y: +p[4]! + Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) } };
  });
  return {
    ow, oh, fps, dur, fade: Math.min(d.fade_s, dur / 4),
    view(k) {
      const F = cam[Math.min(k, cam.length - 1)]!;
      const V = band ? { x: F.x - box.x * F.w / box.w, y: F.y - box.y * F.h / box.h, w: F.w * ow / box.w, h: F.h * oh / box.h }
        : sourceViewport({ t: 0, ...F }, W, H, st, d);
      return { m: { ax: ow / V.w, bx: -V.x * ow / V.w, ay: oh / V.h, by: -V.y * oh / V.h }, clip: box, screen: "screen.webm", W, H };
    },
    source: (_, t) => decode(join(take, "screen.webm"), W, H, srcAt(t)),
    stage: (v, X, Y) => {
      const [sx, sy] = band ? [X, Y] : [Math.round((X + 0.5 - v.m.bx) / v.m.ax - 0.5 + st.screenX), Math.round((Y + 0.5 - v.m.by) / v.m.ay - 0.5 + st.screenY)];
      return sx >= 0 && sy >= 0 && sx < stage.w && sy < stage.h ? stage.p[sy * stage.w + sx]! : NaN;
    },
    element(_, t) {
      const s = span.filter(x => x.a <= t && t <= x.z).at(-1);
      const z = s && s.b.zones.find(z => z.name === decided.get(s.b.id));
      return z && z.type !== "path" && z.type !== "all" ? { name: `${s.b.id}/${z.name}`, r: { x: z.bbox[0]!, y: z.bbox[1]!, w: z.bbox[2]!, h: z.bbox[3]! } } : null;
    },
    pills: t => pillList.filter(p => p.a <= t && t <= p.b).map(p => p.r),
    windows: span.flatMap(x => [x.a, x.z]),
  };
}

/** motion takes: camera.json maps the scene's screen onto the whole frame; scenes without a camera show no screen. */
function motionModel(): Model {
  const sb = json("storyboard.json"), cam = json("camera.json") as Rect[], cams = json("camera-scenes.json") as Record<string, unknown>;
  const screens = new Map<string, Img>();
  const scene = (t: number) => { let i = -1; sb.scenes.forEach((s: { at: number }, j: number) => { if (s.at <= t + 1e-6) i = j; }); return i; };
  return {
    ow, oh, fps, dur, fade: 0.4,
    view(k) {
      const i = scene(k / fps), s = sb.scenes[i], F = cam[Math.min(k, cam.length - 1)]!;
      if (!s?.screen || !(String(i) in cams)) return null;
      const scr = sb.screens[s.screen], m = { ax: ow / F.w, bx: -F.x * ow / F.w, ay: oh / F.h, by: -F.y * oh / F.h };
      // The device window, in screen px: a zoom-tour frame's own view; a hero bitmap, which
      // shows the whole screen (browser/laptop frames are aspect-exact; the phone frame
      // contain-fits: resources/motion/chrome.js deviceFrame, src/motion/camera.ts).
      const cf = (cams[String(i)] as Rect[])[Math.min((cams[String(i)] as Rect[]).length - 1, Math.round((k / fps - s.at) * fps))]!;
      let win: Rect = { x: 0, y: 0, w: scr.width, h: scr.height };
      if (s.pattern === "zoom-tour") win = { x: cf.x, y: cf.y, w: cf.w, h: cf.h };
      else if (s.pattern === "hero-reveal" && s.device !== "phone") {
        const vp = cameraViewport(sb, 0), size = heroSize(scr, s, vp.width, vp.height);
        const fit = s.device === "phone" ? Math.max(size.width / scr.width, size.height / scr.height) : size.width / scr.width;
        win = { x: (scr.width - size.width / fit) / 2, y: (scr.height - size.height / fit) / 2, w: size.width / fit, h: size.height / fit };
      }
      return { m, clip: cut(mapRect(m, win), frame), screen: s.screen, W: scr.width, H: scr.height, win };
    },
    source(v) {
      if (!screens.has(v.screen)) screens.set(v.screen, decode(join(take, sb.screens[v.screen].file), v.W, v.H));
      return screens.get(v.screen)!;
    },
    // A zoom-tour holds on its stop's region, a hero on its focus region or its device window.
    element(v, t) {
      const sc = sb.scenes[scene(t)], focus = sc?.focus && sb.regions.find((r: { id: string }) => r.id === sc.focus);
      if (sc?.pattern === "hero-reveal") return focus ? { name: focus.id, r: { x: focus.rect[0], y: focus.rect[1], w: focus.rect[2], h: focus.rect[3] } } : { name: `${v.screen} window`, r: v.win! };
      const stops = (sb.scenes[scene(t)]?.stops ?? []).map((s: { region: string }) => sb.regions.find((r: { id: string }) => r.id === s.region)).filter(Boolean);
      const best = stops.map((r: { id: string; rect: number[] }) => ({ name: r.id, r: { x: r.rect[0]!, y: r.rect[1]!, w: r.rect[2]!, h: r.rect[3]! } }))
        .sort((p: { r: Rect }, q: { r: Rect }) => { const a = (r: Rect) => { const c = cut(mapRect(v.m, r), frame); return c.w * c.h; }; return a(q.r) - a(p.r); })[0];
      return best ?? { name: v.screen, r: { x: 0, y: 0, w: v.W, h: v.H } };
    },
    pills: () => [],
    windows: sb.scenes.flatMap((s: { at: number; d: number }) => [s.at, s.at + s.d]),
  };
}

const model = existsSync(join(take, "storyboard.json")) ? motionModel() : makeModel();

// --- pixel helpers --------------------------------------------------------------------------
const blur = (g: Img): Img => { // 3x3 box: stage grain (c0s=10) stays under edgeCuts' 12-level ink step
  const { w, h, p } = g, q = new Uint8Array(p.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const X = x + i, Y = y + j; if (X >= 0 && Y >= 0 && X < w && Y < h) { s += p[Y * w + X]!; n++; } }
    q[y * w + x] = Math.round(s / n);
  }
  return { w, h, p: q };
};
const integral = (g: Img) => {
  const I = new Float64Array((g.w + 1) * (g.h + 1));
  for (let y = 0; y < g.h; y++) { let row = 0; for (let x = 0; x < g.w; x++) { row += g.p[y * g.w + x]!; I[(y + 1) * (g.w + 1) + x + 1] = I[y * (g.w + 1) + x + 1]! + row; } }
  return I;
};
/** Source luma around (sx, sy) averaged over +-r source px (the output pixel's footprint). */
const sampler = (S: Img) => {
  const I = integral(S), W1 = S.w + 1;
  return (sx: number, sy: number, r: number) => {
    const x0 = Math.max(0, Math.floor(sx - r + 0.5)), x1 = Math.min(S.w, Math.floor(sx + r + 0.5) + 1);
    const y0 = Math.max(0, Math.floor(sy - r + 0.5)), y1 = Math.min(S.h, Math.floor(sy + r + 0.5) + 1);
    if (x1 <= x0 || y1 <= y0) return NaN;
    return (I[y1 * W1 + x1]! - I[y0 * W1 + x1]! - I[y1 * W1 + x0]! + I[y0 * W1 + x0]!) / ((x1 - x0) * (y1 - y0));
  };
};
const at = (m: Map2, X: number, Y: number) => [(X + 0.5 - m.bx) / m.ax - 0.5, (Y + 0.5 - m.by) / m.ay - 0.5] as const;

/** Best-matching map near the expected one: scale about the content centre per axis, then shift. */
function register(O: Img, S: Img, v: View, region: Rect) {
  const ob = blur(O), sample = sampler(S), m0 = v.m;
  const c = { x: region.x + region.w / 2, y: region.y + region.h / 2 }, [scx, scy] = at(m0, c.x, c.y);
  const mk = (rx: number, ry: number, dx: number, dy: number): Map2 => ({ ax: m0.ax * rx, ay: m0.ay * ry,
    bx: c.x + dx + 0.5 - m0.ax * rx * (scx + 0.5), by: c.y + dy + 0.5 - m0.ay * ry * (scy + 0.5) });
  const score = (m: Map2, step: number, r: number) => {
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let Y = region.y + step / 2; Y < region.y + region.h; Y += step) for (let X = region.x + step / 2; X < region.x + region.w; X += step) {
      const [sx, sy] = at(m, X, Y);
      if (sx < 0 || sy < 0 || sx > S.w - 1 || sy > S.h - 1) continue;
      const a = ob.p[Math.floor(Y) * ob.w + Math.floor(X)]!, b = sample(sx, sy, r / m.ax);
      n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
    }
    const va = saa - sa * sa / n, vb = sbb - sb * sb / n;
    return n < 50 || va <= 0 || vb <= 0 ? -1 : (sab - sa * sb / n) / Math.sqrt(va * vb);
  };
  // The verdict score: NCC after dropping the 5% of samples the best linear fit explains worst, so a
  // caption-sized overlay (its own check) does not read as the wrong picture.
  const robust = (m: Map2) => {
    const a: number[] = [], b: number[] = [];
    for (let Y = region.y + 1; Y < region.y + region.h; Y += 2) for (let X = region.x + 1; X < region.x + region.w; X += 2) {
      const [sx, sy] = at(m, X, Y);
      if (sx < 0 || sy < 0 || sx > S.w - 1 || sy > S.h - 1) continue;
      a.push(ob.p[Math.floor(Y) * ob.w + Math.floor(X)]!); b.push(sample(sx, sy, 0.5 / m.ax));
    }
    const ncc = (keep: number[]) => {
      let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      for (const i of keep) { n++; sa += a[i]!; sb += b[i]!; saa += a[i]! * a[i]!; sbb += b[i]! * b[i]!; sab += a[i]! * b[i]!; }
      const va = saa - sa * sa / n, vb = sbb - sb * sb / n;
      return { r: n < 50 || va <= 0 || vb <= 0 ? -1 : (sab - sa * sb / n) / Math.sqrt(va * vb), g: (sab - sa * sb / n) / vb, c: (sa - (sab - sa * sb / n) / vb * sb) / n };
    };
    const all = a.map((_, i) => i), fit = ncc(all);
    const res = all.map(i => Math.abs(a[i]! - fit.g * b[i]! - fit.c)), cutoff = [...res].sort((p, q) => p - q)[Math.floor(res.length * 0.95)]!;
    return ncc(all.filter(i => res[i]! <= cutoff)).r;
  };
  let best = { rx: 1, ry: 1, dx: 0, dy: 0, s: -2 };
  const coarse = Math.max(8, Math.round(Math.max(region.w, region.h) / 60));
  for (let i = 0; i <= 16; i++) for (let j = 0; j <= 16; j++) for (let dx = -24; dx <= 24; dx += 8) for (let dy = -24; dy <= 24; dy += 8) {
    const rx = Math.exp(Math.log(0.82) + i * Math.log(1.22 / 0.82) / 16), ry = Math.exp(Math.log(0.82) + j * Math.log(1.22 / 0.82) / 16);
    const s = score(mk(rx, ry, dx, dy), coarse, coarse / 2);
    if (s > best.s) best = { rx, ry, dx, dy, s };
  }
  // Hill-climb at finer sampling from the coarse winner and from the sidecar map itself: thin UI lines
  // alias at coarse sampling, so the coarse winner can be a false peak (measured on main: 0.55 vs 0.91).
  const refine = (p: typeof best) => {
    for (const [step, r, ds, dd] of [[coarse / 2, 2, 0.006, 3], [4, 1, 0.002, 1], [2, 0.5, 0.0005, 0.25]] as const) {
      p = { ...p, s: score(mk(p.rx, p.ry, p.dx, p.dy), step, r) };
      for (let moved = true, k = 0; moved && k < 40; k++) {
        moved = false;
        for (const [a, b, e, f] of [[ds, 0, 0, 0], [-ds, 0, 0, 0], [0, ds, 0, 0], [0, -ds, 0, 0], [0, 0, dd, 0], [0, 0, -dd, 0], [0, 0, 0, dd], [0, 0, 0, -dd]] as const) {
          const cand = { rx: p.rx * (1 + a), ry: p.ry * (1 + b), dx: p.dx + e, dy: p.dy + f, s: 0 };
          cand.s = score(mk(cand.rx, cand.ry, cand.dx, cand.dy), step, r);
          if (cand.s > p.s + 1e-6) { p = cand; moved = true; }
        }
      }
    }
    return p;
  };
  const fromCoarse = refine(best), fromSidecar = refine({ rx: 1, ry: 1, dx: 0, dy: 0, s: -2 });
  best = fromSidecar.s >= fromCoarse.s ? fromSidecar : fromCoarse;
  // How sharply the match falls when one axis is scaled 3% off: content without detail along an axis
  // (bars, blank panels) cannot show that axis' scale, and its stretch is reported as unmeasured.
  const drop = (a: number, b: number) => best.s - Math.max(score(mk(best.rx * a, best.ry * b, best.dx, best.dy), 2, 0.5), score(mk(best.rx / a, best.ry / b, best.dx, best.dy), 2, 0.5));
  return { m: mk(best.rx, best.ry, best.dx, best.dy), ncc: robust(mk(best.rx, best.ry, best.dx, best.dy)), sidecar: score(mk(1, 1, 0, 0), 2, 0.5), ob, drop: [drop(1.03, 1), drop(1, 1.03)] as const };
}

// --- checks ---------------------------------------------------------------------------------
type Defect = { check: string; t: number; value: number; limit: number; where: Rect; note: string };
type Sample = { t: number; hold: boolean };
function samplesOf(): Sample[] {
  const n = Math.round(dur * fps), a = Math.round(0.25 * fps), views = Array.from({ length: n }, (_, k) => model.view(k));
  const key = (v: View | null) => v ? [v.m.bx, v.m.by, v.m.ax * v.W + v.m.bx, v.m.ay * v.H + v.m.by] : null;
  const keys = views.map(key);
  const still = (k: number) => { const p = keys[k], q = keys[Math.min(n - 1, k + a)]; return !p || !q ? p === q : views[k]!.screen === views[Math.min(n - 1, k + a)]!.screen && p.every((x, i) => Math.abs(x - q[i]!) < 1); };
  const live = (k: number) => k / fps > model.fade + 0.05 && k / fps < dur - model.fade - 0.05;
  const runs: { a: number; b: number; hold: boolean }[] = [];
  for (let k = 0; k < n; k++) {
    if (!live(k)) continue;
    const s = still(k), last = runs.at(-1);
    if (last && last.hold === s && last.b === k - 1) last.b = k; else runs.push({ a: k, b: k, hold: s });
  }
  const cuts = [...new Set(model.windows)].sort((p, q) => p - q);
  const holds = runs.filter(r => r.hold && (r.b - r.a) / fps >= 0.3).flatMap(r => {
    const edges = [r.a / fps, ...cuts.filter(c => c > r.a / fps && c < r.b / fps), r.b / fps];
    return edges.slice(1).map((e, i) => ({ t: (edges[i]! + e) / 2, len: e - edges[i]!, hold: true })).filter(x => x.len >= 0.3);
  });
  const moves = runs.filter(r => !r.hold && (r.b - r.a) / fps >= 0.15).map(r => ({ t: (r.a + r.b) / 2 / fps, len: 0, hold: false }));
  const pick = <T,>(xs: T[], cap: number, what: string) => {
    if (xs.length > cap) console.log(`NOTE ${name}: ${xs.length} ${what}, checking ${cap} spread evenly (${xs.length - cap} not checked)`);
    return xs.length <= cap ? xs : Array.from({ length: cap }, (_, i) => xs[Math.round(i * (xs.length - 1) / (cap - 1))]!);
  };
  return [...pick(holds, Number(o.samples), "holds"), ...pick(moves, 6, "transitions")]
    .map(s => ({ t: Math.round(s.t * fps) / fps, hold: s.hold })).sort((p, q) => p.t - q.t);
}

function check(s: Sample) {
  const k = Math.round(s.t * fps), v = model.view(k), O = decode(film, ow, oh, s.t);
  const defects: Defect[] = [], facts: Record<string, unknown> = { t: s.t, hold: s.hold };
  const flag = (check: string, value: number, limit: number, where: Rect, note: string) => defects.push({ check, t: s.t, value, limit, where, note });
  const S = v && model.source(v, s.t);
  let m = v?.m, ob = blur(O), fit = { g: 1, c: 0 }, matched = !!v;
  const content = v ? cut(cut(mapRect(v.m, { x: 0, y: 0, w: v.W, h: v.H }), v.clip), frame) : null;
  // Stretch: the sidecar map itself, then the map the pixels actually show.
  if (v && content && content.w * content.h > 0) {
    const geo = v.m.ax / v.m.ay - 1;
    facts.geometry_aspect_error = geo;
    if (Math.abs(geo) > LIMIT.stretch) flag("stretch", geo, LIMIT.stretch, content, "sidecar map scales x and y differently");
    const inner = { x: content.x + content.w * 0.03, y: content.y + content.h * 0.03, w: content.w * 0.94, h: content.h * 0.94 };
    if (s.hold) {
      const r = register(O, S!, v, inner);
      ob = r.ob; facts.ncc = r.ncc; facts.ncc_sidecar = r.sidecar;
      if (r.ncc < LIMIT.match) { matched = false; flag("mismatch", r.ncc, LIMIT.match, content, "film does not show the take's screen where its sidecars place it"); }
      else {
        m = r.m;
        const err = (m.ax / m.ay) - 1;
        facts.aspect_error = err; facts.scale = [m.ax / v.m.ax, m.ay / v.m.ay]; facts.shift = [m.bx - v.m.bx, m.by - v.m.by]; facts.axis_drop = r.drop;
        const measurable = Math.min(...r.drop) >= LIMIT.axis;
        if (!measurable) { facts.aspect_error = null; m = v.m; }
        else if (Math.abs(err) > LIMIT.stretch) flag("stretch", err, LIMIT.stretch, content, `screen shows ${(m.ax / v.m.ax).toFixed(3)}x wide, ${(m.ay / v.m.ay).toFixed(3)}x tall of its expected size`);
      }
    }
  }
  // Expected luma at an output pixel: the source through the map inside the screen, the stage outside.
  const sample = S && sampler(S);
  const expect = (X: number, Y: number) => {
    if (v && m && sample && X >= v.clip.x && Y >= v.clip.y && X < v.clip.x + v.clip.w && Y < v.clip.y + v.clip.h) {
      const [sx, sy] = at(m, X, Y);
      if (sx >= 0 && sy >= 0 && sx <= v.W - 1 && sy <= v.H - 1) return fit.g * sample(sx, sy, 1.5 / m.ax) + fit.c;
    }
    return v && model.stage ? model.stage(v, X, Y) : NaN;
  };
  if (v && content && matched) { // photometric fit (colour pipeline, fades): O ~ g * source + c
    let n = 0, sa = 0, sb = 0, sbb = 0, sab = 0;
    for (let Y = content.y + 4; Y < content.y + content.h - 4; Y += 7) for (let X = content.x + 4; X < content.x + content.w - 4; X += 7) {
      const b = expect(Math.floor(X), Math.floor(Y)), a = ob.p[Math.floor(Y) * ow + Math.floor(X)]!;
      if (Number.isFinite(b)) { n++; sa += a; sb += b; sbb += b * b; sab += a * b; }
    }
    const g = (sab - sa * sb / n) / (sbb - sb * sb / n);
    if (n > 100 && g > 0.5 && g < 2) fit = { g, c: (sa - g * sb) / n };
  }
  if (o.debug) { // the picture the sidecars predict, next to the film's own still
    const X = new Uint8Array(ow * oh);
    for (let Y = 0; Y < oh; Y++) for (let x = 0; x < ow; x++) { const e = expect(x, Y); X[Y * ow + x] = Number.isFinite(e) ? Math.max(0, Math.min(255, Math.round(e))) : 0; }
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${ow}x${oh}`, "-i", "-", "-frames:v", "1", "-update", "1", join(out, `${name}-t${s.t.toFixed(2)}-expected.png`)], { input: X });
  }
  const agrees = (X: number, Y: number) => { const e = expect(X, Y); return Number.isFinite(e) && Math.abs(ob.p[Y * ow + X]! - e) <= LIMIT.same; };
  // Stage colour for takes without stage.png (motion): the luma most of the frame border shows.
  const ring: number[] = [];
  for (let x = 0; x < ow; x += 4) ring.push(O.p[x]!, O.p[(oh - 1) * ow + x]!);
  for (let y = 0; y < oh; y += 4) ring.push(O.p[y * ow]!, O.p[y * ow + ow - 1]!);
  const hist = new Array(256).fill(0); ring.forEach(l => hist[l]++);
  const stageLuma = hist.indexOf(Math.max(...hist));

  // Visible screen: the device window or card the sidecars give, under the map the pixels show.
  const shown = v && m && content ? cut(cut(mapRect(m, { x: 0, y: 0, w: v.W, h: v.H }), v.clip), frame) : content;
  if (shown) facts.shown = shown;

  // Blank strips: solid uniform lines running in from a film edge or a screen edge that are neither
  // the expected picture (stage or screen) nor, without stage.png, the stage colour.
  const line = (vertical: boolean, i: number, a: number, b: number) => {
    let n = 0, s = 0, ss = 0, en = 0, es = 0, ess = 0;
    for (let j = Math.ceil(a); j < b; j += 2) {
      const [X, Y] = vertical ? [i, j] : [j, i], l = O.p[Y * ow + X]!, e = expect(X, Y);
      n++; s += l; ss += l * l;
      if (Number.isFinite(e)) { en++; es += e; ess += e * e; }
    }
    const mean = s / n, sd = Math.sqrt(Math.max(0, ss / n - mean * mean)), emean = es / en, esd = Math.sqrt(Math.max(0, ess / en - emean * emean));
    const known = en >= n * 0.9, same = known ? esd <= LIMIT.flatSd * 2 && Math.abs(mean - emean) <= LIMIT.same : Math.abs(mean - stageLuma) <= LIMIT.same;
    return sd <= LIMIT.flatSd && !same;
  };
  const strips: Record<string, number> = {};
  const scan = (label: string, vertical: boolean, from: number, dir: number, a: number, b: number, depth: number) => {
    let n = 0;
    while (n < depth && line(vertical, from + dir * n, a, b)) n++;
    strips[label] = n;
    if (n >= LIMIT.strip * unit) {
      const lo = dir > 0 ? from : from - n + 1;
      flag("blank-strip", n, LIMIT.strip * unit, vertical ? { x: lo, y: a, w: n, h: b - a } : { x: a, y: lo, w: b - a, h: n }, `${n} px solid band at the ${label}`);
    }
  };
  scan("film left", true, 0, 1, 0, oh, ow / 4); scan("film right", true, ow - 1, -1, 0, oh, ow / 4);
  scan("film top", false, 0, 1, 0, ow, oh / 4); scan("film bottom", false, oh - 1, -1, 0, ow, oh / 4);
  // Bars a device frame puts around the screen (a letterboxed phone film): flat unexpected
  // bands running outward from a screen edge that stop at the frame. Stage also runs flat,
  // but it reaches the film edge, so only bounded runs flag.
  const scanOut = (label: string, vertical: boolean, from: number, dir: number, a: number, b: number) => {
    let m = 0;
    const max = dir > 0 ? (vertical ? ow - 1 - from : oh - 1 - from) : from;
    while (m < max && line(vertical, from + dir * m, a, b)) m++;
    strips[label] = m;
    const end = from + dir * m, bounded = dir > 0 ? end < (vertical ? ow - 1 : oh - 1) : end > 0;
    if (m >= LIMIT.strip * unit && bounded) {
      const lo = dir > 0 ? from : from - m + 1;
      flag("blank-strip", m, LIMIT.strip * unit, vertical ? { x: lo, y: a, w: m, h: b - a } : { x: a, y: lo, w: b - a, h: m }, `${m} px solid band inside the device frame at the ${label}`);
    }
  };
  if (content && content.w > 20 && content.h > 20) {
    const [x0, y0, x1, y1] = [Math.ceil(content.x), Math.ceil(content.y), Math.floor(content.x + content.w) - 1, Math.floor(content.y + content.h) - 1];
    if (x0 > 0) scan("screen left", true, x0, 1, y0, y1, content.w / 4);
    if (x1 < ow - 1) scan("screen right", true, x1, -1, y0, y1, content.w / 4);
    if (y0 > 0) scan("screen top", false, y0, 1, x0, x1, content.h / 4);
    if (y1 < oh - 1) scan("screen bottom", false, y1, -1, x0, x1, content.h / 4);
    if (x0 > 0) scanOut("screen frame left", true, x0 - 1, -1, y0, y1);
    if (x1 < ow - 1) scanOut("screen frame right", true, x1 + 1, 1, y0, y1);
    if (y0 > 0) scanOut("screen frame top", false, y0 - 1, -1, x0, x1);
    if (y1 < oh - 1) scanOut("screen frame bottom", false, y1 + 1, 1, x0, x1);
  }
  facts.strips = strips;

  if (s.hold) {
    // Clipped text: make's edgeCuts (1e4 per dense ink stretch an edge runs through) on the denoised
    // film at each film edge, and on the source at each edge where the visible screen is cropped.
    const words: Record<string, number> = {};
    const note = (label: string, n: number, off: Rect) => {
      words[label] = n;
      if (n >= LIMIT.cuts) flag("clipped-text", n, LIMIT.cuts, off, `${n} word(s) or control(s) cut at the ${label}`);
    };
    const all = edgeCuts([ob.p], ow, oh, 0);
    for (const [label, r, off] of [["film left", { x: 1, y: 0, w: ow - 1, h: oh }, { x: 0, y: 0, w: 24, h: oh }], ["film right", { x: 0, y: 0, w: ow - 1, h: oh }, { x: ow - 24, y: 0, w: 24, h: oh }],
      ["film top", { x: 0, y: 1, w: ow, h: oh - 1 }, { x: 0, y: 0, w: ow, h: 24 }], ["film bottom", { x: 0, y: 0, w: ow, h: oh - 1 }, { x: 0, y: oh - 24, w: ow, h: 24 }]] as const) note(label, Math.floor(all(r) / 1e4), off);
    // Crop edges are judged on the source screen, as make's framing does: a film overlay (a phone's
    // status bar, a bezel) meeting the window edge is not a cut word. Each edge counts only over
    // the shown segment: ink outside the visible region is fully outside the frame, never cut.
    if (v && m && S && shown && shown.w > 40 && shown.h > 40) {
      const at0 = at(m, shown.x, shown.y), at1 = at(m, shown.x + shown.w, shown.y + shown.h), tol = 0.01 * Math.max(v.W, v.H);
      const [l, t, r, b] = [Math.max(0, Math.round(at0[0])), Math.max(0, Math.round(at0[1])), Math.min(v.W, Math.round(at1[0])), Math.min(v.H, Math.round(at1[1]))];
      const src = edgeCuts([S.p], S.w, S.h, 0), side = (label: string, rect: Rect, off: Rect) => note(label, Math.floor(src(rect, { x: l, y: t, w: r - l, h: b - t }) / 1e4), off);
      const [x, y, w, h] = [shown.x, shown.y, shown.w, shown.h];
      if (l > tol) side("screen crop left", { x: l, y: 0, w: v.W - l, h: v.H }, { x, y, w: 24, h });
      if (r < v.W - tol) side("screen crop right", { x: 0, y: 0, w: r, h: v.H }, { x: x + w - 24, y, w: 24, h });
      if (t > tol) side("screen crop top", { x: 0, y: t, w: v.W, h: v.H - t }, { x, y, w, h: 24 });
      if (b < v.H - tol) side("screen crop bottom", { x: 0, y: 0, w: v.W, h: b }, { x, y: y + h - 24, w, h: 24 });
    }
    facts.cut_words = words;

    // Off-screen and overlap: the element the camera holds on, through the map the pixels show.
    const el = v && m && model.element(v, s.t);
    if (el && shown && matched) {
      // 2 px of slack: a full-width element meets the screen's anti-aliased edge. An element larger than
      // the view (a deliberate close-up inside it) passes when it fills at least half the view.
      const E = mapRect(m!, el.r), view = { x: shown.x - 2, y: shown.y - 2, w: shown.w + 4, h: shown.h + 4 }, seen = cut(cut(E, view), frame);
      const fits = E.w <= view.w && E.h <= view.h;
      const inside = fits ? (seen.w * seen.h) / (E.w * E.h) : Math.min(1, (seen.w * seen.h) / (shown.w * shown.h) * 2);
      facts.element = { name: el.name, rect: E, inside };
      if (inside < LIMIT.inside) flag("off-screen", inside, LIMIT.inside, E, `held element ${el.name} is ${(100 * (1 - inside)).toFixed(1)}% outside the visible frame`);
      let n = 0, bad = 0;
      for (let Y = Math.ceil(seen.y); Y < seen.y + seen.h; Y += 2) for (let X = Math.ceil(seen.x); X < seen.x + seen.w; X += 2) { n++; if (!agrees(X, Y)) bad++; }
      const covered = n ? bad / n : 0, pill = model.pills(s.t).some(p => cut(p, seen).w * cut(p, seen).h > 0);
      facts.covered = covered;
      if (covered > LIMIT.cover) flag("overlap", covered, LIMIT.cover, seen, `${(100 * covered).toFixed(1)}% of held element ${el.name} covered${pill ? " by a caption" : ""}`);
    }
  }
  return { facts, defects };
}

// --- run, evidence --------------------------------------------------------------------------
const font = resolve(import.meta.dirname, "../../../../resources/fonts/Inter-SemiBold.ttf");
const label = (text: string) => `drawtext=fontfile='${font}':text='${text.replace(/[':\\]/g, " ")}':x=12:y=10:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8`;
const stamp = (t: number) => t.toFixed(2).padStart(6, "0");
const log: string[] = [], results: unknown[] = [];
let failed = false;
const chosen = o.at ? o.at.split(",").map(t => ({ t: Math.round(Number(t) * fps) / fps, hold: true })) : samplesOf();
for (const s of chosen) {
  const r = check(s), base = `${name}-t${stamp(s.t)}`;
  ff(["-y", "-ss", s.t.toFixed(3), "-i", film, "-frames:v", "1", "-update", "1", join(out, `${base}.png`)]);
  const refs = o.ref!.map(f => resolve(f)).filter(existsSync);
  const inputs = refs.flatMap(f => f.endsWith(".mp4") ? ["-ss", s.t.toFixed(3), "-i", f] : ["-i", f]);
  const right = refs.length === 0 ? "" : `;${refs.map((_, i) => `[${i + 1}:v]${refs.length > 1 ? "scale=1280:-2" : "scale=-2:540,pad='max(iw,480)':ih:(ow-iw)/2:0:color=0x808080"}[r${i}]`).join(";")};${refs.map((_, i) => `[r${i}]`).join("")}${refs.length > 1 ? `vstack=inputs=${refs.length},scale=-2:540,` : "null,"}${label(refs.some(f => f.endsWith(".mp4")) ? "reference main" : "approved reference")}[r]`;
  ff(["-y", "-i", join(out, `${base}.png`), ...inputs, "-filter_complex",
    `[0:v]scale=-2:540,pad='max(iw,480)':ih:(ow-iw)/2:0:color=0x808080,${label(`${name} ${s.t.toFixed(2)}s ${r.defects.length ? "FAIL " + [...new Set(r.defects.map(d => d.check))].join(" ") : "pass"}`)}[l]${right}${refs.length ? ";[l][r]hstack=inputs=2" : ";[l]null"}`,
    "-frames:v", "1", "-update", "1", join(out, `${base}-side.png`)]);
  for (const d of r.defects) {
    const c = cut({ x: d.where.x - 24, y: d.where.y - 24, w: d.where.w + 48, h: d.where.h + 48 }, frame);
    const crop = `${base}-${d.check}-${log.length}.png`;
    ff(["-y", "-i", join(out, `${base}.png`), "-vf", `crop=${Math.max(2, Math.round(c.w))}:${Math.max(2, Math.round(c.h))}:${Math.round(c.x)}:${Math.round(c.y)}`, "-frames:v", "1", "-update", "1", join(out, crop)]);
    log.push(`FAIL ${name} t=${s.t.toFixed(2)}s ${d.check} value=${+d.value.toFixed(4)} limit=${d.limit} crop=${crop} -- ${d.note}`);
  }
  if (!r.defects.length) log.push(`PASS ${name} t=${s.t.toFixed(2)}s ${s.hold ? "hold" : "transition"} ${JSON.stringify(r.facts)}`);
  failed ||= r.defects.length > 0;
  results.push({ ...r, still: `${base}.png`, side: `${base}-side.png` });
}
writeFileSync(join(out, `${name}.json`), JSON.stringify({ take, film, theme: o.theme, size: [ow, oh], limits: LIMIT, results }, null, 1) + "\n");
console.log(log.join("\n"));
console.log(`${failed ? "FAIL" : "PASS"} ${name}: ${results.length} frames checked, ${log.filter(l => l.startsWith("FAIL")).length} defect(s)`);
process.exit(failed ? 1 : 0);
