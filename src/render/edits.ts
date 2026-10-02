// One source-to-output clock for footage, camera, clicks and caption starts.
import type { CameraDefaults } from "../camera/defaults.ts";
import type { Beat, ManualZoom, TakeMeta } from "../camera/types.ts";
import { idleSqueezes } from "./pace.ts";

interface Span { t0: number; t1: number }
export interface EditSpan extends Span { rate: number; out: number }
export interface EditTimeline {
  spans: EditSpan[];
  duration: number;
  at: (source: number) => number;
  contains: (source: number) => boolean;
  filter: string;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
function fail(field: string): never { throw new Error(`take.json: invalid ${field}`); }
function range(value: unknown, field: string): asserts value is Span {
  const v = value as Span | null;
  if (!v || !finite(v.t0) || !finite(v.t1) || v.t0 < 0 || v.t1 <= v.t0) fail(field);
}
function list(value: unknown, field: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(field);
  return value;
}
function ordered<T extends Span>(spans: T[], field: string): T[] {
  const sorted = [...spans].sort((a, b) => a.t0 - b.t0);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.t0 < sorted[i - 1]!.t1) fail(`${field}: overlapping intervals`);
  }
  return sorted;
}

/** Validate at the JSON trust boundary, including edits outside the current trim. */
export function validateEdits(meta: TakeMeta): void {
  const cuts = list(meta.cuts, "cuts").map((v, i) => { range(v, `cuts[${i}]`); return v; });
  ordered(cuts, "cuts");
  const regions: Span[] = [];
  let typing = false;
  list(meta.speed, "speed").forEach((v, i) => {
    const s = v as { kind?: unknown; rate?: unknown } | null;
    if (!s || !finite(s.rate) || s.rate < 0.1 || s.rate > 16) fail(`speed[${i}].rate (0.1..16)`);
    if (s.kind === "type_speed") {
      if (typing || "t0" in s || "t1" in s) fail(`speed[${i}]: duplicate or timed type_speed`);
      typing = true;
    } else {
      if (s.kind !== undefined && s.kind !== "region") fail(`speed[${i}].kind`);
      range(s, `speed[${i}]`);
      regions.push(s);
    }
  });
  ordered(regions, "speed");
  validateZooms(meta.zooms, meta.width, meta.height);
}

export function validateZooms(zooms: unknown, width: number, height: number, minimumHold = 0.5): void {
  const spans = list(zooms, "zooms").map((v, i) => {
    range(v, `zooms[${i}]`);
    const z = v as ManualZoom;
    const b = z.bbox;
    if (z.t1 - z.t0 < minimumHold) fail(`zooms[${i}]: interval must allow a 0.5s hold`);
    if (!Array.isArray(b) || b.length !== 4 || !b.every(finite) || b[0] < 0 || b[1] < 0
      || b[2] <= 0 || b[3] <= 0 || b[0] + b[2] > width || b[1] + b[3] > height) fail(`zooms[${i}].bbox`);
    if (z.level !== undefined && (!Number.isInteger(z.level) || z.level < 0 || z.level > 3)) fail(`zooms[${i}].level`);
    return z;
  });
  ordered(spans, "zooms");
}

/** Cuts > explicit speed > typing speed > automatic idle speed. All intervals are half-open. */
export function editTimeline(meta: TakeMeta, beats: Beat[], start: number, end: number, d: CameraDefaults): EditTimeline {
  validateEdits(meta);
  if (!finite(start) || !finite(end) || start < 0 || end <= start) fail("trim");
  const cuts = meta.cuts ?? [];
  const regions = (meta.speed ?? []).filter(s => s.kind !== "type_speed");
  const typeRate = meta.speed?.find(s => s.kind === "type_speed")?.rate;
  const typing: Span[] = [];
  if (typeRate !== undefined) for (const beat of beats) for (const a of beat.actions) {
    const action = a as { k?: string; t0?: number; t1?: number };
    if (action.k === "type" && finite(action.t0) && finite(action.t1) && action.t1 > action.t0) {
      typing.push({ t0: action.t0 / 1000, t1: action.t1 / 1000 });
    }
  }
  const idle = idleSqueezes(beats, start, end, d).map(s => ({ t0: s.a + start, t1: s.b + start }));
  const boundaries = [...new Set([start, end, ...[...cuts, ...regions, ...typing, ...idle]
    .flatMap(s => [s.t0, s.t1]).filter(t => t > start && t < end)])].sort((a, b) => a - b);
  const spans: EditSpan[] = [];
  const includes = (s: Span, t: number) => t >= s.t0 && t < s.t1;
  let duration = 0;
  for (let i = 0; i + 1 < boundaries.length; i++) {
    const t0 = boundaries[i]!, t1 = boundaries[i + 1]!;
    const rate = cuts.some(s => includes(s, t0)) ? 0 : regions.find(s => includes(s, t0))?.rate
      ?? (typing.some(s => includes(s, t0)) ? typeRate! : idle.some(s => includes(s, t0)) ? d.idle_speed : 1);
    const previous = spans.at(-1);
    if (previous?.rate === rate) previous.t1 = t1;
    else spans.push({ t0, t1, rate, out: duration });
    if (rate > 0) duration += (t1 - t0) / rate;
  }
  if (duration <= 0) fail("cuts: no footage remains");
  const at = (t: number) => {
    if (t <= start) return 0;
    if (t >= end) return duration;
    const span = spans.find(s => includes(s, t))!;
    return span.out + (span.rate === 0 ? 0 : (t - span.t0) / span.rate);
  };
  const contains = (t: number) => spans.some(s => s.rate > 0 && includes(s, t));
  // Both expressions consume trim-relative seconds. Avoid rounding the clock:
  // sub-frame edits must not accumulate a JS/ffmpeg drift on long takes.
  const terms = spans.filter(s => s.rate !== 1).map(s =>
    `${s.rate === 0 ? 1 : 1 - 1 / s.rate}*clip(T-${s.t0 - start},0,${s.t1 - s.t0})`);
  const removed = spans.filter(s => s.rate === 0).map(s => `gte(t,${s.t0 - start})*lt(t,${s.t1 - start})`);
  const filter = "setpts=PTS-STARTPTS"
    + (removed.length ? `,select='not(${removed.join("+")})'` : "")
    + (terms.length ? `,setpts='(T-(${terms.join("+")}))/TB'` : "");
  return { spans, duration, at, contains, filter };
}

/** Remove discarded events, then warp every remaining timestamp on the same clock. */
export function editBeats(beats: Beat[], clock: EditTimeline, start: number): Beat[] {
  const s = (t: number) => start + clock.at(t);
  const ms = (t: number) => s(t / 1000) * 1000;
  return beats.flatMap(beat => {
    const t0 = s(beat.t0), t1 = s(beat.t1);
    if (t1 <= t0) return [];
    const actions = beat.actions.flatMap(action => {
      const a = action as { t?: number; t0?: number; t1?: number; path?: { t: number; x: number; y: number }[] };
      if (a.t !== undefined) return clock.contains(a.t / 1000) ? [{ ...a, t: ms(a.t) }] : [];
      if (a.t0 !== undefined && a.t1 !== undefined) {
        if (ms(a.t1) <= ms(a.t0)) return [];
        // Do not invent a drag press when its actual press was removed.
        if ((a as { k?: string }).k === "drag" && !clock.contains(a.t0 / 1000)) return [];
        return [{ ...a, t0: ms(a.t0), t1: ms(a.t1),
          ...(a.path ? { path: a.path.filter(p => clock.contains(p.t / 1000)).map(p => ({ ...p, t: ms(p.t) })) } : {}),
        }];
      }
      return [a];
    });
    return [{ ...beat, t0, t1, anchor_t: s(beat.anchor_t), actions,
      camera_suppressed: !clock.contains(beat.anchor_t),
      dialog_results: beat.dialog_results?.filter(result => clock.contains(result.t)).map(result => ({ ...result, t: s(result.t) })),
      zones: beat.zones.filter(zone => zone.t_change === undefined || clock.contains(zone.t_change))
        .map(zone => zone.t_change === undefined ? zone : { ...zone, t_change: s(zone.t_change) }),
      changed_frac: beat.changed_frac?.filter(sample => clock.contains(sample.t)).map(sample => ({ ...sample, t: s(sample.t) })),
    }];
  });
}

export function editZooms(zooms: ManualZoom[] | undefined, clock: EditTimeline, start: number): ManualZoom[] {
  return (zooms ?? []).flatMap(z => {
    const t0 = start + clock.at(z.t0), t1 = start + clock.at(z.t1);
    return t1 > t0 ? [{ ...z, t0, t1 }] : [];
  });
}
