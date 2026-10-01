import type { Beat, TakeMeta } from "../camera/types.ts";
import type { CameraDefaults } from "../camera/defaults.ts";
import { assHeader, assTime, drawing, roundRect } from "./stage.ts";

const modifiers = ["Ctrl", "Alt", "Meta", "Shift"];
const names = new Set(["Esc", "Enter", "Backspace", "Tab", "Space", "Home", "End", "PageUp", "PageDown",
  "Up", "Down", "Left", "Right", "Insert", "Delete", "Minus", "Equal", "LeftBracket", "RightBracket",
  "Semicolon", "Apostrophe", "Grave", "Backslash", "Comma", "Dot", "Slash"]);

/** Fail closed: no free-form text, bare characters, or Shift-only typing. */
export function shortcutKeys(combo: unknown): string[] | null {
  if (typeof combo !== "string" || combo.length > 80) return null;
  const parts = combo.split("+");
  const key = parts.pop()!;
  if (!parts.length || !parts.some(p => p === "Ctrl" || p === "Alt" || p === "Meta")
    || parts.some(p => !modifiers.includes(p)) || new Set(parts).size !== parts.length) return null;
  if (!/^[A-Z0-9]$/.test(key) && !/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key) && !names.has(key)
    && !/^Key(?:[2-9]|[1-9][0-9]|1[0-9]{2})$/.test(key)) return null;
  return [...modifiers.filter(m => parts.includes(m)), key];
}

/** Only validated shortcut actions become text on the output clock. */
export function keycapAss(beats: Beat[], start: number, duration: number, d: CameraDefaults): string {
  const hits = new Map<number, string[]>();
  for (const beat of beats) for (const action of beat.actions) {
    if (!action || typeof action !== "object") continue;
    const a = action as { k?: string; t?: number; combo?: unknown };
    if (a.k !== "shortcut" || !Number.isFinite(a.t)) continue;
    const keys = shortcutKeys(a.combo);
    const t = a.t! / 1000 - start;
    if (keys && t >= 0 && t < duration) hits.set(t, keys);
  }
  let ass = assHeader(d.out_w, d.out_h, d.caption_font, d.caption_size);
  const sorted = [...hits].sort((a, b) => a[0] - b[0]);
  const size = Math.min(d.caption_size, d.out_w / 28);
  const gap = size * 0.28;
  sorted.forEach(([t, keys], i) => {
    const end = Math.min(t + 1.8, duration, sorted[i + 1]?.[0] ?? Infinity);
    const widths = keys.map(key => (key.length * 0.75 + 1.2) * size);
    let x = (d.out_w - widths.reduce((a, b) => a + b, 0) - gap * (keys.length - 1)) / 2;
    const y = d.out_h * 0.08;
    keys.forEach((key, j) => {
      const w = widths[j]!;
      // Output-space keycaps remain readable throughout camera motion and leave captions clear.
      ass += drawing(t, end, "#101217", 0.06, roundRect(x, y, w, size * 1.8, size * 0.3), 4);
      ass += `Dialogue: 5,${assTime(t)},${assTime(end)},Default,,0,0,0,,{\\an5\\pos(${x + w / 2},${y + size * 0.9})\\fs${size}\\bord0\\shad0\\fad(100,140)}${key}\n`;
      x += w + gap;
    });
  });
  return ass;
}

type OverlayRegion = NonNullable<TakeMeta["blur"]>[number];
export interface TimedRegion { t0: number; t1: number; rect: OverlayRegion["rect"] }

/** Region coordinates are source pixels; times are video seconds, mapped through trim/squeeze. */
export function overlayRegions(meta: TakeMeta, kind: "spotlight" | "blur", at: (t: number) => number,
  start: number, end: number): TimedRegion[] {
  const values = meta[kind];
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new Error(`invalid ${kind}: expected an array`);
  return values.flatMap((r, i) => {
    const fail = () => { throw new Error(`invalid ${kind}[${i}]: expected finite t, positive d and rect inside source`); };
    if (!r || !Number.isFinite(r.t) || !Number.isFinite(r.d) || r.d <= 0 || !Array.isArray(r.rect)
      || r.rect.length !== 4 || !r.rect.every(Number.isFinite)) return fail();
    const [x, y, w, h] = r.rect;
    if (x < 0 || y < 0 || w < 2 || h < 2 || x + w > meta.width || y + h > meta.height) return fail();
    const t0 = at(Math.max(start, r.t));
    const t1 = at(Math.min(end, r.t + r.d));
    return t1 > t0 ? [{ t0, t1, rect: r.rect }] : [];
  });
}

/** Union of active spotlights: inverse-clipped holes in a single dim mask. */
export function spotlightAss(regions: TimedRegion[], w: number, h: number, d: CameraDefaults): string {
  let ass = assHeader(w, h, d.caption_font, d.caption_size);
  const times = [...new Set(regions.flatMap(r => [r.t0, r.t1]))].sort((a,b) => a-b);
  for (let i = 0; i + 1 < times.length; i++) {
    const t0 = times[i]!, t1 = times[i + 1]!;
    const active = regions.filter(r => r.t0 <= t0 && r.t1 >= t1);
    if (!active.length) continue;
    // Inverse clip creates a union even where spotlight rectangles overlap.
    const holes = active.map(({rect:[x,y,rw,rh]}) => `m ${x} ${y} l ${x+rw} ${y} ${x+rw} ${y+rh} ${x} ${y+rh}`).join(" ");
    const mask = drawing(t0,t1,"#000000",0.42,`m 0 0 l ${w} 0 ${w} ${h} 0 ${h}`);
    ass += mask.replace("\\p1}", `\\iclip(${holes})\\p1}`);
  }
  return ass;
}

/** Blur only the selected source rectangle, before card/camera transforms. */
export function blurGraph(regions: TimedRegion[]): string {
  const graph: string[] = [];
  regions.forEach((r, i) => {
    const [x,y,w,h] = r.rect;
    // Round outward on the chroma grid so every requested pixel is covered.
    const rx = Math.floor(x/2)*2, ry = Math.floor(y/2)*2;
    const rw = Math.ceil((x+w)/2)*2-rx, rh = Math.ceil((y+h)/2)*2-ry;
    // Full-resolution RGB planes avoid narrow chroma-slice artifacts with many threads.
    graph.push(`[region${i}]split[base${i}][patch${i}]`,
      `[patch${i}]crop=${rw}:${rh}:${rx}:${ry},format=gbrp,gblur=sigma=20,format=yuv420p[blur${i}]`,
      `[base${i}][blur${i}]overlay=${rx}:${ry}:enable='gte(t,${r.t0})*lt(t,${r.t1})'[region${i+1}]`);
  });
  return graph.join(";");
}
