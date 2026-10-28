// A fast, low-resolution preview of the same film: the same camera path, a smaller
// source proxy and a smaller export. The preview exists so a look change (a theme,
// an aspect, a --set knob) can be seen in seconds instead of a full render's minutes.
import { existsSync, statSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { CameraDefaults } from "../camera/defaults.ts";
import type { Beat, CameraFrame, TakeMeta } from "../camera/types.ts";
import type { Event } from "../types.ts";
import { runFfmpeg } from "./ffmpeg.ts";
import type { Band } from "./stage.ts";

/** A preview export: the same aspect as the full render, at preview speed. */
export interface PreviewSpec {
  out_w: number;
  out_h: number;
  fps: number;
}

/** The preview's export size: the export's own aspect, the short edge at most 500 px.
 * The aspect is exact on purpose: the camera's window is mapped into the export, so
 * an export of a different aspect would frame the film differently. */
export function previewSize(out_w: number, out_h: number): { out_w: number; out_h: number } {
  const short = Math.min(out_w, out_h);
  const long = Math.max(out_w, out_h);
  for (let edge = Math.min(500, short); edge >= 2; edge--) {
    if (edge % 2) continue;
    const scaled = long * edge;
    if (scaled % short) continue;
    const other = scaled / short;
    if (other % 2) continue;
    return out_w <= out_h ? { out_w: edge, out_h: other } : { out_w: other, out_h: edge };
  }
  throw new Error("no even preview size keeps the export's aspect");
}

/** The preview's camera defaults: the export's look at preview scale. Sizes measured in
 * export pixels (captions, corners, shadows, the click ring) scale with the export;
 * the source-space and time constants do not. */
export function previewDefaults(d: CameraDefaults, out_w: number, out_h: number, fps: number): CameraDefaults {
  const scale = out_w / d.out_w;
  return {
    ...d,
    out_w,
    out_h,
    fps,
    motion_blur: 0,
    // A preview is a draft: a cheaper encode, so the loop is fast and the file is small.
    quality: "draft",
    preset: "veryfast",
    caption_size: Math.max(4, Math.round(d.caption_size * scale)),
    caption_border: d.caption_border * scale,
    corner_radius: d.corner_radius * scale,
    shadow_blur: d.shadow_blur * scale,
    shadow_x: d.shadow_x * scale,
    shadow_y: d.shadow_y * scale,
    border: d.border * scale,
    ripple_r: d.ripple_r * scale,
  };
}

/** The source proxy a preview warps from: the same film at 1080p on the short edge. */
export function proxySize(width: number, height: number): { w: number; h: number; scale: number } {
  const short = Math.min(width, height);
  const scale = short > 1080 ? 1080 / short : 1;
  return { w: 2 * Math.round((width * scale) / 2), h: 2 * Math.round((height * scale) / 2), scale };
}

/** The proxy file for a take, made once and reused by every later preview. The source
 * is the recording; a re-recorded take is newer than the proxy, so the proxy is remade.
 * `built` says whether this call paid for it. */
export async function ensureProxy(dir: string, width: number, height: number, w: number, h: number): Promise<{ file: string; built: boolean }> {
  const source = join(dir, "screen.webm");
  if (w === width && h === height) return { file: source, built: false };
  const target = join(dir, `proxy-${w}x${h}.mp4`);
  if (existsSync(target) && statSync(target).mtimeMs >= statSync(source).mtimeMs) return { file: target, built: false };
  const temp = `${target}.part`;
  await runFfmpeg(["-y", "-v", "error", "-i", source, "-vf", `scale=${w}:${h}:flags=lanczos`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
    "-movflags", "+faststart", "-f", "mp4", temp]);
  await rename(temp, target);
  return { file: target, built: true };
}

/** Where a preview's time went, in plain words: the camera solve runs at full resolution
 * (it is what keeps the framing identical) and is reused while nothing it reads has changed;
 * the proxy is paid once. */
export function previewTiming(t: { solve: number; solveCached: boolean; proxy: number; proxyBuilt: boolean; render: number }): string {
  const s = (n: number) => `${n.toFixed(1)}s`;
  return `preview timing: camera solve ${s(t.solve)} (${t.solveCached ? "reused from the last solve" : "full resolution, reused by later previews and renders"}), `
    + `proxy ${t.proxyBuilt ? `${s(t.proxy)} (built now, reused by later previews)` : "reused (cached)"}, `
    + `render ${s(t.render)}, total ${s(t.solve + t.proxy + t.render)}`;
}

/** Scale a source-pixel box to the proxy. */
function scaleBox(box: [number, number, number, number], scale: number): [number, number, number, number] {
  return [box[0] * scale, box[1] * scale, box[2] * scale, box[3] * scale];
}

/** Scale one recorded action to the proxy. Times are untouched; only the source-pixel
 * positions (the pointer, the drag path, the boxes) move with the source. */
function scaleAction(action: unknown, scale: number): unknown {
  if (!action || typeof action !== "object") return action;
  const a = action as Record<string, unknown>;
  const out: Record<string, unknown> = { ...a };
  if (typeof out["x"] === "number") out["x"] = out["x"] * scale;
  if (typeof out["y"] === "number") out["y"] = out["y"] * scale;
  for (const key of ["from", "to", "bbox", "whole_object"]) {
    const value = out[key];
    if (Array.isArray(value) && value.every(v => typeof v === "number")) {
      out[key] = (value as number[]).map(v => v * scale);
    }
  }
  const path = out["path"];
  if (Array.isArray(path)) {
    out["path"] = path.map(point => {
      const p = point as { t: number; x: number; y: number };
      return { ...p, x: p.x * scale, y: p.y * scale };
    });
  }
  return out;
}

/** Scale a beat's source-pixel geometry to the proxy. */
export function scaleBeat(beat: Beat, scale: number): Beat {
  return {
    ...beat,
    window_rect: beat.window_rect ? scaleBox(beat.window_rect, scale) : undefined,
    zones: beat.zones.map(zone => ({
      ...zone,
      bbox: scaleBox(zone.bbox, scale),
      boxes: zone.boxes?.map(box => scaleBox(box, scale)),
    })),
    actions: beat.actions.map(action => scaleAction(action, scale)),
    dialog_results: beat.dialog_results?.map(result => ({ ...result, bbox: scaleBox(result.bbox, scale) })),
  };
}

/** Scale a recorded event's source-pixel geometry to the proxy. */
export function scaleEvent(event: Event, scale: number): Event {
  if (event.k === "ptr") {
    return { ...event, x: event.x * scale, y: event.y * scale,
      hs: event.hs ? [event.hs[0] * scale, event.hs[1] * scale] : undefined };
  }
  if (event.k === "win" && event.rect) {
    return { ...event, rect: scaleBox(event.rect, scale) };
  }
  return event;
}

/** The take's own inputs in the proxy's source pixels. */
export function scaleMeta(meta: TakeMeta, scale: number, width: number, height: number): TakeMeta {
  const region = (r: { t: number; d: number; rect: [number, number, number, number] }) =>
    ({ ...r, rect: scaleBox(r.rect, scale) });
  return {
    ...meta,
    width,
    height,
    spotlight: meta.spotlight?.map(region),
    film: meta.film?.spotlight ? { ...meta.film, spotlight: meta.film.spotlight.map(region) } : meta.film,
    blur: meta.blur?.map(region),
  };
}

/** The camera path in the proxy's source pixels. The full render's path is solved at
 * full resolution, so the preview shows the same framing at the same timestamps. */
export function scaleFrames(frames: CameraFrame[], scale: number): CameraFrame[] {
  return frames.map(f => ({ t: f.t, x: f.x * scale, y: f.y * scale, w: f.w * scale, h: f.h * scale }));
}

/** The text band of the full render, scaled to the preview's export. The card keeps the
 * full render's proportions, so the preview frames the film exactly like the full render:
 * the card's own size is the only thing that changes. */
export function scaleBand(band: Band, scale: number): Band {
  const even = (value: number) => 2 * Math.round(value / 2);
  return {
    stage: {
      w: even(band.stage.w * scale),
      h: even(band.stage.h * scale),
      baseW: even(band.stage.baseW * scale),
      baseH: even(band.stage.baseH * scale),
      screenX: Math.round(band.stage.screenX * scale),
      screenY: Math.round(band.stage.screenY * scale),
      restScale: band.stage.restScale,
    },
    top: band.top * scale,
    titleY: band.titleY * scale,
    captionY: band.captionY * scale,
    // A row also gets the 2 px that rounding the preview's ceil'd text heights and rises can add.
    titleH: band.titleH ? band.titleH * scale + 2 : 0,
    captionH: band.captionH ? band.captionH * scale + 2 : 0,
  };
}
