// A beat's stable identity: a short hash of what the beat shows, not where it
// sits in the take. A plan edit names its beat by that key, so a re-cut that
// re-segments the take keeps the edit on the beat the user edited instead of
// moving it to whatever beat now sits in that place.
//
// The key is content: what the user did, and what appeared on screen. Times
// are left out on purpose - a trim moves a beat's place in the film but not
// what it shows. Two beats that show the same thing (the same click twice in
// the same window) get the same content and are told apart by their order,
// so a re-cut that removes one of them changes the other's key and the edit is
// dropped in the open rather than landing on the wrong beat.

import type { Action, Beat } from "../types.ts";

/** What one action did, without when it happened. */
function actionContent(a: Action): string {
  switch (a.k) {
    case "click": return `click:${a.x},${a.y}${a.double ? ":2" : ""}`;
    case "drag": return `drag:${a.from[0]},${a.from[1]}>${a.to[0]},${a.to[1]}`;
    case "scroll": return `scroll:${a.x},${a.y},${a.dx},${a.dy}`;
    case "type": return `type:${a.region ? a.region.map((n) => Math.round(n)).join(",") : ""}`;
    case "shortcut": return `shortcut:${a.combo}`;
    case "focus": return `focus:${a.cls}`;
    case "dwell": return `dwell:${a.x},${a.y}`;
    case "travel": return `travel:${a.from[0]},${a.from[1]}>${a.to[0]},${a.to[1]}`;
    case "cut": return "cut";
  }
}

/**
 * What a beat shows, without its place in the take: the actions the user made,
 * or - for a take with no input events - the regions that appeared on screen.
 * Empty for a beat with neither: a pause, named by what comes after it.
 */
function beatContent(beat: Beat): string {
  if (beat.actions.length > 0) {
    return `${beat.kind}|${beat.window_cls}|${beat.actions.map(actionContent).join(";")}`;
  }
  const shown = (beat.results ?? [])
    .map((r) => r.bbox.map((n) => Math.round(n)).join(","))
    .join(";");
  return shown === "" ? "" : `${beat.kind}|${beat.window_cls}|${shown}`;
}

/** FNV-1a, 32 bit: a short stable hash, no dependency and no clock. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Give every beat its stable key. Beats that show the same thing are told
 * apart by their order in the take, and a key that would repeat inside one
 * take is hashed again, so a key always names one beat and only one.
 */
export function assignBeatKeys(beats: Beat[]): void {
  const content = beats.map(beatContent);
  // A pause is named by the next beat that shows something: the same gap
  // before the same moment is the same beat after a re-cut.
  const anchor = (i: number): string => {
    for (let j = i + 1; j < content.length; j++) if (content[j] !== "") return content[j]!;
    return "end";
  };
  const seen = new Map<string, number>();
  const used = new Set<string>();
  beats.forEach((beat, i) => {
    const base = content[i] === "" ? `pause|${beat.window_cls}|before:${anchor(i)}` : content[i]!;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    let salt = 0;
    let key = `k${hash(`${base}#${n}`)}`;
    while (used.has(key)) {
      salt++;
      key = `k${hash(`${base}#${n}#${salt}`)}`;
    }
    used.add(key);
    beat.key = key;
  });
}
