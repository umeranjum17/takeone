export type RubricId = "page" | "interaction" | "legibility" | "pacing" | "determinism" | "baseline";

export interface RubricItem {
  id: RubricId;
  label: string;
  weight: number;
  what: string;
}

export const DETERMINISM_TOLERANCE = 0.995;

/** The written bar the judge scores against. Weights are parts of 100. */
export const RUBRIC: RubricItem[] = [
  {
    id: "page",
    label: "Real page size in frame",
    weight: 20,
    what: "The captured product page is large enough to read at rest, not a small floating window on a stage. "
      + "The measured page area share is the fraction of the output frame the screen card covers.",
  },
  {
    id: "interaction",
    label: "Visible click and camera push-in",
    weight: 20,
    what: "A viewer can see the click or cursor, and the camera moves in on the interaction. "
      + "A click ripple with no pointer is partial; a pointer without a click is partial; a camera that never pushes in is partial.",
  },
  {
    id: "legibility",
    label: "Legible text, nothing cut off",
    weight: 20,
    what: "Every word the film draws is readable at 1080p and no text box crosses the safe area or leaves the frame. "
      + "In-page text counts: a page shown so small that its labels cannot be read is not legible.",
  },
  {
    id: "pacing",
    label: "Purposeful pacing",
    weight: 15,
    what: "No dead air and no rushed beat. The opening holds long enough to read, every move has a reason, "
      + "and the ending lands. A very short film is not penalised for its source length alone.",
  },
  {
    id: "determinism",
    label: "Deterministic re-render",
    weight: 15,
    what: `Rendering the same inputs again reproduces the same frames. The stated tolerance is at least ${Math.round(DETERMINISM_TOLERANCE * 1000) / 10}% of decoded frames identical.`,
  },
  {
    id: "baseline",
    label: "Better than the plain baseline",
    weight: 10,
    what: "Set beside the plain baseline render, the film is clearly better on the weak items: a larger page, "
      + "a visible click or cursor, and a camera that pushes in. Round one is the baseline; this item is scored from round two on.",
  },
];

export interface BaselineFacts {
  round: number;
  score: number;
  pageShare: number;
  cursorDrawn: boolean;
  clickOverlay: boolean;
  zoomAtClick: number;
}

export interface FrameFact {
  label: string;
  t: number;
  path: string;
  shows: string;
}

export interface MeasuredFacts {
  film: string;
  duration: number;
  frameCount: number;
  pageShare: number;
  stageMargin: number;
  pointerSamples: number;
  cursorFree: boolean;
  cursorDrawn: boolean;
  clickOverlay: boolean;
  clickCount: number;
  zoomAtClick: number;
  captionSize: number;
  captions: number;
  title: boolean;
  safeAreaFailures: number;
  beats: number;
  longestHold: number;
  determinism: { frames: number; identical: number; tolerance: number };
  frames: FrameFact[];
  baseline?: BaselineFacts;
}

export interface ItemScore {
  id: RubricId;
  label: string;
  weight: number;
  score: number;
  max: number;
  note: string;
}

export interface ScoreCard {
  score: number;
  items: ItemScore[];
  model: string;
  calls: number;
}

const clamp10 = (n: number) => Math.max(0, Math.min(10, n));

function cap(id: RubricId, f: MeasuredFacts): { max: number; note: string } {
  if (id === "page") {
    if (f.pageShare >= 0.97) return { max: 10, note: "page covers at least 97% of the frame" };
    if (f.pageShare >= 0.92) return { max: 8, note: `page covers ${(f.pageShare * 100).toFixed(1)}% of the frame; still leaves a stage margin` };
    if (f.pageShare >= 0.85) return { max: 6, note: `page covers ${(f.pageShare * 100).toFixed(1)}% of the frame; small at rest` };
    return { max: 4, note: `page covers only ${(f.pageShare * 100).toFixed(1)}% of the frame` };
  }
  if (id === "interaction") {
    if (f.pointerSamples === 0) return { max: 2, note: "the take has no pointer track, so no cursor or click can be drawn" };
    if (!f.cursorDrawn) return { max: 3, note: "pointer data exists but the rendered film draws no cursor" };
    if (!f.clickOverlay) return { max: 6, note: "the cursor is drawn but no click is emphasised" };
    if (f.zoomAtClick < 1.1) return { max: 9, note: `cursor and click are visible; the camera does not push in (zoom ${f.zoomAtClick.toFixed(2)}x)` };
    return { max: 10, note: `cursor and click are visible with a ${f.zoomAtClick.toFixed(2)}x camera push-in` };
  }
  if (id === "legibility") {
    if (f.safeAreaFailures > 0) return { max: 3, note: `${f.safeAreaFailures} text placements cross the safe area` };
    if (f.captions > 0 && f.captionSize < 24) return { max: 5, note: `caption type is only ${f.captionSize}px` };
    return { max: 10, note: "the render's safe-area check passed; no drawn text box is cut off" };
  }
  if (id === "pacing") {
    if (f.duration < 3) return { max: 4, note: `the film is only ${f.duration.toFixed(1)}s` };
    if (f.longestHold > 3.5) return { max: 6, note: `the longest actionless span is ${f.longestHold.toFixed(1)}s` };
    return { max: 10, note: `${f.duration.toFixed(1)}s across ${f.beats} beats; longest actionless span ${f.longestHold.toFixed(1)}s` };
  }
  if (id === "determinism") {
    const ratio = f.determinism.frames === 0 ? 0 : f.determinism.identical / f.determinism.frames;
    if (ratio >= f.determinism.tolerance) return { max: 10, note: `${f.determinism.identical}/${f.determinism.frames} decoded frames identical on a second render` };
    if (ratio >= 0.98) return { max: 6, note: `${f.determinism.identical}/${f.determinism.frames} decoded frames identical, below the ${(f.determinism.tolerance * 100).toFixed(1)}% tolerance` };
    return { max: 3, note: `${f.determinism.identical}/${f.determinism.frames} decoded frames identical, well below tolerance` };
  }
  const b = f.baseline!;
  const better = f.pageShare > b.pageShare + 0.01 || (f.cursorDrawn && !b.cursorDrawn) || (f.clickOverlay && !b.clickOverlay) || f.zoomAtClick > b.zoomAtClick + 0.1;
  return better
    ? { max: 10, note: `round ${b.round} baseline (${b.score.toFixed(1)}) is measurably weaker on page size, pointer or push-in` }
    : { max: 4, note: `no measured improvement over the round ${b.round} baseline (${b.score.toFixed(1)})` };
}

export function scoreCard(
  scores: Partial<Record<RubricId, number>>,
  facts: MeasuredFacts,
  model: string,
  calls: number,
): ScoreCard {
  const items: ItemScore[] = [];
  let total = 0;
  let weight = 0;
  for (const item of RUBRIC) {
    if (item.id === "baseline" && facts.baseline === undefined) continue;
    const raw = scores[item.id];
    if (raw === undefined || !Number.isFinite(raw)) throw new Error(`judge did not score ${item.id}`);
    const c = cap(item.id, facts);
    const value = clamp10(Math.min(raw, c.max));
    total += value * item.weight;
    weight += item.weight;
    items.push({ id: item.id, label: item.label, weight: item.weight, score: value, max: 10, note: c.note });
  }
  if (weight === 0) throw new Error("judge returned no usable item scores");
  return { score: Math.round((total / weight) * 10) / 10, items, model, calls };
}

