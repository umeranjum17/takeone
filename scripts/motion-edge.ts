/** First moment of a signed luminance step. Opposite slopes from resampling ringing and
 * codec noise cancel; taking absolute slopes incorrectly adds them to the edge mass.
 * This operates within one row/frame and performs no temporal smoothing. */
export function motionEdgePosition(row: Uint8Array, predicted: number): number | null {
  const lo = Math.max(1, Math.floor(predicted - 5));
  const hi = Math.min(row.length - 1, Math.ceil(predicted + 5));
  let contrast = 0, weighted = 0;
  for (let x = lo; x <= hi; x++) {
    const slope = row[x]! - row[x - 1]!;
    contrast += slope;
    weighted += (x - 0.5) * slope;
  }
  return Math.abs(contrast) >= 20 ? weighted / contrast : null;
}
