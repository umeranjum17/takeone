import type { Beat, CameraFrame, Decision, TakeMeta } from "../camera/types.ts";
import type { CameraDefaults } from "../camera/defaults.ts";
import { assHeader, assTime, captionLayouts, drawing, roundRect, type Caption, type CaptionInk, type Stage } from "./stage.ts";

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

type Rect = [number, number, number, number];
export interface KeycapObstacle { t0: number; t1: number; rect: Rect }
export interface KeycapCue {
  t0: number; t1: number; keys: string[]; cx: number; cy: number;
  w: number; h: number; size: number; widths: number[];
}

/** Project focus targets through the same camera as the footage; reserve actual caption pills. */
export function keycapObstacles(beats: Beat[], decisions: Decision[], frames: CameraFrame[], st: Stage,
  start: number, captions: Caption[], ink: CaptionInk[], d: CameraDefaults, widePhone = false): KeycapObstacle[] {
  const out: KeycapObstacle[] = [];
  const byBeat = new Map(decisions.map(decision => [decision.beat, decision]));
  for (const frame of frames) {
    for (const beat of beats) {
      if (frame.t < beat.t0 - start - 0.3 || frame.t > beat.t1 - start + 0.3) continue;
      const decision = byBeat.get(beat.id);
      for (const zone of beat.zones) {
        if (zone.name !== decision?.A && zone.name !== decision?.B) continue;
        const [x, y, w, h] = zone.bbox;
        out.push({ t0: frame.t, t1: frame.t + 1 / d.fps, rect: [
          (x + st.screenX - frame.x) * d.out_w / frame.w,
          (y + st.screenY - frame.y) * d.out_h / frame.h,
          w * d.out_w / frame.w, h * d.out_h / frame.h,
        ] });
      }
    }
  }
  const layouts = captionLayouts(captions, ink, d, widePhone);
  captions.forEach((caption, i) => {
    const { cx, cy, w, h, rise } = layouts[i]!;
    out.push({ t0: caption.t0, t1: caption.t1, rect: [cx - w / 2, cy - h / 2, w, h + rise] });
  });
  return out;
}

const intersects = (a: Rect, b: Rect) =>
  a[0] < b[0] + b[2] && a[0] + a[2] > b[0] && a[1] < b[1] + b[3] && a[1] + a[3] > b[1];
const glyphs: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" };

/** A cue keeps one collision-free position for its entire hold, including camera moves. */
export function keycapCues(beats: Beat[], start: number, duration: number, d: CameraDefaults,
  obstacles: KeycapObstacle[] = []): KeycapCue[] {
  const hits = new Map<number, string[]>();
  for (const beat of beats) for (const action of beat.actions) {
    if (!action || typeof action !== "object") continue;
    const a = action as { k?: string; t?: number; combo?: unknown };
    if (a.k !== "shortcut" || !Number.isFinite(a.t)) continue;
    const keys = shortcutKeys(a.combo);
    const t = a.t! / 1000 - start;
    if (keys && t >= 0 && t < duration) hits.set(t, keys);
  }
  const sorted = [...hits].sort((a, b) => a[0] - b[0]);
  const cues: KeycapCue[] = [];
  sorted.forEach(([t0, names], i) => {
    const t1 = Math.min(t0 + 2.2, duration, sorted[i + 1]?.[0] ?? Infinity);
    const labels = d.keycap_style === "mac"
      ? ["Ctrl", "Alt", "Shift", "Meta"].filter(name => names.includes(name)).concat(names.at(-1)!) : names;
    const keys = labels.map(key => d.keycap_style === "mac" ? glyphs[key] ?? key : key);
    // Generous, bounded cells keep long named keys readable on narrow outputs.
    const units = keys.map(key => key.length * 0.65 + 1.1);
    const total = units.reduce((a, b) => a + b, 0) + (keys.length - 1) * 0.65 + 0.9;
    const size = Math.min(d.out_h * 0.06, d.out_w * 0.88 / total);
    const widths = units.map(unit => unit * size);
    const w = total * size;
    const h = size * 2;
    const clearance = size * 0.75; // includes spring rise, bevel, shadow and a visible gap
    const blocked = obstacles.filter(o => o.t0 < t1 && o.t1 > t0);
    const positions = [0.68, 0.52, 0.36, 0.20].flatMap(y =>
      [d.out_w / 2, d.out_w * 0.05 + w / 2, d.out_w * 0.95 - w / 2].map(cx => ({ cx, cy: d.out_h * y })));
    const position = positions.find(({ cx, cy }) => {
      const box: Rect = [cx - w / 2 - clearance, cy - h / 2 - clearance, w + 2 * clearance, h + 2 * clearance];
      return box[0] >= 0 && box[1] >= 0 && box[0] + box[2] <= d.out_w && box[1] + box[3] <= d.out_h
        && !blocked.some(o => intersects(box, o.rect));
    });
    // A fully occupied frame cannot safely show a keycap; never cover the subject.
    if (position) cues.push({ t0, t1, keys, ...position, w, h, size, widths });
  });
  return cues;
}

/** Frame-stepped critical spring: soft entry, constant hold, quiet fade out. */
export function keycapAss(beats: Beat[], start: number, duration: number, d: CameraDefaults,
  obstacles: KeycapObstacle[] = []): string {
  let ass = assHeader(d.out_w, d.out_h, d.caption_font, d.caption_size);
  for (const cue of keycapCues(beats, start, duration, d, obstacles)) {
    const { cx, cy, w, h, size, keys, widths } = cue;
    for (let t = cue.t0; t < cue.t1; t += 1 / d.fps) {
      const end = Math.min(cue.t1, t + 1 / d.fps);
      const elapsed = t - cue.t0 + 0.5 / d.fps;
      const spring = 1 - (1 + 18 * elapsed) * Math.exp(-18 * elapsed);
      const scale = 0.9 + 0.1 * spring;
      const rise = size * 0.35 * (1 - spring);
      const opacity = Math.min(1, elapsed / 0.10) * Math.min(1, (cue.t1 - t) / 0.25);
      const alpha = (clear: number) => 1 - (1 - clear) * opacity;
      const shape = (x: number, y: number, sw: number, sh: number, radius: number, colour: string,
        clear: number, layer: number, blur = 0) => {
        const path = roundRect(cx + (x - cx) * scale, cy + (y - cy) * scale + rise, sw * scale, sh * scale, radius * scale);
        return drawing(t, end, colour, alpha(clear), path, layer).replace("\\p1}", `\\blur${blur}\\p1}`);
      };
      const text = (label: string, x: number, y: number, fontSize: number, clear = 0) =>
        `Dialogue: 9,${assTime(t)},${assTime(end)},Default,,0,0,0,,{\\an5\\pos(${cx + (x - cx) * scale},${cy + (y - cy) * scale + rise})`
        + `\\fnArial\\fs${fontSize}\\fscx${scale * 100}\\fscy${scale * 100}\\b1\\bord0\\shad0\\1a&H${Math.round(alpha(clear) * 255).toString(16).padStart(2, "0")}&}${label}\n`;
      const x0 = cx - w / 2, y0 = cy - h / 2;
      ass += shape(x0, y0 + size * 0.14, w, h, size * 0.48, "#000000", 0.62, 4, size * 0.14);
      ass += shape(x0, y0, w, h, size * 0.48, "#edf5ff", 0.74, 5);
      ass += shape(x0 + 1, y0 + 1, w - 2, h - 2, size * 0.46, "#17212e", 0.16, 5);
      let x = x0 + size * 0.45;
      keys.forEach((key, i) => {
        const kw = widths[i]!, kh = size * 1.35, ky = cy - kh / 2;
        ass += shape(x, ky + size * 0.09, kw, kh, size * 0.22, "#060b12", 0.18, 6, 1);
        ass += shape(x, ky, kw, kh, size * 0.22, "#e5efff", 0.64, 7);
        ass += shape(x + 1, ky + 2, kw - 2, kh - 3, size * 0.20, "#263241", 0.09, 8);
        ass += text(key, x + kw / 2, cy - size * 0.015, size);
        x += kw;
        if (i + 1 < keys.length) {
          ass += text("+", x + size * 0.325, cy, size * 0.55, 0.25);
          x += size * 0.65;
        }
      });
    }
  }
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
