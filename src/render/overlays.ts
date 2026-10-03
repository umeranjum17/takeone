import type { Beat, CameraFrame, Decision, TakeMeta } from "../camera/types.ts";
import type { CameraDefaults } from "../camera/defaults.ts";
import { assHeader, assTime, captionLayouts, drawing, roundRect, type Band, type Caption, type CaptionInk, type Stage } from "./stage.ts";

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
export interface KeycapObstacle { t0: number; t1: number; rect: Rect; kind?: "text" | "top-text" }
export interface KeycapCue {
  t0: number; t1: number; keys: string[]; cx: number; cy: number;
  w: number; h: number; size: number; widths: number[];
}

/** Project focus targets through the footage camera; reserve measured title and caption bounds. */
export function keycapObstacles(beats: Beat[], decisions: Decision[], frames: CameraFrame[], st: Stage,
  start: number, captions: Caption[], ink: CaptionInk[], d: CameraDefaults, widePhone = false,
  band?: Band | null, regions: TimedRegion[] = []): KeycapObstacle[] {
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
  // Privacy and spotlight regions are subjects too, even without a selected beat zone.
  for (const frame of frames) for (const region of regions) {
    if (frame.t < region.t0 || frame.t >= region.t1) continue;
    const [x, y, w, h] = region.rect;
    out.push({ t0: frame.t, t1: frame.t + 1 / d.fps, rect: [
      (x + st.screenX - frame.x) * d.out_w / frame.w,
      (y + st.screenY - frame.y) * d.out_h / frame.h,
      w * d.out_w / frame.w, h * d.out_h / frame.h,
    ] });
  }
  const layouts = captionLayouts(captions, ink, d, widePhone, band);
  captions.forEach((caption, i) => {
    const { cx, cy, w, h, rise } = layouts[i]!;
    const top = !band && widePhone && !caption.title && caption.position !== "bottom";
    out.push({ t0: caption.t0, t1: caption.t1, kind: top ? "top-text" : "text", rect: [cx - w / 2, cy - h / 2, w, h + rise] });
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
    const total = units.reduce((a, b) => a + b, 0) + (keys.length - 1) * (d.keycap_style === "mac" ? 0.18 : 0.65) + 0.9;
    const size = Math.min(d.out_h * 0.06, d.out_w * 0.88 / total);
    const widths = units.map(unit => unit * size);
    const w = total * size;
    const h = size * 2;
    const clearance = size * 0.75; // includes spring rise, bevel, shadow and a visible gap
    const blocked = obstacles.filter(o => o.t0 < t1 && o.t1 > t0);
    // One bottom-centre dock, above the measured text band; no floating over content.
    const captionTop = Math.min(d.out_h * 0.86, ...blocked
      .filter(o => o.kind === "text").map(o => o.rect[1]));
    const cx = d.out_w / 2, cy = captionTop - h / 2 - clearance * 1.5;
    const box: Rect = [cx - w / 2 - clearance, cy - h / 2 - clearance, w + 2 * clearance, h + 2 * clearance];
    const inside = box[0] >= 0 && box[1] >= 0 && box[0] + box[2] <= d.out_w && box[1] + box[3] <= d.out_h;
    // An occupied dock cannot safely show a keycap; never cover the subject.
    if (inside && !blocked.some(o => intersects(box, o.rect))) {
      cues.push({ t0, t1, keys, cx, cy, w, h, size, widths });
    }
  });
  return cues;
}

function keycapMotion(cue: KeycapCue, t: number, d: CameraDefaults) {
  const end = Math.min(cue.t1, t + 1 / d.fps);
  const elapsed = t - cue.t0 + 0.5 / d.fps;
  const spring = 1 - (1 + 18 * elapsed) * Math.exp(-18 * elapsed);
  return { end, scale: 0.9 + 0.1 * spring, rise: cue.size * 0.35 * (1 - spring),
    opacity: Math.min(1, elapsed / 0.10) * Math.min(1, (cue.t1 - t) / 0.25) };
}

/** A backdrop mask follows the pill's exact spring, hold and fade. */
export function keycapMaskAss(beats: Beat[], start: number, duration: number, d: CameraDefaults,
  obstacles: KeycapObstacle[] = []): string {
  let ass = assHeader(d.out_w, d.out_h, d.caption_font, d.caption_size);
  for (const cue of keycapCues(beats, start, duration, d, obstacles)) {
    for (let t = cue.t0; t < cue.t1; t += 1 / d.fps) {
      const { end, scale, rise, opacity } = keycapMotion(cue, t, d);
      ass += drawing(t, end, "#ffffff", 1 - opacity,
        roundRect(cue.cx - cue.w / 2 * scale, cue.cy - cue.h / 2 * scale + rise,
          cue.w * scale, cue.h * scale, cue.size * 0.48 * scale)).replace("\\p1}", "\\blur1\\p1}");
    }
  }
  return ass;
}

/** Frost the actual footage under the dock, without blurring the labels or captions. */
export function keycapBackdropGraph(duration: number, d: CameraDefaults, maskPath: string): string {
  return `[keycapInput]format=gbrp,split[keycapSharp][keycapBackdrop];`
    + `[keycapBackdrop]gblur=sigma=${8 * d.out_h / 1080}:steps=3[keycapFrost];`
    + `color=c=black:s=${d.out_w}x${d.out_h}:r=${d.fps}:d=${duration},format=yuv444p,ass=${maskPath},format=gray,format=gbrp[keycapMask];`
    + `[keycapSharp][keycapFrost][keycapMask]maskedmerge[keycapOutput]`;
}

/** Frame-stepped critical spring: soft entry, constant hold, quiet fade out. */
export function keycapAss(beats: Beat[], start: number, duration: number, d: CameraDefaults,
  obstacles: KeycapObstacle[] = []): string {
  let ass = assHeader(d.out_w, d.out_h, d.caption_font, d.caption_size);
  for (const cue of keycapCues(beats, start, duration, d, obstacles)) {
    const { cx, cy, w, h, size, keys, widths } = cue;
    for (let t = cue.t0; t < cue.t1; t += 1 / d.fps) {
      const { end, scale, rise, opacity } = keycapMotion(cue, t, d);
      const alpha = (clear: number) => 1 - (1 - clear) * opacity;
      const shape = (x: number, y: number, sw: number, sh: number, radius: number, colour: string,
        clear: number, layer: number, blur = 0) => {
        const path = roundRect(cx + (x - cx) * scale, cy + (y - cy) * scale + rise, sw * scale, sh * scale, radius * scale);
        return drawing(t, end, colour, alpha(clear), path, layer).replace("\\p1}", `\\blur${blur}\\p1}`);
      };
      const text = (label: string, x: number, y: number, fontSize: number, clear = 0) =>
        `Dialogue: 9,${assTime(t)},${assTime(end)},Default,,0,0,0,,{\\an5\\pos(${cx + (x - cx) * scale},${cy + (y - cy) * scale + rise})`
        + `\\fnInter SemiBold\\fs${fontSize}\\fscx${scale * 100}\\fscy${scale * 100}\\b0\\bord0\\shad0\\1a&H${Math.round(alpha(clear) * 255).toString(16).padStart(2, "0")}&}${label}\n`;
      const x0 = cx - w / 2, y0 = cy - h / 2;
      ass += shape(x0, y0 + size * 0.14, w, h, size * 0.48, "#000000", 0.85, 4, size * 0.14);
      ass += shape(x0, y0, w, h, size * 0.48, "#edf5ff", 0.82, 5);
      ass += shape(x0 + 1, y0 + 1, w - 2, h - 2, size * 0.46, "#17212e", 0.60, 5);
      let x = x0 + size * 0.45;
      keys.forEach((key, i) => {
        const kw = widths[i]!, kh = size * 1.35, ky = cy - kh / 2;
        ass += shape(x, ky + size * 0.09, kw, kh, size * 0.22, "#060b12", 0.90, 6, 1);
        ass += shape(x, ky, kw, kh, size * 0.22, "#e5efff", 0.82, 7);
        ass += shape(x + 1, ky + 2, kw - 2, kh - 3, size * 0.20, "#263241", 0.82, 8);
        ass += text(key, x + kw / 2, cy - size * 0.015, size);
        x += kw;
        if (i + 1 < keys.length && d.keycap_style !== "mac") {
          ass += text("+", x + size * 0.325, cy, size * 0.55, 0.25);
          x += size * 0.65;
        } else if (i + 1 < keys.length) x += size * 0.18;
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

/** White rounded holes on black, composited as a union and softly feathered. */
export function spotlightAss(regions: TimedRegion[], w: number, h: number, d: CameraDefaults,
  camera?: { frames: CameraFrame[]; stage: Stage }): string {
  let ass = assHeader(w, h, d.caption_font, d.caption_size);
  for (const region of regions) {
    // The camera's visible source bounds matter too: a hole must not hit an output edge.
    const views = camera ? camera.frames.filter(f => f.t < region.t1 && f.t + 1 / d.fps > region.t0)
      : [{ t: region.t0, x: 0, y: 0, w, h }];
    for (const view of views) {
      const px = Math.max(view.w / d.out_w, view.h / d.out_h);
      const inset = Math.min(6 * px, w / 4, h / 4);
      const vx = view.x - (camera?.stage.screenX ?? 0);
      const vy = view.y - (camera?.stage.screenY ?? 0);
      const [x, y, rw, rh] = region.rect;
      const left = Math.max(inset, x, vx + inset), top = Math.max(inset, y, vy + inset);
      const right = Math.min(w - inset, x + rw, vx + view.w - inset);
      const bottom = Math.min(h - inset, y + rh, vy + view.h - inset);
      if (right <= left || bottom <= top) continue;
      const radius = Math.min(12 * px, (right - left) / 2, (bottom - top) / 2);
      const frame = Math.round(view.t * d.fps);
      const t0 = Math.max(Math.ceil(region.t0 * d.fps), camera ? frame : 0) / 100;
      const t1 = Math.min(Math.ceil(region.t1 * d.fps), camera ? frame + 1 : Infinity) / 100;
      ass += drawing(t0, t1, "#ffffff", 0, roundRect(left, top, right - left, bottom - top, radius))
        .replace("\\p1}", `\\blur${3 * px}\\p1}`);
    }
  }
  return ass;
}

/** Keep the subject sharp; softly blur and cool-dim only its surroundings. */
export function spotlightGraph(regions: TimedRegion[], w: number, h: number, duration: number,
  d: CameraDefaults, maskPath: string): string {
  const active = regions.map(r => `gte(t,${r.t0})*lt(t,${r.t1})`).join("+");
  const sigma = 1.5 * Math.max(w / d.out_w, h / d.out_h);
  return `[spotlightInput]format=gbrp,split[spotlightSharp][spotlightBackdrop];`
    + `[spotlightBackdrop]gblur=sigma=${sigma},drawbox=c=0x172333@0.38:t=fill[spotlightDim];`
    + `color=c=black:s=${w}x${h}:r=${d.fps}:d=${duration},format=yuv444p,settb=1/100,setpts=N,ass=${maskPath},settb=1/${d.fps},setpts=N,format=gray,format=gbrp,negate[spotlightMask];`
    + `[spotlightSharp][spotlightDim][spotlightMask]maskedmerge=enable='${active}'[screen]`;
}

/** Blur only the selected source rectangle, before card/camera transforms. */
export function blurGraph(regions: TimedRegion[], pixelFormat: "yuv420p" | "yuv444p" = "yuv420p"): string {
  const graph: string[] = [];
  regions.forEach((r, i) => {
    const [x,y,w,h] = r.rect;
    // Round outward on the chroma grid so every requested pixel is covered.
    const rx = Math.floor(x/2)*2, ry = Math.floor(y/2)*2;
    const rw = Math.ceil((x+w)/2)*2-rx, rh = Math.ceil((y+h)/2)*2-ry;
    // Full-resolution RGB planes avoid narrow chroma-slice artifacts with many threads.
    graph.push(`[region${i}]split[base${i}][patch${i}]`,
      `[patch${i}]crop=${rw}:${rh}:${rx}:${ry},format=gbrp,gblur=sigma=20,format=${pixelFormat}[blur${i}]`,
      `[base${i}][blur${i}]overlay=${rx}:${ry}:format=${pixelFormat.slice(0, -1)}:enable='gte(t,${r.t0})*lt(t,${r.t1})'[region${i+1}]`);
  });
  return graph.join(";");
}
