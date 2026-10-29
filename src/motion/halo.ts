// The halo recipe: real product screens and a one-line pitch in, a ~9 s promo out. No planner and no
// network: the caller names the real UI pieces (--region x,y,w,h:KIND@SCREEN, KIND = logo, row, stack, card or chips)
// and TakeOne lays them on the glow grammar, each beat at varied scales with overlap, shadow and parallax. The pitch is its sentences: the first is the pill's tagline, the
// rest are the kinetic lines.
import { resolve } from "node:path";
import { imageSize } from "./ingest.ts";
import { minSceneDuration } from "./storyboard.ts";
import type { Crop, Scene } from "./types.ts";

export interface GlowArgs { inputs: string[]; regions: string[]; pitch?: string; logo?: string; title?: string; cta?: string; url?: string; workers?: number }

const KINDS = ["logo", "row", "stack", "card", "chips"] as const;
const grid = (s: number) => Math.ceil(s * 60 - 1e-9) / 60;

/** "x,y,w,h:KIND[:TITLE]@SCREEN": a piece of a real screen, in that screen's own pixels. */
export function parsePiece(spec: string): { rect: [number, number, number, number]; kind: (typeof KINDS)[number]; title?: string; screen: string } {
  const m = /^(\d+),(\d+),(\d+),(\d+):(logo|row|stack|card|chips)(?::([^@]*))?(?:@(S\d+))?$/.exec(spec);
  if (!m) throw new Error(`--region for the halo recipe expects x,y,w,h:logo|row|stack|card|chips[:title][@S1], got ${spec}`);
  return { rect: [+m[1]!, +m[2]!, +m[3]!, +m[4]!], kind: m[5] as (typeof KINDS)[number], ...(m[6] ? { title: m[6] } : {}), screen: m[7] ?? "S1" };
}

export function planHalo(a: GlowArgs, id: string): unknown {
  if (!a.inputs.length || a.inputs.some(f => !/\.(png|jpe?g|webp)$/i.test(f))) throw new Error("--recipe halo takes screenshots (png, jpg or webp)");
  if (!a.pitch?.trim()) throw new Error("--recipe halo needs --pitch \"one line, in sentences: the tagline, then up to two kinetic lines\"");
  const sentences = a.pitch.split(/(?<=[.!?])\s+|\s*\|\s*/).map(s => s.trim()).filter(Boolean);
  const [tagline, ...lines] = sentences;
  if (lines.length > 3) throw new Error("--pitch holds a tagline and at most three kinetic lines");
  const sizes = a.inputs.map(f => imageSize(resolve(f)));
  const pieces = a.regions.map(parsePiece);
  const logo = pieces.find(p => p.kind === "logo");
  if (!logo) throw new Error("--recipe halo needs the logo as a piece: --region x,y,w,h:logo@S1");
  const crops: Record<string, Crop> = {};
  const crop = (key: string, p: ReturnType<typeof parsePiece>): string => {
    const size = sizes[Number(p.screen.slice(1)) - 1];
    if (!size) throw new Error(`${key}: ${p.screen} is not one of the ${sizes.length} input screens`);
    const [x, y, w, h] = p.rect;
    if (x + w > size.width || y + h > size.height) throw new Error(`${key}: ${p.rect.join(",")} lies outside ${p.screen} (${size.width}x${size.height})`);
    crops[key] = { screen: p.screen, rect: p.rect, exact: true };
    return key;
  };
  const mark = crop("mark", logo);
  const fit = (s: Scene, floor: number): Scene => ({ ...s, d: grid(Math.max(floor, minSceneDuration(s))) });
  const scenes: Scene[] = [fit({ pattern: "halo-open", d: 0, mark, title: tagline! }, 2.2)];
  // Consecutive pieces of one kind are one beat; a piece's title heads its beat.
  let n = 0;
  for (const p of pieces.filter(p => p.kind !== "logo")) {
    const last = scenes.at(-1);
    const items = [crop(`piece${++n}`, p)];
    if (last?.pattern === "halo-float" && last.kind === p.kind && !p.title) { last.items!.push(...items); continue; }
    // Chips straight after a card ride on its corners, smaller and nearer, instead of a beat of their own.
    if (last?.pattern === "halo-float" && last.kind === "card" && p.kind === "chips" && !p.title && last.items!.length < 5) { last.items!.push(...items); continue; }
    scenes.push({ pattern: "halo-float", d: 0, kind: p.kind, items, ...(p.title ? { title: p.title } : {}) });
  }
  for (const s of scenes) if (s.pattern === "halo-float") Object.assign(s, fit(s, 1 + 0.12 * s.items!.length));
  if (lines.length) scenes.push(fit({ pattern: "halo-lines", d: 0, lines }, 1));
  scenes.push(fit({ pattern: "halo-end", d: 0, mark, logo: a.logo ?? "TakeOne", ...(a.url ? { credit: a.url } : {}) }, 2));
  return {
    version: 1, id,
    output: { ...(a.workers !== undefined ? { workers: a.workers } : {}) },
    theme: { name: "midnight", overrides: {} },
    source: { kind: "image", files: a.inputs.map(f => resolve(f)) },
    screens: Object.create(null), regions: [], crops,
    layout: { kind: "single" }, scenes,
    planner: { by: "user", abstained: [] },
  };
}
