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
  let dimmed: Uint8Array | undefined;
  let reference = frames[0];
  let referenceTime = times[0]!;
  for (let i = 1; i < frames.length; i++) {
    const current = frames[i]!;
    let darker = 0;
    for (let pixel = 0; pixel < current.length; pixel++) {
      const difference = current[pixel]! - reference![pixel]!;
      if (difference <= -DIFF_THRESHOLD) darker++;
    }
    if (!board && times[i]! - referenceTime <= 1000 && darker / current.length >= CUT_FRAC) {
      board = reference;
      dimmed = current;
      continue;
    }
    if (!board && times[i]! - referenceTime > 1000) {
      reference = frames[i - 1]!;
      referenceTime = times[i - 1]!;
      continue;
    }
    if (!board) continue;

    let restored = 0;
    for (let pixel = 0; pixel < current.length; pixel++) {
      if (current[pixel]! - dimmed![pixel]! >= DIFF_THRESHOLD) restored++;
    }
    if (!dimmed || restored / current.length < CUT_FRAC) continue;
    const change = diffRegions(board, current, { ...geometry, pointer: pointers[i] ?? null });
    reference = current;
    referenceTime = times[i]!;
    // A different page becoming brighter is not a dialog dismissal. The board
    // must be restored outside the localized result. A cancel falls back wide.
    if (change.changed_frac >= CUT_FRAC) continue;
    board = undefined;
    dimmed = undefined;
    const regions = change.regions.filter((region) => region.area_frac >= 0.001);
    results.push({ t: times[i]!, bbox: regions.length
      ? regions.map((region) => region.bbox).reduce(unionBBox)
      : [0, 0, geometry.streamW, geometry.streamH] });
  }
  return results;
}
