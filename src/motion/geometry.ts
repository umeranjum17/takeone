import type { MotionTokens } from "./theme.ts";
import type { Scene, Screen } from "./types.ts";

export function bitmapSize(scr: Pick<Screen, "width" | "height">, width: number, height: number, peak = 1, cap = 1.5) {
  const fit = Math.max(width / scr.width, height / scr.height);
  const shrink = Math.min(1, cap / (fit * peak));
  return { width: width * shrink, height: height * shrink };
}

export function heroSize(scr: Pick<Screen, "width" | "height">, scene: Scene, W: number, H: number) {
  const phone = scene.device === "phone";
  if (phone) {
    // The phone frame fits the captured screen: the whole screen shows AND fills the frame,
    // never letterboxed. Fit the screen aspect inside the hero footprint.
    const width = Math.min(W * .6, H * .3, H * .52 * scr.width / scr.height);
    return bitmapSize(scr, width, width * scr.height / scr.width, 1 + (scene.push ?? .03), 1);
  }
  const width = Math.min(W * .78, H * .58 * scr.width / scr.height);
  return bitmapSize(scr, width, width * scr.height / scr.width, 1 + (scene.push ?? .03), 1);
}

export function heroTransform(t: number, duration: number, push: number) {
  const u = Math.max(0, Math.min(1, t / .6));
  const v = Math.max(0, Math.min(1, (t - .6) / Math.max(.001, duration - .6)));
  const a = v * v * v * (v * (v * 6 - 15) + 10);
  const b = u * u * u * (u * (u * 6 - 15) + 10);
  return { scale: t < .6 ? .96 + .04 * b : 1 + push * a, y: 30 * (1 - b) };
}

export function bentoViewport(W: number, H: number, t: MotionTokens, grid: "2x2" | "pinwheel-3x2", list: number) {
  const sx = W / 1920, sy = H / 1080;
  const iw = W - 2 * t.margin_x * sx, ih = H - 2 * t.margin_y * sy;
  const gx = t.gutter_x * sx, gy = t.gutter_y * sy;
  const unit = (iw - (grid === "2x2" ? gx : 2 * gx)) / (grid === "2x2" ? 2 : 3);
  const height = (ih - gy) / 2;
  if (unit <= 0 || height <= 0) throw new Error("layout: bento margins and gutters must leave positive tile width and height");
  return {width:grid === "2x2" || list === 1 || list === 2 ? unit : 2 * unit + gx,height};
}

/** spotlight and feature-callouts: each stop's start in scene seconds after a 0.8 s lead, and where the last one ends.
 *  A stop lasts the caption's reading floor (0.3 s a word plus 0.8 s) plus 0.9 s, never under 2.4 s. */
export function stopTimes(captions: string[], lead = .8) {
  let t = lead;
  const starts = captions.map(c => { const at = t; t += Math.max(2.4, .3 * c.trim().split(/\s+/).filter(Boolean).length + 1.7); return at; });
  return { starts, end: t };
}
