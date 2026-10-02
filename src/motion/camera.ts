import type { CameraFrame } from "../camera/types.ts";
import { bentoViewport, bitmapSize, heroSize, heroTransform } from "./geometry.ts";
import { allTimelines } from "./layout.ts";
import { readingFloor } from "./storyboard.ts";
import { motionTokens } from "./theme.ts";
import type { Storyboard } from "./types.ts";

export function cameraViewport(sb: Storyboard, list: number) {
  const tokens = motionTokens(sb.theme.name, sb.theme.overrides);
  const { out_w: W, out_h: H } = sb.output;
  if (sb.layout.kind === "single") return {width:W,height:H};
  return bentoViewport(W, H, tokens, sb.layout.grid, list);
}

export function sceneCameras(sb: Storyboard): Record<string, (CameraFrame & { caption?: string; output?: CameraFrame })[]> {
  const paths: Record<string, (CameraFrame & { caption?: string; output?: CameraFrame })[]> = {};
  const minShot = motionTokens(sb.theme.name, sb.theme.overrides).min_shot;
  const lists = allTimelines(sb.layout, sb.scenes);
  lists.forEach((scenes, list) => scenes.forEach((scene, i) => {
    if (scene.pattern !== "zoom-tour" && scene.pattern !== "hero-reveal") return;
    const screen = sb.screens[scene.screen ?? Object.keys(sb.screens)[0]!]!;
    if (!screen) throw new Error(`${scene.pattern}: screen missing`);
    const key = sb.layout.kind === "single" ? String(i) : sb.layout.grid === "2x2" ? `master:${i}` : `${["A", "B", "C", "D"][list]}:${i}`;
    const {width,height} = cameraViewport(sb,list);
    if (scene.pattern === "hero-reveal") {
      const push = scene.push ?? .03;
      const need = .6 + Math.max(1.875 * push, Math.sqrt((5.774 * push + 3.516 * push * push) / 4));
      if (scene.d < need) throw new Error(`hero-reveal.d: needs ${need.toFixed(2)} s for bounded push`);
      const border = scene.device === "laptop" ? 12 : 2;
      const size = heroSize(screen, scene, width, height);
      const fit = scene.device === "phone" ? Math.max(size.width / screen.width, size.height / screen.height) : size.width / screen.width;
      const region = scene.focus ? sb.regions.find(r => r.id === scene.focus) : undefined;
      const ox = region ? (region.rect[0] + region.rect[2] / 2) / screen.width : .5;
      const oy = region ? (region.rect[1] + region.rect[3] / 2) / screen.height : .5;
      const bar = scene.device === "phone" ? size.height * .045 : (scene.device ?? "browser") === "browser" ? size.height * .075 : 0;
      const cropX = (screen.width * fit - size.width) / 2, cropY = (screen.height * fit - size.height) / 2;
      paths[key] = Array.from({ length: Math.ceil(scene.d * sb.output.fps) + 1 }, (_, f) => {
        const t = f / sb.output.fps, p = heroTransform(t, scene.d, scene.push ?? .03);
        const left = (width - size.width) / 2 + (size.width + 2 * border) * ox * (1 - p.scale) + border * p.scale;
        const top = height * .34 + p.y + (size.height + bar + 2 * border) * oy * (1 - p.scale) + (bar + border) * p.scale;
        return { t, x: (cropX * p.scale - left) / (fit * p.scale), y: (cropY * p.scale - top) / (fit * p.scale), w: width / (fit * p.scale), h: height / (fit * p.scale) };
      });
      return;
    }
    const full = { x: 0, y: 0, w: screen.width, h: screen.height };
    const requested = Math.min(width * .88, height * .65 * screen.width / screen.height);
    const size = bitmapSize(screen, requested, requested * screen.height / screen.width);
    const stops = scene.stops ?? [];
    const holds = stops.map(s => Math.max(minShot, s.hold ?? 0, readingFloor(s.caption ?? "")));
    const targets = stops.map(s => {
      const r = sb.regions.find(r => r.id === s.region)!;
      if (r.screen !== (scene.screen ?? Object.keys(sb.screens)[0])) throw new Error("zoom-tour: stops must belong to the scene screen");
      const aspect = screen.width / screen.height;
      const w = Math.min(screen.width, Math.max(r.rect[2] * 1.3, r.rect[3] * 1.3 * aspect, size.width));
      const h = w / aspect;
      return { x: Math.max(0, Math.min(screen.width - w, r.rect[0] + r.rect[2] / 2 - w / 2)), y: Math.max(0, Math.min(screen.height - h, r.rect[1] + r.rect[3] / 2 - h / 2)), w, h };
    });
    const segments: { at: number; d: number; from: typeof full; to: typeof full; caption: string }[] = [];
    let at = .4, from = full;
    [...targets, ...(targets.length ? [full] : [])].forEach((to, j) => {
      const dw = to.w - from.w, minW = Math.min(from.w, to.w);
      const ratio = Math.abs(dw) / minW;
      const pan = size.width * Math.hypot((to.x - from.x) * from.w - from.x * dw, (to.y - from.y) * from.w - from.y * dw) / (minW * minW);
      const d = Math.max(1.4, 1.875 * ratio, Math.sqrt((5.774 * ratio + 3.516 * ratio * ratio) / 4), Math.sqrt(pan * (5.774 + 7.032 * ratio) / 9000));
      segments.push({ at, d, from, to, caption: stops[j]?.caption ?? "" });
      at += d + (holds[j] ?? 0);
      from = to;
    });
    if (scene.d + 1e-9 < at) throw new Error(`zoom-tour.d: needs ${at.toFixed(2)} s for bounded moves and reading holds`);
    paths[key] = Array.from({ length: Math.ceil(scene.d * sb.output.fps) + 1 }, (_, f) => {
      const t = f / sb.output.fps;
      let view = full, caption = "";
      for (const segment of segments) {
        if (t < segment.at) break;
        const u = Math.min(1, (t - segment.at) / segment.d), a = u * u * u * (u * (u * 6 - 15) + 10), { from, to } = segment;
        const w = from.w + (to.w - from.w) * a;
        view = { x: from.x + (to.x - from.x) * a, y: from.y + (to.y - from.y) * a, w, h: w * screen.height / screen.width };
        if (t >= segment.at + segment.d) caption = segment.caption;
      }
      const border = scene.device === "laptop" ? 12 : 2;
      const bar = (scene.device ?? "browser") === "browser" ? size.height * .075 : scene.device === "phone" ? size.height * .045 : 0;
      const left = (width - size.width) / 2 + border, top = height * .08 + border + bar;
      return { t, ...view, caption, output: { t, x: view.x - left * view.w / size.width, y: view.y - top * view.w / size.width, w: width * view.w / size.width, h: height * view.w / size.width } };
    });
  }));
  return paths;
}
