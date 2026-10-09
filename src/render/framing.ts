// Opt-in camera path (`--set camera_path=hold`): the solver's settled framings, made
// safe on what the viewer actually sees, held exactly, and joined by one eased move each.
// Every rectangle here is the final visible one (stage px, after crop-to-fill, or the
// band card's source crop), so the edge check judges the pixels that are rendered.
import { execFileSync } from "node:child_process";
import type { CameraDefaults } from "../camera/defaults.ts";
import type { Beat, CameraFrame, Decision, Zone } from "../camera/types.ts";
import { cornerSize, stageFrames, type Band, type Stage } from "./stage.ts";

type Rect = { x: number; y: number; w: number; h: number };
export type Hold = { a: number; b: number; r: Rect; why: string };
type Subject = { beat: Beat; zone: Zone; box: Rect };
/** Grey source frame (width*height bytes) shown at output time t. */
export type FrameAt = (t: number) => Uint8Array;

// Gate limits with headroom under scripts/quality.ts (1 ln/s, 4 ln/s², 9000 px/s²).
const ZOOM_V = 0.9, ZOOM_A = 3.2, PAN_A = 8000;
const SETTLE = 0.002, MIN_HOLD_S = 0.2, MOVE_MAX_S = 2.5;
const INK_STEP = 12, LANDMARK_INK = 0.01, GUARD = 6, GAP = 8, SAMPLES = 9, TEXT_SPAN = 32, TEXT_INK = 6, PANEL_GROW = 4;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const ease = (u: number) => u * u * u * (u * (6 * u - 15) + 10);
const inked = (g: Uint8Array, i: number, W: number) =>
  Math.abs(g[i]! - g[i - 1]!) > INK_STEP || Math.abs(g[i]! - g[i - W]!) > INK_STEP;

export function videoFrames(video: string, W: number, H: number, sourceAt: (t: number) => number): FrameAt {
  return (t) => {
    // The output can run a few frames past the source's last frame: step back until one decodes.
    for (let back = 0; back <= 0.5; back += 0.1) {
      const raw = execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-threads", "2", "-ss", Math.max(0, sourceAt(t) - back).toFixed(3),
        "-i", video, "-frames:v", "1", "-vf", "format=gray", "-f", "rawvideo", "-"], { maxBuffer: W * H + 1024 });
      if (raw.length === W * H) return raw;
    }
    throw new Error(`camera_path=hold: no source frame near ${t.toFixed(2)} s`);
  };
}

/**
 * Content a source rectangle's edges cross over all sample frames: ink pixels within +-guard px
 * of each edge, plus 1e4 per stretch of text the edge runs through; 0 means clean. Content is ink (a luma step); a straight ink run of 1600+ px at 4K
 * (a page-wide rule, the sidebar line) is a separator, which an edge may cross. An edge on
 * the source border cuts nothing.
 */
export function edgeCuts(frames: Uint8Array[], W: number, H: number, guard = GUARD): (r: Rect) => number {
  const m = new Uint8Array(W * H); // bit 1 ink, 2 horizontal separator, 4 vertical separator
  for (const g of frames) for (let y = 1; y < H; y++) for (let x = 1; x < W; x++) if (inked(g, y * W + x, W)) m[y * W + x] = 1;
  const sep = 1600 * Math.max(W, H) / 3840;
  const runs = (n: number, at: (j: number) => number, bit: number) => {
    let a = -1, last = -1;
    const mark = () => { if (a >= 0 && last - a + 1 >= sep) for (let j = a; j <= last; j++) m[at(j)] = m[at(j)]! | bit; };
    for (let j = 0; j < n; j++) if (m[at(j)]! & 1) { if (a < 0 || j - last > 4) { mark(); a = j; } last = j; }
    mark();
  };
  for (let y = 0; y < H; y++) runs(W, x => y * W + x, 2);
  for (let x = 0; x < W; x++) runs(H, y => y * W + x, 4);
  // Prefix sums: a vertical edge counts ink that is not a horizontal separator, and vice versa.
  const col = new Uint16Array(W * (H + 1)), row = new Uint16Array(H * (W + 1));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = m[y * W + x]!;
    col[x * (H + 1) + y + 1] = col[x * (H + 1) + y]! + ((v & 3) === 1 ? 1 : 0);
    row[y * (W + 1) + x + 1] = row[y * (W + 1) + x]! + ((v & 5) === 1 ? 1 : 0);
  }
  const colInk = (c: number, a: number, b: number) => c < 0 || c >= W ? 0 : col[c * (H + 1) + b]! - col[c * (H + 1) + a]!;
  const rowInk = (r: number, a: number, b: number) => r < 0 || r >= H ? 0 : row[r * (W + 1) + b]! - row[r * (W + 1) + a]!;
  return (r) => {
    const x0 = Math.round(r.x), x1 = Math.round(r.x + r.w) - 1, y0 = Math.round(r.y), y1 = Math.round(r.y + r.h) - 1;
    const ya = clamp(y0, 0, H), yb = clamp(y1 + 1, 0, H), xa = clamp(x0, 0, W), xb = clamp(x1 + 1, 0, W);
    // A word or control the edge runs through is dense ink along it; a border it crosses is a
    // pixel or two. Each dense stretch outweighs any amount of thin crossings.
    const dense = (ink: (a: number, b: number) => number, a: number, b: number) => {
      let n = 0;
      for (let s = a; s < b; s += TEXT_SPAN / 2) if (ink(s, Math.min(b, s + TEXT_SPAN)) >= TEXT_INK) n++;
      return n;
    };
    // Over a +-3 px band, so an edge inside a glyph's stroke still counts the stroke.
    const band = [-3, -2, -1, 0, 1, 2, 3];
    const cols = (x: number) => (p: number, q: number) => Math.max(...band.map(k => colInk(x + k, p, q)));
    const rows = (y: number) => (p: number, q: number) => Math.max(...band.map(k => rowInk(y + k, p, q)));
    let n = 1e4 * ((x0 > 0 ? dense(cols(x0), ya, yb) : 0) + (x1 < W - 1 ? dense(cols(x1), ya, yb) : 0)
      + (y0 > 0 ? dense(rows(y0), xa, xb) : 0) + (y1 < H - 1 ? dense(rows(y1), xa, xb) : 0));
    for (let k = -guard; k <= guard; k++) {
      n += (x0 > 0 ? colInk(x0 + k, ya, yb) : 0) + (x1 < W - 1 ? colInk(x1 + k, ya, yb) : 0)
        + (y0 > 0 ? rowInk(y0 + k, xa, xb) : 0) + (y1 < H - 1 ? rowInk(y1 + k, xa, xb) : 0);
    }
    return n;
  };
}

export interface HoldView { band: Band | null; stage: Stage; width: number; height: number; d: CameraDefaults; minShot: number }

export function holdPath(solved: CameraFrame[], beats: Beat[], decisions: Decision[], v: HoldView, frameAt: FrameAt): { frames: CameraFrame[]; holds: Hold[] } {
  const { band, stage: st, width: W, height: H, d } = v;
  const N = solved.length, T = (i: number) => solved[clamp(i, 0, N - 1)]!.t;
  const narrow = !band && d.out_w / d.out_h < W / H - 1e-6;
  const inset = narrow ? cornerSize(st, d) : 0;
  // Path px = source px + offset; the gates measure -K * x / w on these rectangles.
  const [ox, oy] = band ? [0, 0] : [st.screenX, st.screenY];
  const K = band ? [st.baseW, st.baseH] as const : [d.out_w, d.out_h] as const;
  const ratio = solved[0]!.h / solved[0]!.w, a = band ? 1 / ratio : d.out_w / d.out_h;
  const lim: Rect = band ? { x: 0, y: 0, w: W, h: H }
    : narrow ? { x: ox + inset, y: oy + inset, w: W - 2 * inset, h: H - 2 * inset } : { x: 0, y: 0, w: st.w, h: st.h };
  const wmax = Math.min(lim.w, lim.h * a), wmin = (band ? st.baseW : d.out_w) / d.max_upscale;
  const visible = (f: CameraFrame): Rect => band ? f : stageFrames([f], W, H, st, d)[0]!;
  const place = (cx: number, cy: number, w: number): Rect => {
    w = Math.min(wmax, w);
    return { x: clamp(cx - w / 2, lim.x, lim.x + lim.w - w), y: clamp(cy - w / a / 2, lim.y, lim.y + lim.h - w / a), w, h: w / a };
  };
  const whole = place(lim.x + lim.w / 2, lim.y + lim.h / 2, wmax);
  const fit = (s: Rect) => place(s.x + s.w / 2, s.y + s.h / 2, Math.max(wmin, s.w * d.hold_pad, s.h * d.hold_pad * a));
  const shift = (r: Rect) => ({ ...r, x: r.x - ox, y: r.y - oy });
  // Shows the entire source, so no edge can cut anything (a crop-to-fill frame never does).
  const full = (r: Rect) => r.x <= ox && r.y <= oy && r.x + r.w >= ox + W && r.y + r.h >= oy + H;

  // The solver's settled framings are the targets.
  const main = solved.map(visible);
  const moved = (p: Rect, q: Rect) => Math.abs(Math.log(q.w / p.w)) + Math.hypot(q.x + q.w / 2 - p.x - p.w / 2, q.y + q.h / 2 - p.y - p.h / 2) / q.w;
  const holds: Hold[] = [];
  for (let i = 0; i < N; i++) {
    if (i && moved(main[i - 1]!, main[i]!) >= SETTLE) continue;
    let j = i;
    while (j + 1 < N && moved(main[j]!, main[j + 1]!) < SETTLE) j++;
    if (T(j + 1) - T(i) >= MIN_HOLD_S) holds.push({ a: i, b: j, r: main[(i + j) >> 1]!, why: "solver hold" });
    i = j;
  }
  if (!holds.length) return { frames: solved, holds };

  // The panel a control sits on (a modal dialog with its buttons): grow the source box across
  // its background colour until another surface. Kept only if it closes on every side within
  // PANEL_GROW times the box's area, so a card on an open board stays the card.
  const panel = (g: Uint8Array, b: Rect): Rect => {
    const lum = (x: number, y: number) => g[clamp(Math.round(y), 0, H - 1) * W + clamp(Math.round(x), 0, W - 1)]!;
    const [cx, cy] = [b.x + b.w / 2, b.y + b.h / 2], bg = lum(b.x - 4, cy);
    const edge = (x: number, y: number, dx: number, dy: number) => {
      for (let run = 0; x > 0 && x < W - 1 && y > 0 && y < H - 1; x += dx, y += dy) {
        run = Math.abs(lum(x, y) - bg) > 16 ? run + 1 : 0;
        if (run >= 24) return dx ? x - dx * run : y - dy * run;
      }
      return undefined;
    };
    const [l, r, t, u] = [edge(b.x - 4, cy, -1, 0), edge(b.x + b.w + 4, cy, 1, 0), edge(cx, b.y - 4, 0, -1), edge(cx, b.y + b.h + 4, 0, 1)];
    if (l === undefined || r === undefined || t === undefined || u === undefined) return b;
    const p = { x: l, y: t, w: r - l + 1, h: u - t + 1 };
    return p.w * p.h <= PANEL_GROW * b.w * b.h && p.w <= wmax && p.h <= wmax / a ? p : b;
  };
  // Decided subjects. One the frame cannot hold gives way to its largest control inside that
  // fits (a typing beat's field); failing that the frame stays inside it on the axis too wide.
  const fits = (z: Zone) => z.bbox[2] + 2 * GAP <= wmax && z.bbox[3] + 2 * GAP <= wmax / a;
  const within = (p: Zone, q: Zone) => p.bbox[0] >= q.bbox[0] && p.bbox[1] >= q.bbox[1]
    && p.bbox[0] + p.bbox[2] <= q.bbox[0] + q.bbox[2] && p.bbox[1] + p.bbox[3] <= q.bbox[1] + q.bbox[3];
  const subjects: Subject[] = beats.flatMap((beat) => {
    const A = decisions.find(x => x.beat === beat.id)?.A, decided = beat.zones.find(z => z.name === A);
    if (!decided || decided.type === "all" || beat.t1 - beat.t0 < 2 / d.fps) return [];
    const zone = fits(decided) ? decided : beat.zones.filter(z => z !== decided && z.type !== "path" && z.type !== "all" && fits(z) && within(z, decided))
      .sort((p, q) => q.bbox[2] * q.bbox[3] - p.bbox[2] * p.bbox[3])[0] ?? decided;
    const [x, y, w, h] = zone.bbox, box = zone.type === "path" ? { x, y, w, h } : panel(frameAt((beat.t0 + beat.t1) / 2), { x, y, w, h });
    return [{ beat, zone, box: { ...box, x: box.x + ox, y: box.y + oy } }];
  });
  // A subject belongs to a hold it overlaps by more than two frames, not one it merely touches.
  const overlap = (s: Subject, h: Hold) => Math.min(s.beat.t1, T(h.b + 1)) - Math.max(s.beat.t0, T(h.a));
  const during = (h: Hold) => subjects.filter(s => overlap(s, h) > 2 / d.fps);
  const dominant = (h: Hold) => during(h).sort((p, q) => overlap(q, h) - overlap(p, h))[0];
  const span = (lo: number, len: number, slo: number, slen: number, g: number) => slen + 2 * g <= len
    ? lo <= slo - g && lo + len >= slo + slen + g : lo >= slo - g && lo + len <= slo + slen + g;
  const shows = (r: Rect, s: Rect, g = GAP) => span(r.x, r.w, s.x, s.w, g) && span(r.y, r.h, s.y, s.h, g);

  // (a) Landmark: a framing whose UI subject has vanished (no ink left) widens to the
  // smallest zone of that beat around it. A path zone is the pointer's trail, not a landmark.
  for (const h of holds) {
    if (full(h.r)) continue;
    for (const s of during(h).filter(s => s.zone.type !== "path")) {
      const g = frameAt((Math.max(s.beat.t0, T(h.a)) + Math.min(s.beat.t1, T(h.b))) / 2), b = shift(s.box);
      let ink = 0;
      for (let y = Math.max(1, Math.round(b.y)); y < Math.min(H, b.y + b.h); y++)
        for (let x = Math.max(1, Math.round(b.x)); x < Math.min(W, b.x + b.w); x++) if (inked(g, y * W + x, W)) ink++;
      if (ink / (b.w * b.h) >= LANDMARK_INK) continue;
      const [cx, cy] = [b.x + b.w / 2, b.y + b.h / 2];
      const next = s.beat.zones.filter(z => z.bbox[2] * z.bbox[3] > b.w * b.h && z.bbox[0] <= cx && z.bbox[0] + z.bbox[2] >= cx
        && z.bbox[1] <= cy && z.bbox[1] + z.bbox[3] >= cy).sort((p, q) => p.bbox[2] * p.bbox[3] - q.bbox[2] * q.bbox[3])[0];
      h.r = !next || next.type === "all" ? whole : fit({ x: next.bbox[0] + ox, y: next.bbox[1] + oy, w: next.bbox[2], h: next.bbox[3] });
      h.why = `landmark ${s.beat.id}/${s.zone.name} gone -> ${next?.name ?? "whole"}`;
    }
  }

  // (c) Edge safety: no frame edge cuts a control or a word anywhere in the hold. Take the
  // least change (ln zoom-out + centre shift in widths) whose edges, with a guard band, are
  // clean. A crop-to-fill frame can have no clean framing at all (a modal over a full board):
  // then take the framing that crosses the least content, so the subject stays whole.
  const edgeSafe = (list: Hold[]) => {
    for (const h of list) {
      if (full(h.r)) continue;
      const frames = Array.from({ length: SAMPLES }, (_, j) => frameAt(T(Math.round(h.a + (h.b - h.a) * j / (SAMPLES - 1)))));
      const guarded = edgeCuts(frames, W, H), plain = edgeCuts(frames, W, H, 0);
      if (!guarded(shift(h.r))) continue;
      const c0 = [h.r.x + h.r.w / 2, h.r.y + h.r.h / 2] as const;
      const search = (subs: Subject[], score: (r: Rect) => number, stop: boolean) => {
        let best: Rect | undefined, key = [Infinity, Infinity];
        for (let w = h.r.w; !stop || Math.log(w / h.r.w) < key[1]!; w = Math.min(wmax, w * 1.005)) {
          const hh = w / a, reach = w / 2;
          for (let x = Math.max(lim.x, c0[0] - w / 2 - reach); x <= Math.min(lim.x + lim.w - w, c0[0] - w / 2 + reach) + 1e-6; x += 4)
            for (let y = Math.max(lim.y, c0[1] - hh / 2 - reach); y <= Math.min(lim.y + lim.h - hh, c0[1] - hh / 2 + reach) + 1e-6; y += 4) {
              const r = { x, y, w, h: hh }, c = Math.log(w / h.r.w) + Math.hypot(x + w / 2 - c0[0], y + hh / 2 - c0[1]) / w;
              if ((stop && c >= key[1]!) || !subs.every(s => shows(r, s.box))) continue;
              const n = score(shift(r));
              if (n === Infinity) continue;
              if (n < key[0]! || (n === key[0] && c < key[1]!)) { key = [n, c]; best = r; }
            }
          if (w >= wmax) break;
        }
        return { best, cut: key[0]! };
      };
      // Clean with the guard band: stop widening once zooming out alone costs more than the best.
      // Subjects that no one frame can show together give way to the hold's dominant one.
      const top = dominant(h);
      let found = { best: undefined as Rect | undefined, cut: 0 };
      for (const subs of [during(h), top ? [top] : []]) {
        found = search(subs, r => guarded(r) ? Infinity : 0, true);
        if (!found.best) found = search(subs, plain, false);
        if (found.best) break;
      }
      if (found.best) { h.r = found.best; h.why += found.cut ? `; least cut (${found.cut} px)` : "; edge-safe"; }
      else console.warn(`camera_path=hold: no framing shows the subject for ${T(h.a).toFixed(2)}-${T(h.b).toFixed(2)} s`);
    }
  };
  edgeSafe(holds);

  // (b) No same-subject rescale under 2x: hold one framing instead. The subject of a hold is the
  // one active over most of it; keep the earlier framing when it shows both holds' subjects.
  const inside = (p: Rect, q: Rect) => p.x >= q.x - 1 && p.y >= q.y - 1 && p.x + p.w <= q.x + q.w + 1 && p.y + p.h <= q.y + q.h + 1;
  for (let k = 0; k + 1 < holds.length;) {
    const p = holds[k]!, q = holds[k + 1]!, s = dominant(p), u = dominant(q);
    // A pointer trail is no subject to share: it lies over whatever it crossed.
    const same = s && u && (s === u || (s.zone.type !== "path" && u.zone.type !== "path" && (inside(s.box, u.box) || inside(u.box, s.box))));
    if (Math.max(p.r.w, q.r.w) / Math.min(p.r.w, q.r.w) >= 2 || !same) { k++; continue; }
    const r = during({ ...p, b: q.b }).every(x => shows(p.r, x.box, 0)) ? p.r : q.r;
    holds.splice(k, 2, { a: p.a, b: q.b, r, why: `merged (${r === p.r ? "earlier" : "later"})` });
    k = Math.max(0, k - 1);
  }
  edgeSafe(holds.filter(h => h.why.startsWith("merged")));

  // Hold-to-hold moves. Every edge moves monotonically between the two framings (zoom about
  // their common fixed point, eased in ln w), so anything both show stays whole throughout.
  const lerp = (A: Rect, B: Rect, s: number): Rect => {
    const z = Math.log(B.w / A.w), g = Math.abs(z) < 1e-6 ? s : (A.w * Math.exp(z * s) - A.w) / (B.w - A.w);
    return { x: A.x + (B.x - A.x) * g, y: A.y + (B.y - A.y) * g, w: A.w + (B.w - A.w) * g, h: A.h + (B.h - A.h) * g };
  };
  const gates = (A: Rect, B: Rect, n: number) => {
    const f = Array.from({ length: n + 5 }, (_, i) => lerp(A, B, ease(clamp((i - 2) / n, 0, 1))));
    const rate = (v: number[]) => v.slice(1).map((x, i) => (x - v[i]!) * d.fps);
    const zv = rate(f.map(r => Math.log(r.w))), ax = rate(rate(f.map(r => K[0] * r.x / r.w))), ay = rate(rate(f.map(r => K[1] * r.y / r.h)));
    return zv.every(z => Math.abs(z) <= ZOOM_V) && rate(zv).every(z => Math.abs(z) <= ZOOM_A) && ax.every((x, i) => Math.hypot(x, ay[i]!) <= PAN_A);
  };
  const dirs = (A: Rect, B: Rect) => [Math.log(B.w / A.w) * 100, K[0] * (B.x / B.w - A.x / A.w), K[1] * (B.y / B.h - A.y / A.h)];
  let moves: { a: number; b: number }[];
  for (;;) {
    moves = holds.slice(1).map((q, k) => {
      const p = holds[k]!, gap = q.a - p.b;
      let n = 2;
      while (!gates(p.r, q.r, n)) n++;
      n = Math.max(n, Math.min(gap, Math.round(MOVE_MAX_S * d.fps)));
      const b = Math.min(N - 1, n <= gap ? q.a : Math.round((p.b + q.a + n) / 2));
      return { a: b - n, b };
    });
    // A hold its moves squeeze out, or too short between opposite moves, goes.
    const drop = holds.findIndex((h, k) => {
      if (k === 0 || k === holds.length - 1) return false;
      const left = T(moves[k]!.a) - T(moves[k - 1]!.b), i = dirs(holds[k - 1]!.r, h.r), o = dirs(h.r, holds[k + 1]!.r);
      return left < 0 || (left < v.minShot && i.some((x, j) => Math.abs(x) > 0.5 && Math.abs(o[j]!) > 0.5 && x * o[j]! < 0));
    });
    if (drop < 0) break;
    holds.splice(drop, 1);
  }
  const frames = solved.map((f, i): CameraFrame => {
    const k = moves.findIndex(m => i <= m.b), m = moves[k];
    const r = k < 0 ? holds.at(-1)!.r : i < m!.a ? holds[k]!.r : lerp(holds[k]!.r, holds[k + 1]!.r, ease((i - m!.a) / (m!.b - m!.a)));
    if (band) return { t: f.t, ...r };
    // The solver frame whose stage view is r (crop-to-fill shows a frame at its own size).
    let lo = 1, hi = 8 * st.w;
    for (let j = 0; j < 50; j++) { const w = (lo + hi) / 2; if (visible({ t: f.t, x: 0, y: 0, w, h: w * ratio }).w < r.w) lo = w; else hi = w; }
    return { t: f.t, x: r.x + r.w / 2 - ox - hi / 2, y: r.y + r.h / 2 - oy - hi * ratio / 2, w: hi, h: hi * ratio };
  });
  return { frames, holds };
}
