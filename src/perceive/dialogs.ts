// Recover the UI revealed when a dimmed dialog closes. Comparing only adjacent
// frames sees the scrim, not the new card or toast underneath it.
import type { BBox } from "../types.ts";
import { unionBBox } from "../types.ts";
import { CUT_FRAC, DIFF_THRESHOLD, diffRegions, type FramePairOpts } from "./regions.ts";

export interface DialogResult { t: number; bbox: BBox }

export function dialogResults(
  frames: Uint8Array[],
  times: number[],
  pointers: ([number, number] | null)[],
  geometry: Omit<FramePairOpts, "pointer">,
): DialogResult[] {
  const results: DialogResult[] = [];
  let board: Uint8Array | undefined;
  for (let i = 1; i < frames.length; i++) {
    const previous = frames[i - 1]!;
    const current = frames[i]!;
    let darker = 0;
    let lighter = 0;
    for (let pixel = 0; pixel < current.length; pixel++) {
      const difference = current[pixel]! - previous[pixel]!;
      if (difference <= -DIFF_THRESHOLD) darker++;
      if (difference >= DIFF_THRESHOLD) lighter++;
    }
    if (darker / current.length >= CUT_FRAC) {
      board = previous;
      continue;
    }
    if (!board || lighter / current.length < CUT_FRAC) continue;
    const change = diffRegions(board, current, { ...geometry, pointer: pointers[i] ?? null });
    board = undefined;
    // A different page becoming brighter is not a dialog dismissal. The board
    // must be restored outside the localized result. A cancel falls back wide.
    if (change.changed_frac >= CUT_FRAC) continue;
    const regions = change.regions.filter((region) => region.area_frac >= 0.001);
    const primary = [...regions].sort((a, b) => b.area_frac - a.area_frac)[0];
    // Inserting a card shifts its siblings. Keep that whole changed column,
    // rather than spanning it, a distant activity feed and a bottom toast.
    const subject = primary ? regions.filter((region) =>
      region.bbox[0] < primary.bbox[0] + primary.bbox[2]
      && region.bbox[0] + region.bbox[2] > primary.bbox[0]) : [];
    results.push({ t: times[i]!, bbox: subject.length
      ? subject.map((region) => region.bbox).reduce(unionBBox)
      : [0, 0, geometry.streamW, geometry.streamH] });
  }
  return results;
}
