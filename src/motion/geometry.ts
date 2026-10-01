import type { Scene, Screen } from "./types.ts";

export function bitmapSize(scr: Pick<Screen, "width" | "height">, width: number, height: number, peak = 1, cap = 1.5) {
  const fit = Math.max(width / scr.width, height / scr.height);
  const shrink = Math.min(1, cap / (fit * peak));
  return { width: width * shrink, height: height * shrink };
}

export function heroSize(scr: Pick<Screen, "width" | "height">, scene: Scene, W: number, H: number) {
  const phone = scene.device === "phone";
  const width = phone ? Math.min(W * .6, H * .3) : Math.min(W * .78, H * .58 * scr.width / scr.height);
  return bitmapSize(scr, width, phone ? H * .52 : width * scr.height / scr.width, 1 + (scene.push ?? .03), 1);
}

export function heroTransform(t: number, duration: number, push: number) {
  const u = Math.max(0, Math.min(1, t / .6));
  const v = Math.max(0, Math.min(1, (t - .6) / Math.max(.001, duration - .6)));
  const a = v * v * v * (v * (v * 6 - 15) + 10);
  const b = u * u * u * (u * (u * 6 - 15) + 10);
  return { scale: t < .6 ? .96 + .04 * b : 1 + push * a, y: 30 * (1 - b) };
}
