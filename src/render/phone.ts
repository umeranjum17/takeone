import type { Beat, Decision } from "../camera/types.ts";

/** Android's known tap coordinates outrank whole-screen changes from opening
 * dialogs. Each tap gets a settled shot; wide exports re-aim on the same row. */
export function phoneTapShots(beats: Beat[], width: number, height: number): { beats: Beat[]; decisions: Decision[] } | null {
  const taps = new Map<string, { t: number; x: number; y: number }>();
  for (const beat of beats) for (const action of beat.actions) {
    const a = action as { k?: string; t?: number; t0?: number; x?: number; y?: number; from?: [number, number]; to?: [number, number] };
    const tap = a.k === "click" && a.t !== undefined && a.x !== undefined && a.y !== undefined
      ? { t: a.t / 1000, x: a.x, y: a.y }
      : a.k === "drag" && a.t0 !== undefined && a.from && a.to
        && Math.hypot(a.from[0] - a.to[0], a.from[1] - a.to[1]) <= 12
        ? { t: a.t0 / 1000, x: a.from[0], y: a.from[1] } : null;
    if (tap) taps.set(`${tap.t}:${tap.x}:${tap.y}`, tap);
  }
  if (!taps.size) return null;
  const shots: Beat[] = [...taps.values()].sort((a, b) => a.t - b.t).map((tap, i) => ({
    id: `phone-tap-${i}`, kind: "click", t0: tap.t, t1: tap.t + 0.3, anchor_t: tap.t,
    actions: [{ k: "click", t: tap.t * 1000, x: tap.x, y: tap.y }],
    zones: [{ name: "tap", type: "act", bbox: [Math.max(0, Math.min(width - 128, tap.x - 64)),
      Math.max(0, Math.min(height - 128, tap.y - 64)), Math.min(128, width), Math.min(128, height)] }],
  }));
  return { beats: shots, decisions: shots.map(beat => ({ beat: beat.id, A: "tap", L: 2,
    p: 0, K: 1, conf: 1, decided_by: "android-tap" })) };
}
