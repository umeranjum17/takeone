// The story recipe: a plain brief in (no screenshot, no model), a 15-20 s film out. Each brief line is one beat: a headline whose
// second half takes the accent, and the product drawn beside it from the line's own rows (chips, phone chat, cards or stat tiles).
// Beats alternate dark and light and end on the brand's end card; every length is a whole frame, so the film is the same on every run.
import { readBrand } from "./brand.ts";
import { beatTimings } from "./reference.ts";
import { minSceneDuration, storySettle } from "./storyboard.ts";
import type { Scene } from "./types.ts";

export interface StoryArgs { pitch?: string; logo?: string; cta?: string; url?: string; brand?: string; theme?: string; workers?: number; /** A measured reference film's beats; each beat runs on to the next of these. */ beats?: number[] }

const LINE = /^(chips|phone|cards|stats)(?:\[([^\]]{1,40})\])?:\s*([^|]+?)\s*(?:\|\s*(.+))?$/i;
const grid = (s: number) => Math.ceil(s * 60 - 1e-9) / 60;

/** `kind[badge]: Headline / accent half | row; row; row`, one per line. A phone's first row is the question, the rest its answer. */
export function storyBeats(brief: string, name: string): Scene[] {
  return brief.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map((line, i) => {
    const m = LINE.exec(line);
    if (!m) throw new Error(`--recipe story line ${i + 1} must read "chips|phone|cards|stats[badge]: Headline / accent half | row; row; row", got ${line}`);
    const kind = m[1]!.toLowerCase(), [title, subtitle] = m[3]!.split(/\s*\/\s*/);
    return { pattern: "story", d: 0, kind, title: title!, ...(subtitle ? { subtitle } : {}), ...(m[2] ? { label: m[2] } : {}), tree: (m[4] ?? "").split(/\s*;\s*/).filter(Boolean), ...(kind === "phone" ? { text: name } : {}) } as Scene;
  });
}

export function planStory(a: StoryArgs, id: string, outputSize: readonly [number, number] = [1920, 1080]): unknown {
  const brand = a.brand ? readBrand(a.brand) : undefined, name = a.logo ?? brand?.name;
  if (!a.pitch?.trim() || !name) throw new Error('--recipe story needs the brief as --pitch "$(cat brief.txt)" (one beat per line) and --logo WORDMARK (or a --brand file with a name)');
  const beats = storyBeats(a.pitch, name);
  if (beats.length < 2 || beats.length > 5) throw new Error(`--recipe story takes 2 to 5 beats, got ${beats.length}`);
  const scenes: Scene[] = [...beats, { pattern: "end-card" as const, d: 0, logo: name, cta: a.cta ?? "Get started", ...(a.url ? { url: a.url } : {}), ...(brand?.logo ? { logo_image: brand.logo } : {}) }]
    .map((s, i) => ({ ...s, ...(i % 2 ? { invert: true } : {}), d: grid(Math.max(minSceneDuration(s), s.pattern === "story" ? storySettle(s) + .8 : 0)) }));
  if (a.beats?.length) beatTimings(scenes.map(s => s.d), a.beats).forEach((d, i) => { scenes[i]!.d = d; });
  return {
    version: 1, id, output: { out_w: outputSize[0], out_h: outputSize[1], ...(a.workers !== undefined ? { workers: a.workers } : {}) },
    theme: { name: a.theme ?? "midnight", overrides: brand?.overrides ?? {} }, source: { kind: "image", files: [] },
    screens: Object.create(null), regions: [], crops: {}, layout: { kind: "single" }, scenes, planner: { by: "local", abstained: [] },
  };
}
