import type { MotionTokens } from "./theme.ts";
import type { Scene, Screen } from "./types.ts";

export function bitmapSize(scr: Pick<Screen, "width" | "height">, width: number, height: number, peak = 1, cap = 1.5) {
  const fit = Math.max(width / scr.width, height / scr.height);
  const shrink = Math.min(1, cap / (fit * peak));
  return { width: width * shrink, height: height * shrink };
}

export function heroSize(scr: Pick<Screen, "width" | "height">, scene: Scene, W: number, H: number) {
  const phone = scene.device === "phone";
  const width = phone ? Math.min(W * .6, H * .3) : Math.min(W * .78, H * (scene.device === "none" ? .78 : .58) * scr.width / scr.height);
  return bitmapSize(scr, width, phone ? H * .52 : width * scr.height / scr.width, 1 + (scene.push ?? .03), 1);
}

/** Top of the hero device box: under the title block, or centred when the scene has no copy. */
export function heroTop(scene: Scene, H: number, height: number) {
  const bar = scene.device === "phone" ? .045 : (scene.device ?? "browser") === "browser" ? .075 : 0;
  return scene.title || scene.subtitle ? H * .34 : (H - height * (1 + bar) - (scene.device === "laptop" ? 24 : 4)) / 2;
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
