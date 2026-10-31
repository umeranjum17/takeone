// The bento launch-grid recipe: one real screen and a pitch in, one `bento-reel` scene out. The model writes the
// words, the demo figure, the feed rows and picks the screen lines shown as real UI; this module measures the
// screen and lays them on the 120 BPM grid. The tiles reflow between three grids inside the scene.
import { resolve } from "node:path";
import type { CallBudget } from "../decide/budget.ts";
import { clamp, line, planWithEngine, text, type EditorialArgs, type Grey, type Line } from "./editorial.ts";
import { minSceneDuration } from "./storyboard.ts";
import type { Crop, Rect, Scene } from "./types.ts";

const FIELDS = ["logo", "lead", "highlight", "kpi_label", "kpi_value", "feed", "shots", "payoff", "cta"] as const;

const ASK = "Plan a bento launch reel for this product from its pitch and the text lines read off one real screen. "
  + "Answer yes and give every field: "
  + "logo: the product name as its wordmark (at most 24 characters); "
  + "lead: the first words of a serif headline (2 to 4 words, no final words); "
  + "highlight: the 1 or 2 words that finish the headline, shown on a highlight wipe (at most 16 characters); "
  + "kpi_label: 2 to 4 words naming a demo figure the product could show, like earned this month; "
  + "kpi_value: that figure as a whole number from 1000 to 99999 (a demo figure, never claimed as real); "
  + "feed: 4 to 6 live events the product could show, each 2 to 5 words, each at most 32 characters, naming Umer as the demo person where a person fits; "
  + "shots: 2 or 3 distinct line ids from the screen, each a control, card or item inside the busiest part of the screen, never a header, search box or empty area; "
  + "payoff: the closing line, 2 to 6 words; "
  + "cta: the call to action on the end card, 1 to 3 words. "
  + "Write plain words from the pitch; never invent a feature the pitch or the screen does not show.";

/** Tiles reflow at thirds of the reel, on the beat: the reel is a fixed 12 s (24 beats at 120 BPM). */
const REEL_S = 12;

/** Pull a crop's edges off the text lines they cut: a line across the left or right edge is taken in whole, a line
 *  across the top or bottom edge is left out. Falls back to the planned crop when that would change its area by more than half. */
export function wholeLines(r: Rect, lines: Line[], W: number, H: number): Rect {
  let [x0, y0, x1, y1] = [r[0], r[1], r[0] + r[2], r[1] + r[3]];
  for (let pass = 0; pass < 4; pass++) for (const { box: [lx, ly, lw, lh] } of lines) {
    const [rx, by] = [lx + lw, ly + lh];
    if (ly < y1 && by > y0) { if (lx < x0 && rx > x0) x0 = Math.max(0, lx - 2); if (lx < x1 && rx > x1) x1 = Math.min(W, rx + 2); }
    if (lx < x1 && rx > x0) { if (ly < y0 && by > y0) y0 = Math.min(H, by + 2); if (ly < y1 && by > y1) y1 = Math.max(0, ly - 2); }
  }
  const out: Rect = [Math.round(x0), Math.round(y0), Math.round(x1 - x0), Math.round(y1 - y0)], ratio = out[2] * out[3] / (r[2] * r[3]);
  return out[2] > 0 && out[3] > 0 && ratio > 0.5 && ratio < 1.5 ? out : r;
}

/** The storyboard for checked answers. Pure: the same answers on the same screen give the same film. */
export function bentoStoryboard(a: EditorialArgs, id: string, size: { width: number; height: number }, lines: Line[], answer: Record<string, unknown>): unknown {
  const who = "bento", { width: W, height: H } = size;
  const feed = answer["feed"], shots = answer["shots"], value = answer["kpi_value"];
  if (!Array.isArray(feed) || feed.length < 4 || feed.length > 6 || feed.some(f => typeof f !== "string" || !f.trim() || f.length > 32 || f.trim().split(/\s+/).length > 5)) {
    throw new Error(`${who} planner: feed must be 4 to 6 rows of at most 5 words, got ${JSON.stringify(feed)}; rerun to ask again`);
  }
  if (!Array.isArray(shots) || shots.length < 2 || shots.length > 3 || new Set(shots).size !== shots.length) {
    throw new Error(`${who} planner: shots must be 2 or 3 distinct line ids, got ${JSON.stringify(shots)}; rerun to ask again`);
  }
  if (!Number.isInteger(value) || (value as number) < 1000 || (value as number) > 99999) throw new Error(`${who} planner: kpi_value must be a whole number from 1000 to 99999, got ${JSON.stringify(value)}; rerun to ask again`);
  // A real UI fragment: a window of the screen around the chosen line, wide enough to read at tile size.
  // Ingest snaps it to whole cards and controls, so no edge runs through a word.
  const crops: Record<string, Crop> = {};
  const shotIds = shots.map((sid, i) => {
    const l = line({ s: sid }, "s", lines, who), cw = Math.max(W * 0.26, l.box[2] * 1.5, l.box[3] * 10), ch = cw;
    crops[`shot${i + 1}`] = { screen: "S1", rect: wholeLines(clamp(l.box[0] + l.box[2] / 2 - cw / 2, l.box[1] + l.box[3] / 2 - ch / 2, cw, ch, W, H), lines, W, H) };
    return `shot${i + 1}`;
  });
  const reel: Scene = { pattern: "bento-reel", d: REEL_S, title: text(answer, "lead", 2, 4, 40, who), subtitle: text(answer, "highlight", 1, 2, 16, who),
    label: text(answer, "kpi_label", 2, 4, 32, who), reel: { value: value as number, feed: feed.map(f => f.trim()), shots: shotIds }, cut: true };
  const fit = (s: Scene, floor: number): Scene => ({ ...s, d: Math.ceil(Math.max(floor, minSceneDuration(s)) * 2 - 1e-9) / 2 }); // on the 0.5 s beat
  if (minSceneDuration(reel) > REEL_S) throw new Error(`${who} planner: the reel copy is too long to read in ${REEL_S} s; rerun to ask again`);
  return {
    version: 1, id,
    output: { ...(a.workers !== undefined ? { workers: a.workers } : {}) },
    theme: { name: "editorial", overrides: {} },
    tempo: { bpm: 120, phase_s: 0, snap: "beat" },
    source: { kind: "image", files: [resolve(a.inputs[0]!)] },
    screens: Object.create(null), regions: [], crops,
    ...(a.audio ? { audio: { file: resolve(a.audio), volume: 0.6 } } : {}),
    layout: { kind: "single" },
    scenes: [reel,
      fit({ pattern: "statement", d: 0, title: text(answer, "payoff", 2, 6, 60, who), invert: true, cut: true }, 2.5),
      fit({ pattern: "end-card", d: 0, logo: a.logo ?? text(answer, "logo", 1, 4, 24, who), cta: a.cta ?? text(answer, "cta", 1, 3, 24, who), ...(a.url ? { url: a.url } : {}), cut: true }, 3.5)],
    planner: { by: "ai", abstained: [] },
  };
}

export function planBento(a: EditorialArgs, id: string, log: (line: string) => void, budget: CallBudget): Promise<unknown> {
  return planWithEngine("bento", a, ASK, FIELDS, (size, lines, answer, _grey: Grey) => bentoStoryboard(a, id, size, lines, answer), log, budget);
}
