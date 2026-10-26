import { applyDragVisibility, gesturePointer, gestures, type Gesture } from "./gesture.ts";
import { SWEEP_CLEARANCE } from "./sweep.ts";
import { fillWidth, minStageMargin, stageFrames, stageGeometry } from "../render/stage.ts";
import { PANEL_MAX_AREA, WIN_MAX_COVER } from "../beats/zones.ts";
import { DEFAULTS, type CameraDefaults } from "./defaults.ts";
import { unionBBox, type Action } from "../types.ts";
import type {
  Beat,
  CameraFrame,
  CameraState,
  Decision,
  TakeMeta,
  Zone,
} from "./types.ts";

interface Shot {
  beat: Beat;
  decision: Decision;
  zoneA: Zone;
  zoneB: Zone;
  arrival: number;
}

interface Target {
  t: number;
  state: CameraState;
  importance: number;
  p?: number;
  subject?: Zone;
  boxes?: Box[];
  /** End of the hold this target opens; the guard judges the frames it shows. */
  until?: number;
  startAfter?: number;
  /** Observed video-only subject: centre it once, rather than waiting for clipping. */
  screenChange?: boolean;
  /** A long-idle widen: quiet by definition, so exempt from the rate cap. */
  breathe?: boolean;
  /** A cut brings in the screen this shot frames: it replaces the page, so the shot arrives on time. */
  cut?: boolean;
  /** A disappearing subject cannot wait behind ordinary shot holds. */
  reveal?: { t: number; bbox: Zone["bbox"] };
  /** Position in the draft order; the emitted move graph keys guard windows by it. */
  draft: number;
}

interface Move {
  from: CameraState;
  to: CameraState;
  mid: CameraState;
  start: number;
  end: number;
  hop: boolean;
  /** Viewport preparation retains the preceding focus, without creating a new shot. */
  preparation?: boolean;
}

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const smooth = (u: number) => u * u * u * (u * (u * 6 - 15) + 10);
/** Centre progress for a zoom about the two views' shared fixed point: the centre moves in step
 * with the view width, so the projected page edge never turns back mid-move (the pan-bounce gate). */
const along = (wA: number, wB: number, w: number, u: number) =>
  Math.abs(Math.log(wB / wA)) < 1e-6 ? u : (w - wA) / (wB - wA);
/** The page origin's place on screen, per axis: the quality gate's pan measure. */
const origin = (f: CameraFrame, d: CameraDefaults) => [-f.x * d.out_w / f.w, -f.y * d.out_h / f.h] as const;
/** Whether the view moves between two output frames, by the quality gate's rest (1 output px/s of
 * page origin, 0.005 ln/s of zoom). */
function moving(p: CameraFrame, q: CameraFrame, d: CameraDefaults): boolean {
  const [px, py] = origin(p, d), [qx, qy] = origin(q, d);
  return Math.max(Math.abs(qx - px), Math.abs(qy - py)) * d.fps >= 1 || Math.abs(Math.log(q.w / p.w)) * d.fps >= 0.005;
}
/** Eased blend of two views: logarithmic zoom, centre along the fixed-point path. */
function blend(from: CameraState, to: CameraState, u: number): CameraState {
  const z = Math.exp(lerp(Math.log(from.z), Math.log(to.z), u)), s = along(1 / from.z, 1 / to.z, 1 / z, u);
  return { cx: lerp(from.cx, to.cx, s), cy: lerp(from.cy, to.cy, s), z };
}
const identity = (frame: CameraFrame): CameraFrame => frame;

type Box = Zone["bbox"];
/** Words a projected rectangle's edges cut (0 when clean), judged on the take's own source
 * pixels shown from `at` to `until`: the acceptance check's definition (no guard band, one
 * dense text stretch per cut word, see cutCount). */
export type EdgeCuts = (view: { x: number; y: number; w: number; h: number }, at: number, until: number) => number;
/** Largest surface a shot may slice: a panel or window this size cannot fit any crop. */
export const LABEL_AREA_MAX = 0.05;

/** The labels, controls and large surfaces a reveal must not slice; window chrome is dropped. */
function labelBoxes(beat: Beat, width: number, height: number): Box[] {
  const screen = width * height;
  return [...new Map(beat.zones
    .filter((zone) => !["all", "win", "path"].includes(zone.type))
    .flatMap((zone) => zone.boxes?.length ? zone.boxes : [zone.bbox])
    .filter((box) => box[2] * box[3] <= screen * PANEL_MAX_AREA)
    .map((box) => [box.join(), box])).values()];
}
export const HIGH_CLIP_FRACTION = 0.9;
/** Grid steps per axis for a readable push-in's edge search: about 1% of a 4K screen apart at a 2x crop. */
const READABLE_STEPS = 48;

/** Fraction of each UI box outside a crop. A hold permits whole boxes or tiny edge slivers. */
export function clippedFractions(view: Pick<CameraFrame, "x" | "y" | "w" | "h">, boxes: Box[]): number[] {
  return boxes.map(([x, y, w, h]) => {
    const visible = Math.max(0, Math.min(x + w, view.x + view.w) - Math.max(x, view.x))
      * Math.max(0, Math.min(y + h, view.y + view.h) - Math.max(y, view.y));
    const clipped = clamp(1 - visible / (w * h), 0, 1);
    return clipped < 1e-6 ? 0 : clipped;
  });
}

/** Enclosing perception panels take priority over the requested tightness. */
function withContext(zone: Zone, boxes: Box[], width: number, height: number, d: CameraDefaults): Zone {
  const baseW = baseWidth(width, height, d);
  const fits = (z: Zone) => z.bbox[2] <= baseW && z.bbox[3] <= baseW * d.out_h / d.out_w;
  let subject = zone;
  const [x, y, w, h] = zone.bbox;
  for (const box of boxes) {
    if (box[2] * box[3] <= w * h || box[2] * box[3] > width * height * 0.5) continue;
    const contains = x >= box[0] && y >= box[1]
      && x + w <= box[0] + box[2] && y + h <= box[1] + box[3];
    // A padded click can extend past its card, but its centre still belongs to it.
    const containsClick = zone.type === "act" && x + w / 2 >= box[0] && y + h / 2 >= box[1]
      && x + w / 2 <= box[0] + box[2] && y + h / 2 <= box[1] + box[3];
    if (contains || containsClick) subject = mergeZones(subject, { ...zone, bbox: box });
  }
  // A whole card alone can still leave a mostly empty shot. Keep its closest
  // separate surface when the gap is smaller than the focused surface itself.
  const [sx, sy, sw, sh] = subject.bbox;
  let neighbor: Box | undefined;
  let nearest = Infinity;
  for (const box of boxes) {
    // Nearby labels/cards add context; an unrelated sidebar or panel must not
    // expand a local subject to the whole screen.
    if (box[2] * box[3] > width * height * LABEL_AREA_MAX) continue;
    const dx = Math.max(sx - box[0] - box[2], box[0] - sx - sw, 0);
    const dy = Math.max(sy - box[1] - box[3], box[1] - sy - sh, 0);
    if (dx === 0 && dy === 0) continue; // enclosed or overlapping surfaces
    const gap = Math.hypot(dx, dy);
    if (gap <= Math.min(sw, sh) && gap < nearest) { neighbor = box; nearest = gap; }
  }
  if (neighbor && fits(mergeZones(subject, { ...zone, bbox: neighbor }))) subject = mergeZones(subject, { ...zone, bbox: neighbor });
  return subject;
}

/** Search edge-aligned crops at this zoom, then widen only if none can hold the UI whole. */
function compose(state: CameraState, subject: Zone, boxes: Box[], width: number, height: number, d: CameraDefaults,
  project: (frame: CameraFrame) => CameraFrame = identity, cuts?: EdgeCuts, at = 0, until = at): CameraState {
  const desired = toFrame(state, width, height, d);
  if ((!boxes.length && !cuts) || (desired.w >= width && desired.h >= height)) return state;
  const baseW = baseWidth(width, height, d);
  const screen = width * height;
  // Small boxes score the visible cluster; large known surfaces (a side rail,
  // a top bar) only constrain the edges. Dropping the large ones here parked
  // push-in edges mid-rail mid-word: the search below never saw the rail, so
  // no candidate aligned to it and nothing vetoed slicing it.
  const small = boxes.filter((box) => box[2] * box[3] <= screen * LABEL_AREA_MAX);
  const avoid = boxes.filter((box) => box[2] * box[3] > screen * LABEL_AREA_MAX
    && box[2] * box[3] <= screen * PANEL_MAX_AREA);
  const best = wholeCrop(desired.w, baseW, d.out_w / d.out_h, subject.bbox, small, width, height,
    (crop) => !cuts || cuts(project(crop), at, until) === 0, avoid, project, 0, cuts !== undefined);
  if (best) return { cx: best.x + best.w / 2, cy: best.y + best.h / 2, z: baseW / best.w };
  const [sx, sy, sw, sh] = subject.bbox;
  return cropped(width, height, d)
    ? { cx: sx + sw / 2, cy: sy + sh / 2, z: 1 } : { cx: width / 2, cy: height / 2, z: 1 };
}

/** The crop holding the subject that keeps every UI box whole (or all but a sliver out), from
 * width w0 up to maxW at a fixed aspect: edge-aligned positions at each width, the one that
 * best centres the visible cluster at the first width that has a clean one. `accept` can veto a crop.
 * `avoid` constrains the edges without scoring the cluster: a large surface the crop may hold
 * whole or leave out, never slice mid-text. Where the subject reaches into it, only the part of
 * the surface outside the subject's own extent is constrained. Within each width the search prefers a
 * crop whose edges sit fully clear of every box (snapping into the gap); the sliver-tolerant
 * crop is the fallback only when no width up to maxW has a clean one: a framing whose first
 * width offers only a sliver-tolerant crop now widens to the first clean crop. screenSnap
 * (motion tours) shares this search.
 * `project` maps a raw crop to what the viewer sees (the stage adds a margin around pushed-in
 * crops): the edge tests run on the projected crop, so a raw edge that looks clear but renders
 * inside a rail still fails. Positions and cluster scoring stay in raw camera space.
 * `step` adds positions that many pixels apart, for an `accept` with no boxes to align to.
 * `readable`: `accept` is a real no-cut-text check, so a crop at this width that holds the
 * subject whole and cuts no glyph may slice other boxes (a paragraph, a card beside the action)
 * rather than widen past them: a push-in crops its surroundings the way an editor would, and the
 * text check keeps every edge in a gap between words or lines. A box-clean crop still wins at
 * the same width. */
export function wholeCrop(w0: number, maxW: number, aspect: number, subject: Box, boxes: Box[], width: number, height: number,
  accept: (crop: CameraFrame) => boolean = () => true, avoid: Box[] = [],
  project: (frame: CameraFrame) => CameraFrame = identity, step = 0, readable = false): CameraFrame | undefined {
  const [sx, sy, sw, sh] = subject;
  const solid = avoid.flatMap((box): Box[] => {
    const [bx, by, bw, bh] = box;
    if (!(sx < bx + bw && sx + sw > bx && sy < by + bh && sy + sh > by)) return [box];
    const outside: Box[] = [
      [bx, by, sx - bx, bh],
      [sx + sw, by, bx + bw - sx - sw, bh],
      [bx, by, bw, sy - by],
      [bx, sy + sh, bw, by + bh - sy - sh],
    ];
    return outside.filter((rect) => rect[2] > 0 && rect[3] > 0);
  });
  const veto = [...boxes, ...solid];
  let fallback: CameraFrame | undefined;
  for (let w = w0; ; w = Math.min(maxW, w + maxW * 0.025)) {
    const h = w / aspect;
    const gap = Math.min(w, h) * 0.01;
    // The edge tests run on the projected crop, which the stage margin widens
    // past the raw edges: a raw edge aligned to a box still renders inside it,
    // so no clean position exists at this width and the search keeps widening
    // until the box fits whole. Align extra candidates so the PROJECTED edge
    // lands on the box instead — the crop snaps into the gap and stays a
    // close-up. Each axis projects independently of the other, so a fixed
    // point from the raw-aligned seed lands the rendered edge on its target
    // (off the screen-edge clamps); identity projection converges at once, so
    // these duplicate the raw candidates there.
    const frameFor = (axis: 0 | 1, p: number, view: number): CameraFrame => axis === 0
      ? { t: 0, x: p, y: clamp(sy + sh / 2 - h / 2, 0, Math.max(0, height - h)), w: view, h }
      : { t: 0, x: clamp(sx + sw / 2 - w / 2, 0, Math.max(0, width - w)), y: p, w, h: view };
    const alignEdge = (axis: 0 | 1, target: number, view: number, high: boolean): number => {
      let p = high ? target - view : target;
      for (let k = 0; k < 4; k++) {
        const seen = project(frameFor(axis, p, view));
        const edge = axis === 0
          ? (high ? seen.x + seen.w : seen.x)
          : (high ? seen.y + seen.h : seen.y);
        const shift = target - edge;
        if (Math.abs(shift) < 0.5) break;
        p += shift;
      }
      return p;
    };
    const positions = (s: number, span: number, view: number, size: number, axis: 0 | 1): number[] => {
      if (view >= size) return [(size - view) / 2];
      const low = Math.max(0, s + span + Math.min(gap, size - s - span) - view);
      const high = Math.min(size - view, s - Math.min(gap, s));
      if (low > high) return [];
      const candidates = [(low + high) / 2, low, high];
      for (let p = low + step; step > 0 && p < high; p += step) candidates.push(p);
      for (const box of veto) {
        const start = box[axis];
        const end = start + box[axis + 2]!;
        candidates.push(start - gap, end + gap, start - gap - view, end + gap - view,
          alignEdge(axis, start - gap, view, true), alignEdge(axis, end + gap, view, false));
      }
      return [...new Set(candidates.map((p) => clamp(p, low, high)))];
    };
    let best: CameraFrame | undefined;
    let bestScore = Infinity;
    let loose: CameraFrame | undefined;
    let looseScore = Infinity;
    const ys = positions(sy, sh, h, height, 1);
    for (const x of positions(sx, sw, w, width, 0)) {
      for (const y of ys) {
        const crop = { t: 0, x, y, w, h };
        const clips = clippedFractions(project(crop), veto);
        if (clips.some((f) => f > 0 && f < HIGH_CLIP_FRACTION)) continue;
        // Balance space around the visible cluster, rather than an isolated click.
        const visible = boxes.filter((_, i) => clips[i] === 0);
        let cluster = subject;
        for (const box of visible) cluster = unionBBox(cluster, box);
        const [cx, cy, cw, ch] = cluster;
        const score = Math.pow((x + w / 2 - cx - cw / 2) / w, 2)
          + Math.pow((y + h / 2 - cy - ch / 2) / h, 2);
        if (!accept(crop)) continue;
        if (score < looseScore) { loose = crop; looseScore = score; }
        if (clips.every((f) => f === 0 || f >= 1 - 1e-9) && score < bestScore) { best = crop; bestScore = score; }
      }
    }
    if (best) return best;
    if (readable) {
      const grid = (s: number, span: number, view: number, size: number): number[] => {
        if (view >= size) return [(size - view) / 2];
        const low = Math.max(0, s + span - view), high = Math.min(size - view, s);
        if (low > high) return [];
        const centre = clamp(s + span / 2 - view / 2, low, high);
        return [centre, ...Array.from({ length: READABLE_STEPS + 1 }, (_, i) => low + (high - low) * i / READABLE_STEPS)];
      };
      let readableCrop: CameraFrame | undefined, readableScore = Infinity;
      const gy = grid(sy, sh, h, height);
      for (const x of grid(sx, sw, w, width)) {
        for (const y of gy) {
          const score = Math.pow((x + w / 2 - sx - sw / 2) / w, 2) + Math.pow((y + h / 2 - sy - sh / 2) / h, 2);
          if (score >= readableScore) continue;
          const crop = { t: 0, x, y, w, h };
          if (accept(crop)) { readableCrop = crop; readableScore = score; }
        }
      }
      if (readableCrop) return readableCrop;
    }
    fallback ??= loose;
    if (w >= maxW) return fallback;
  }
}

/** A crop-to-fill export: even the widest view cannot show the whole screen at once. */
function cropped(width: number, height: number, d: CameraDefaults): boolean {
  const view = toFrame({ cx: 0, cy: 0, z: 1 }, width, height, d);
  return view.w < width || view.h < height;
}

/** Width of the output-aspect canvas the source sits in; z = 1 shows all of it.
 * A portrait, 4:5 or square cut from a wider screen plans on the crop-to-fill window it renders. */
export function baseWidth(width: number, height: number, d: CameraDefaults = DEFAULTS): number {
  const padded = Math.max(width, height * d.out_w / d.out_h);
  return d.out_h >= d.out_w ? fillWidth(width, height, stageGeometry(width, height, d), d) ?? padded : padded;
}

/** Deepest zoom, measured against the aspect-padded canvas, that keeps within max_upscale. */
export function zMax(width: number, height: number, d: CameraDefaults = DEFAULTS): number {
  return Math.max(1, baseWidth(width, height, d) / (d.out_w / d.max_upscale));
}

/** Describe manual requests reduced by the native-pixel upscale ceiling. */
export function manualZoomLimitWarning(take: TakeMeta, d: CameraDefaults = DEFAULTS): string | undefined {
  const limit = zMax(take.width, take.height, d);
  const uncappedDefaults = { ...d, max_upscale: 1e9 };
  const capped = (take.zooms ?? []).flatMap((zoom, index) => {
    const region: Zone = { name: "manual", type: "act", bbox: zoom.bbox };
    const requested = frame(region, zoom.level ?? 2, take.width, take.height, undefined, uncappedDefaults).z;
    if (requested <= limit + 1e-8) return [];
    const stage = stageGeometry(take.width, take.height, d);
    const state = frame(region, zoom.level ?? 2, take.width, take.height, undefined, d);
    const emitted = stageFrames([toFrame(state, take.width, take.height, d)], take.width, take.height, stage, d)[0]!;
    const achieved = baseWidth(take.width, take.height, d) / Math.min(emitted.w, stage.w, stage.h * d.out_w / d.out_h);
    return [`zoom ${index + 1}: requested ${requested.toFixed(2)}x, achieved ${achieved.toFixed(2)}x`];
  });
  return capped.length ? `Camera upscale limit capped manual framing (${capped.join("; ")}).` : undefined;
}

/** Convert a camera centre to an output-aspect viewport, allowing padded overscan. */
export function toFrame(
  state: CameraState,
  width: number,
  height: number,
  d: CameraDefaults,
): CameraFrame {
  const z = clamp(state.z, 1, zMax(width, height, d));
  const aspect = d.out_w / d.out_h;
  const nonWide = Math.abs(width / height - aspect) > 1e-9;
  // Keep the viewport at the output aspect; padded overscan shrinks with zoom.
  const w = nonWide ? baseWidth(width, height, d) / z : Math.min(width / z, height * aspect);
  const h = w / aspect;
  // An axis wider than the screen centres it (a phone card in a 16:9 frame);
  // an axis inside it clamps, so the shot never shows past the screen's edge.
  const place = (centre: number, view: number, size: number) =>
    nonWide && view > size ? (size - view) / 2 : clamp(centre - view / 2, 0, Math.max(0, size - view));
  const x = place(state.cx, w, width);
  const y = place(state.cy, h, height);
  return { t: 0, x, y, w, h };
}

/** A held framing must not rest showing a hairline of background at the border: snap it onto
 * the card (no margin) or onto a margin wide enough to read as one. The projection itself stays
 * continuous, so a move passes smoothly through the band instead of jumping. The snapped view is
 * re-judged by the guard, so the emitted hold is always one the guard accepts. */
function snapHairline(state: CameraState, width: number, height: number, d: CameraDefaults,
  project: (frame: CameraFrame) => CameraFrame, cuts?: EdgeCuts, at = 0, until = at): CameraState {
  if (project === identity) return state;
  const min = minStageMargin(width, d);
  const view = (z: number) => project(toFrame({ ...state, z }, width, height, d));
  const clean = (z: number) => !cuts || cuts(view(z), at, until) === 0;
  const widthAt = (z: number) => view(z).w;
  const hairline = (w: number) => w > width && w < width + 2 * min;
  if (!hairline(widthAt(state.z)) && clean(state.z)) return state;
  const top = zMax(width, height, d);
  const zFor = (target: number): number => {
    let lo = 1, hi = top;
    for (let i = 0; i < 40; i++) { const z = (lo + hi) / 2; if (widthAt(z) > target) lo = z; else hi = z; }
    return (lo + hi) / 2;
  };
  const down = zFor(width), up = zFor(width + 2 * min);
  const first = Math.abs(Math.log(down / state.z)) <= Math.abs(Math.log(up / state.z)) ? down : up;
  if (clean(first)) return { ...state, z: first };
  const second = first === down ? up : down;
  if (clean(second)) return { ...state, z: second };
  // No zoom headroom (top 1, e.g. a 1080p source in a 4:5 crop): a zero step would never end.
  for (let z = up, step = (top - 1) / 200 || 1; z >= 1; z -= step) if (clean(z)) return { ...state, z };
  return { ...state, z: 1 };
}

/** Expand a zone at its requested tightness, preserving output aspect and zoom bounds. */
export function frame(
  zone: Zone,
  level: number,
  width: number,
  height: number,
  windowRect?: [number, number, number, number],
  d: CameraDefaults = DEFAULTS,
  project: (frame: CameraFrame) => CameraFrame = identity,
  cuts?: EdgeCuts,
  at = 0,
  until = at,
): CameraState {
  if (level === 0 || zone.type === "all") {
    return { cx: width / 2, cy: height / 2, z: 1 };
  }

  const boxes = zone.boxes ?? [];
  zone = withContext(zone, boxes, width, height, d);

  const [x, y, zoneW, zoneH] = zone.bbox;
  // A fullscreen window gives no context framing (L1 would be the whole
  // screen), so L1 pads the zone instead, as zones.ts drops such a `win`.
  if (windowRect && windowRect[2] * windowRect[3] > WIN_MAX_COVER * width * height) windowRect = undefined;
  const inWindow = windowRect && x >= windowRect[0] && y >= windowRect[1]
    && x + zoneW <= windowRect[0] + windowRect[2]
    && y + zoneH <= windowRect[1] + windowRect[3];
  let rect: [number, number, number, number];
  if (level === 1 && windowRect && inWindow) {
    rect = windowRect;
  } else {
    // A panel is already context, not a tiny control needing another ring of
    // context. Hold it whole instead of padding a dialog back to the board.
    const padding = zoneW * zoneH > width * height * LABEL_AREA_MAX ? d.hold_pad
      : level === 1 ? d.l1_pad : level === 2 ? d.l2_pad : d.l3_pad;
    rect = [
      x - zoneW * (padding - 1) / 2,
      y - zoneH * (padding - 1) / 2,
      zoneW * padding,
      zoneH * padding,
    ];
  }

  const aspect = d.out_w / d.out_h;
  let [rx, ry, rw, rh] = rect;
  if (rw / rh < aspect) {
    const expandedW = rh * aspect;
    rx -= (expandedW - rw) / 2;
    rw = expandedW;
  } else {
    const expandedH = rw / aspect;
    ry -= (expandedH - rh) / 2;
    rh = expandedH;
  }
  if (rect !== windowRect) {
    // FIT rule: a large zone (an opened panel) is held whole at a real zoom instead of
    // its padding pushing the shot out to the whole screen.
    const holdW = Math.max(zoneW, zoneH * aspect) * d.hold_pad;
    const fitW = Math.max(holdW, Math.min(rw, width * d.frame_max));
    rx += (rw - fitW) / 2;
    ry += (rh - fitW / aspect) / 2;
    rw = fitW;
    rh = fitW / aspect;
  }

  const placed = compose({
    cx: rx + rw / 2,
    cy: ry + rh / 2,
    z: clamp(baseWidth(width, height, d) / rw, 1, zMax(width, height, d)),
  }, rect === windowRect ? { ...zone, bbox: rect } : zone,
    // compose splits small scoring boxes from large edge-avoid surfaces itself.
    boxes, width, height, d, project, cuts, at, until);
  return snapHairline(placed, width, height, d, project, cuts, at, until);
}

export function moveDuration(drift: number, d: CameraDefaults = DEFAULTS): number {
  const proposed = d.move_t_min + d.move_t_slope * Math.log2(1 + Math.max(0, drift));
  return clamp(proposed, d.move_t_min, d.move_t_max);
}

/**
 * Explicit holds direct the final path, including the opt-in held path. Like a
 * planned shot, a hold arrives on painted content: a cut or result painting the
 * box during the approach holds the camera until it settles, then the move starts.
 * A change that paints partly in the box but past the hold (a popup opened in
 * it) widens the hold to the box with it, arriving on the frame it paints, as a
 * planned shot frames a field's popup with its modal. Content a scroll repaints,
 * up to a dwell after it stops (reveal-on-scroll), is the page moving under the box, and a
 * change out of reach of the last pointed gesture (a live demo animating elsewhere on the
 * page) is not one it opened; neither widens a hold.
 */
export function applyManualZooms(frames: CameraFrame[], take: TakeMeta, d: CameraDefaults, beats: Beat[] = [],
  changes: { t: number; bbox: Zone["bbox"] }[] = []): CameraFrame[] {
  const start = take.trim_start ?? 0;
  const end = start + frames.at(-1)!.t;
  const zooms = [...(take.zooms ?? [])].filter(z => z.t1 > start && z.t0 < end)
    .sort((a, b) => a.t0 - b.t0);
  if (!zooms.length) return frames;
  const baseW = baseWidth(take.width, take.height, d);
  // Where each gesture acted (action times are ms), if it pointed anywhere: a popup it opens paints within reach of that.
  const pointed = beats.flatMap(beat => (beat.actions as Action[]).flatMap((a): { t: number; at?: Box }[] =>
    a.k === "click" ? [{ t: a.t / 1000, at: [a.x, a.y, 0, 0] }] : a.k === "drag" ? [{ t: a.t1 / 1000, at: [...a.to, 0, 0] }]
      : a.k === "type" ? [{ t: a.t0 / 1000, at: a.region }] : a.k === "shortcut" ? [{ t: a.t / 1000 }] : []))
    .sort((a, b) => a.t - b.t);
  const state = (f: CameraFrame): CameraState => ({ cx: f.x + f.w / 2, cy: f.y + f.h / 2, z: baseW / f.w });
  const at = (t: number) => state(frames[clamp(Math.round((t - start) * d.fps), 0, frames.length - 1)]!);
  const holds = zooms.map((z, i) => {
    const box: Zone = { name: "manual", type: "act", bbox: z.bbox };
    const aim = (zone: Zone) => frame(zone, z.level ?? 2, take.width, take.height, undefined, d);
    const inBox = (bbox: Zone["bbox"]) => clippedFractions({ x: z.bbox[0], y: z.bbox[1], w: z.bbox[2], h: z.bbox[3] }, [bbox])[0]! < 1;
    let target = aim(box);
    const a0 = Math.max(start, z.t0);
    const enter = Math.min(moveDuration(distance(at(a0), target, baseW), d),
      Math.max(0, a0 - (zooms[i - 1]?.t1 ?? start)) / 2);
    const s0 = a0 - enter;
    const painted = beats.flatMap(beat => [
      ...(beat.kind === "cut" ? [[beat.anchor_t, cutSettledAt(beat, beat.anchor_t, d)]] : []),
      ...beat.zones.filter(zone => zone.type === "res" && zone.t_change !== undefined && inBox(zone.bbox))
        .map(zone => [zone.t_change!, zone.t_change!]),
    ]).filter(([t]) => t! > s0 && t! <= a0).map(([, ready]) => ready!);
    const go = Math.max(s0, ...painted);
    const a = go + enter, b = Math.max(a, Math.min(end, z.t1));
    const stages = [{ go: a, t: a, target }];
    const scrolling = (t: number) => beats.some(beat => beat.kind === "scroll" && t >= beat.t0 && t <= beat.t1 + d.dwell);
    const reach = 0.25 * Math.min(take.width, take.height);
    const unprompted = (change: { t: number; bbox: Box }) => {
      const at = pointed.findLast(g => g.t <= change.t + 1 / d.fps)?.at;
      if (!at) return false;
      const [x, y, w, h] = change.bbox;
      return Math.hypot(Math.max(x - at[0] - at[2], 0, at[0] - x - w), Math.max(y - at[1] - at[3], 0, at[1] - y - h)) > reach;
    };
    for (const change of changes) {
      if (change.t <= s0 || change.t > b || !inBox(change.bbox) || scrolling(change.t) || unprompted(change)
        || change.bbox[2] * change.bbox[3] > PANEL_MAX_AREA * take.width * take.height
        || clippedFractions(toFrame(target, take.width, take.height, d), [change.bbox])[0] === 0) continue;
      const union = mergeZones(box, { ...box, bbox: change.bbox }), next = aim(union);
      // A crop-to-fill view may be unable to hold both; the box then keeps its framing.
      if (clippedFractions(toFrame(next, take.width, take.height, d), [union.bbox])[0] !== 0) continue;
      const previous = target;
      box.bbox = union.bbox;
      target = next;
      const move = change.t - moveDuration(distance(previous, target, baseW), d);
      if (move <= a) stages[0]!.target = target;
      else stages.push({ go: move, t: change.t, target });
    }
    const leave = Math.min(moveDuration(distance(target, at(b), baseW), d),
      Math.max(0, (zooms[i + 1]?.t0 ?? end) - b) / 2);
    return { s0, go, a, b, enter, leave, stages, from: go > s0 ? at(s0) : undefined };
  });
  return frames.map(f => {
    const t = f.t + start;
    const hold = holds.find(h => t >= h.s0 && t <= h.b + h.leave);
    if (!hold) return f;
    const k = hold.stages.findLastIndex(s => s.go <= t);
    const stage = hold.stages[Math.max(0, k)]!;
    const [from, to, u] = t < hold.a ? [hold.from ?? state(f), stage.target, t < hold.go ? 0 : smooth((t - hold.go) / hold.enter)]
      : t > hold.b ? [state(f), hold.stages.at(-1)!.target, 1 - smooth((t - hold.b) / hold.leave)]
      : k > 0 && t < stage.t ? [hold.stages[k - 1]!.target, stage.target, smooth((t - stage.go) / (stage.t - stage.go))]
      : [stage.target, stage.target, 1];
    return { ...toFrame(blend(from, to, u), take.width, take.height, d), t: f.t };
  });
}

/** Pair decisions with their zones and establish the requested A arrival time. */
function buildShots(
  beats: Beat[],
  decisions: Decision[],
  start: number,
  d: CameraDefaults,
): Shot[] {
  const byId = new Map(decisions.map((decision) => [decision.beat, decision]));
  return beats.map((beat) => {
    const decision = byId.get(beat.id);
    if (!decision || !Number.isInteger(decision.L) || decision.L < 0 || decision.L > 3) {
      throw new Error(`invalid or missing decision for beat ${beat.id}`);
    }
    const zoneA = beat.zones.find((zone) => zone.name === decision.A);
    const zoneB = decision.B === undefined ? zoneA : beat.zones.find((zone) => zone.name === decision.B);
    if (!zoneA || !zoneB) throw new Error(`unknown zone for beat ${beat.id}`);
    return {
      beat,
      decision,
      zoneA,
      zoneB,
      arrival: Math.max(start + d.establish_s, beat.anchor_t - d.anchor_early),
    };
  }).sort((a, b) => a.arrival - b.arrival);
}

/**
 * A scroll is not followed (the page moves under a still camera), but once it settles the
 * camera pushes in on what it brought into view, so a scroll-only take still has a subject:
 * the content that keeps changing after the settle (a playing film, a live terminal), else
 * the region the scroll repainted. The push holds until the next shot; it needs a minimum
 * shot of room, and never frames more than half the screen (that is the wide shot already).
 */
function withScrollPushIns(shots: Shot[], beats: Beat[], decisions: Map<string, Decision>,
  changes: { t: number; bbox: Box }[], width: number, height: number, end: number, d: CameraDefaults): Shot[] {
  const added: Shot[] = [];
  for (const beat of beats) {
    const decision = decisions.get(beat.id);
    const scrolls = (beat.actions as Action[]).filter((a): a is Extract<Action, { k: "scroll" }> => a.k === "scroll");
    if (beat.kind !== "scroll" || !decision || decision.shot === false || !scrolls.length) continue;
    const settled = Math.max(...scrolls.map(a => a.t1 / 1000)) + d.dwell;
    const until = Math.min(end, ...shots.map(shot => shot.arrival).filter(t => t > settled - d.min_shot));
    if (until - settled < d.min_shot) continue;
    const moving = changes.filter(c => c.t > settled && c.t < until && c.bbox[2] * c.bbox[3] < width * height / 2);
    const repainted = beat.zones.filter(zone => zone.type === "res").sort((a, b) => b.bbox[2] * b.bbox[3] - a.bbox[2] * a.bbox[3])[0];
    const bbox = moving.length ? moving.map(c => c.bbox).reduce(unionBBox) : repainted?.bbox;
    if (!bbox || bbox[2] * bbox[3] > width * height / 2) continue;
    const zone: Zone = { name: "settled", type: "res", bbox, t_change: settled };
    added.push({ beat, decision: { ...decision, B: undefined, L: 2 }, zoneA: zone, zoneB: zone, arrival: settled + d.move_t_min });
  }
  return [...shots, ...added].sort((a, b) => a.arrival - b.arrival);
}

/** If dwell delays a shot substantially, merge both subjects into one framing. */
function mergeZones(previous: Zone, next: Zone): Zone {
  const x = Math.min(previous.bbox[0], next.bbox[0]);
  const y = Math.min(previous.bbox[1], next.bbox[1]);
  const right = Math.max(previous.bbox[0] + previous.bbox[2], next.bbox[0] + next.bbox[2]);
  const bottom = Math.max(previous.bbox[1] + previous.bbox[3], next.bbox[1] + next.bbox[3]);
  return { ...next, bbox: [x, y, right - x, bottom - y] };
}

/** Anti-jitter rule: deadzone avoids a move when the subject already fits. */
function isDeadzone(state: CameraState, target: CameraState, baseW: number, d: CameraDefaults): boolean {
  const viewportW = baseW / state.z;
  const viewportH = viewportW * d.out_h / d.out_w;
  const fitsX = Math.abs(target.cx - state.cx) <= viewportW * (0.5 - d.deadzone_margin);
  const fitsY = Math.abs(target.cy - state.cy) <= viewportH * (0.5 - d.deadzone_margin);
  const zoomRatio = Math.max(target.z / state.z, state.z / target.z);
  return fitsX && fitsY && zoomRatio < d.deadzone_zoom;
}

/** A nearby target may still need a correction when the current hold cuts its context. */
function canHold(state: CameraState, target: Target, width: number, height: number, d: CameraDefaults,
  project: (frame: CameraFrame) => CameraFrame, cuts?: EdgeCuts): boolean {
  if ((target.p ?? 0.5) >= 0.65) return false;
  // The hold's visible edges must not cut a word anywhere in the take, whatever the beat's boxes.
  const crop = project(toFrame(state, width, height, d));
  if (cuts && cuts(crop, target.t, target.until ?? target.t) > 0) return false;
  if (target.screenChange && (target.p ?? 0.5) > 0.35) {
    const viewW = baseWidth(width, height, d) / state.z;
    const viewH = viewW * d.out_h / d.out_w;
    // Edge clamping can make distinct subjects' composed camera centres nearly
    // identical. Apply the attention deadzone to the observed subject itself,
    // so a new edge subject still gets its planned composition and zoom.
    const [x, y, w, h] = target.subject?.bbox
      ?? [target.state.cx, target.state.cy, 0, 0];
    if (Math.abs(x + w / 2 - state.cx) > viewW * d.deadzone_margin
      || Math.abs(y + h / 2 - state.cy) > viewH * d.deadzone_margin) return false;
  }
  if (target.p !== undefined && target.p <= 0.35) return true;
  if (!isDeadzone(state, target.state, baseWidth(width, height, d), d)) return false;
  if (!target.boxes?.length || !target.subject) return true;
  const [x, y, w, h] = target.subject.bbox;
  const margin = Math.min(crop.w, crop.h) * 0.01;
  return crop.x <= x - Math.min(margin, x)
    && crop.y <= y - Math.min(margin, y)
    && crop.x + crop.w >= x + w + Math.min(margin, width - x - w)
    && crop.y + crop.h >= y + h + Math.min(margin, height - y - h)
    && clippedFractions(crop, target.boxes).every((f) => f === 0 || f >= HIGH_CLIP_FRACTION);
}

/**
 * Anti-jitter rules: no scroll chase, dwell with union framing, and minimum
 * shot length. Idle beats HOLD (design 10.3); only a long one BREATHEs, so a
 * short pause never pulls the camera out between two actions.
 */
function applyDwellAndShotLength(shots: Shot[], d: CameraDefaults): Shot[] {
  const accepted: Shot[] = [];
  const wholeStage = (shot: Shot): boolean => shot.decision.L === 0
    || (shot.zoneA.type === "all" && (shot.zoneB === shot.zoneA || shot.zoneB.type === "all"));
  // A whole-stage shot while the camera already shows the whole stage (the
  // opening establish, or an earlier wide shot) is a no-op; accepting it would
  // let the minimum shot length drop the next real shot right behind it.
  let wide = true;
  // The planner's shot answer: a beat it says needs no camera move gets none.
  // Pointer travel alone is not an action shot. Zooming to its empty trail
  // delays the next real action behind dwell and can crop a newly opened dialog.
  const takesShot = (shot: Shot): boolean => shot.decision.shot !== false
    && shot.beat.kind !== "scroll" && shot.beat.kind !== "idle"
    && !(shot.beat.kind === "travel" && !shot.beat.actions.some(action =>
      ["click", "type", "drag", "shortcut"].includes((action as { k?: string }).k ?? "")));
  const acted = (shot: Shot) => shot.beat.actions.some(action =>
    ["click", "type", "drag", "shortcut"].includes((action as { k?: string }).k ?? ""));
  for (const shot of shots) {
    if (!takesShot(shot)) continue;
    // A simultaneous subject shot already covers the cut's arrival. Accepting
    // a redundant wide cut would let shot spacing discard that subject instead.
    if (shot.beat.kind === "cut" && wholeStage(shot) && shots.some((other) =>
      other.beat.anchor_t === shot.beat.anchor_t && other.decision.shot !== false && !wholeStage(other))) continue;
    if (wide && wholeStage(shot)) continue;
    const previous = accepted.at(-1);
    if (previous) {
      const dwell = shot.decision.K === 2 ? d.dwell_k2 : d.dwell;
      const earliest = previous.arrival + dwell;
      if (shot.arrival < earliest) {
        if (earliest - shot.arrival > d.dwell_merge_delay) {
          shot.zoneA = mergeZones(previous.zoneA, shot.zoneA);
        }
        shot.arrival = earliest;
      }
      if (shot.arrival - previous.arrival < d.min_shot) {
        // Too close to keep both: a shot on a gesture (the click, the typing) wins over one
        // that only frames the screen before it, which would otherwise take its place.
        if (!acted(previous) && acted(shot)) {
          accepted.pop();
          shot.arrival = Math.max(shot.arrival, (accepted.at(-1)?.arrival ?? -Infinity) + d.min_shot);
          accepted.push(shot);
          wide = wholeStage(shot);
        }
        continue;
      }
    }
    accepted.push(shot);
    wide = wholeStage(shot);
  }
  return accepted;
}

function applyMoveRateLimit(targets: Target[], initial: CameraState, width: number, height: number, d: CameraDefaults,
  project: (frame: CameraFrame) => CameraFrame, cuts?: EdgeCuts): Target[] {
  const baseW = baseWidth(width, height, d);
  targets = targets.map((target) => {
    const viewport = toFrame(target.state, width, height, d);
    return { ...target, state: { cx: viewport.x + viewport.w / 2,
      cy: viewport.y + viewport.h / 2, z: baseW / viewport.w } };
  });
  let state = initial;
  const moving: Target[] = [];
  for (const target of targets) {
    if (!target.reveal && !target.screenChange && canHold(state, target, width, height, d, project, cuts)) {
      const previous = moving.at(-1);
      if (previous) previous.importance = Math.max(previous.importance, target.importance);
      continue;
    }
    moving.push({ ...target });
    state = target.state;
  }
  let kept = moving;
  // Dropping a breathe would strand the camera on a close shot through a long
  // idle, so the cap counts and drops only action targets.
  for (const anchor of moving) {
    const window = kept.filter((target) => !target.breathe && !target.reveal && target.t >= anchor.t
      && target.t < anchor.t + d.rate_window);
    if (window.length <= d.rate_max) continue;
    const winners = new Set([...window]
      .sort((a, b) => b.importance - a.importance)
      .slice(0, d.rate_max));
    kept = kept.filter((target) => !window.includes(target) || winners.has(target));
  }
  state = initial;
  return kept.filter((target) => {
    if (!target.reveal && !target.screenChange && canHold(state, target, width, height, d, project, cuts)) return false;
    state = target.state;
    return true;
  });
}

/** For cuts, wait until changed_frac stays below the threshold for the settle interval. */
function cutSettledAt(beat: Beat, arrival: number, d: CameraDefaults): number {
  if (beat.kind !== "cut" || !beat.changed_frac?.length) return arrival;
  for (const sample of beat.changed_frac) {
    if (sample.t < arrival || sample.f >= d.cut_max) continue;
    const settleEnd = sample.t + d.cut_settle_ms / 1000;
    const changedAgain = beat.changed_frac.some((other) =>
      other.t >= sample.t && other.t < settleEnd && other.f >= d.cut_max,
    );
    if (!changedAgain) return Math.max(arrival, settleEnd);
  }
  return arrival;
}

/** A target before its framing is solved: its hold end comes from the
 * emitted move graph, after scheduling and skips. */
interface Draft {
  t: number;
  build: (until: number) => CameraState;
  importance: number;
  p?: number;
  subject?: Zone;
  boxes?: Box[];
  startAfter?: number;
  screenChange?: boolean;
  breathe?: boolean;
  cut?: boolean;
  reveal?: { t: number; bbox: Zone["bbox"] };
}

/** Planned A/B shots and idle widen drafts; materialized into targets once each
 * hold's guard window is known. */
function buildDrafts(
  shots: Shot[],
  beats: Beat[],
  width: number,
  height: number,
  start: number,
  end: number,
  d: CameraDefaults,
  project: (frame: CameraFrame) => CameraFrame = identity,
  cuts: EdgeCuts | undefined,
  decisions: Map<string, Decision>,
): Draft[] {
  // The surfaces a beat's own zones frame against; a reveal borrows the shot in
  // effect so its composed crop keeps the same UI whole instead of none of it.
  const boxesFor = (beat: Beat) => (zone: Zone): Box[] => zone.boxes?.length ? zone.boxes
    : beat.zones.filter((z) => !["all", "win", "path"].includes(z.type)).map((z) => z.bbox);
  const narrow = cropped(width, height, d);
  const drafts: Draft[] = shots.flatMap((shot) => {
    const inShot = boxesFor(shot.beat);
    const framed = (zone: Zone, at: number, until: number): CameraState => frame({ ...zone, boxes: inShot(zone) },
      shot.decision.L, width, height, shot.beat.window_rect, d, project, cuts, at, until);
    const result: Draft[] = [{
      t: shot.arrival,
      build: (until) => framed(shot.zoneA, shot.arrival, until),
      importance: shot.decision.K,
      p: shot.decision.decided_by === "ai" ? shot.decision.p : undefined,
      subject: withContext(shot.zoneA, inShot(shot.zoneA), width, height, d),
      boxes: inShot(shot.zoneA),
      screenChange: shot.beat.kind === "change",
      cut: beats.some((beat) => beat.kind === "cut" && beat.anchor_t >= shot.arrival && beat.anchor_t <= shot.beat.anchor_t),
      startAfter: shot.beat.kind === "cut" ? (narrow ? undefined : cutSettledAt(shot.beat, shot.arrival, d))
        : shot.beat.kind === "change" ? shot.beat.anchor_t
        : shot.zoneA.type === "res" ? shot.zoneA.t_change ?? shot.beat.t0 : undefined,
    }];
    if (shot.zoneB !== shot.zoneA && shot.decision.B) {
      const resultTime = shot.zoneB.t_change ?? shot.beat.t1;
      if (resultTime >= start && resultTime < end) result.push({
        t: resultTime + d.result_late,
        build: (until) => framed(shot.zoneB, resultTime + d.result_late, until),
        importance: shot.decision.K,
        p: shot.decision.decided_by === "ai" ? shot.decision.p : undefined,
        subject: withContext(shot.zoneB, inShot(shot.zoneB), width, height, d),
        boxes: inShot(shot.zoneB),
      });
    }
    return result;
  });

  for (const beat of beats) for (const result of beat.dialog_results ?? []) {
    if (result.t < start || result.t >= end) continue;
    const shot = shots.filter((candidate) => candidate.beat.t0 <= result.t).at(-1);
    // A revealed result frames with the labels and controls of the beat that
    // produced it: without static boxes compose never runs its search, and the
    // reveal parks slicing the column headings or the sidebar item beside the
    // result. Large surfaces are avoid edges, excludable rather than scored, so
    // the reveal still moves instead of widening to the whole screen.
    const surfaces = labelBoxes(beat, width, height);
    const revealed: Zone = { name: "revealed", type: "res", bbox: result.bbox, boxes: surfaces };
    // Widen before the close, retaining the dialog until the result is visible.
    // The union gives the final spring room to settle without losing the card.
    const context = shot ? mergeZones(shot.zoneA, revealed) : revealed;
    if (!narrow) drafts.push({ t: Math.max(start, result.t - 0.3),
      build: (until) => frame(context, 1, width, height, undefined, d, project, cuts, Math.max(start, result.t - 0.3), until),
      importance: 2, subject: context, reveal: result });
    // A crop-to-fill view cannot hold the dialog and what it reveals: no move
    // may leave the dialog before it closes.
    else for (const target of drafts) if (target.t > result.t - d.move_t_max - 0.3 && target.t <= result.t + d.move_t_max)
      target.startAfter = Math.max(target.startAfter ?? result.t, result.t);
    drafts.push({ t: result.t + 1, startAfter: result.t,
      build: (until) => frame(revealed, 2, width, height, undefined, d, project, cuts, result.t + 1, until),
      importance: 2, subject: revealed, reveal: result });
  }

  // A crop-to-fill view is already as wide as it gets, so drag visibility cannot
  // widen around a drag: frame the dragged surface at the grab instead.
  if (narrow) for (const beat of beats) for (const g of gestures(beat)) {
    // Perception sees the lifted surface only as its parts, so unless the
    // capture names it, centre the widest view on the grab: the carry then
    // keeps the surface whole by holding it exactly where it was picked up.
    const [x, y, w, h] = g.whole_object ?? [g.from[0], g.from[1], 0, 0];
    const grab: Zone = { name: "grab", type: "act", bbox: [x, y, Math.max(1, w), Math.max(1, h)] };
    drafts.push({ t: g.t0 / 1000, build: () => ({ cx: x + w / 2, cy: y + h / 2, z: 1 }),
      importance: 2, subject: grab });
  }

  // BREATHE rule: widen during long idle gaps when the following beat is distant.
  for (const [index, beat] of beats.entries()) {
    const nextBeat = beats[index + 1];
    // A planner idle answer overrides the duration rule; without one, a long idle beat breathes.
    const breathe = beat.kind === "idle" && (decisions.get(beat.id)?.idle ?? beat.t1 - beat.t0 > d.idle_s);
    const distantNext = !nextBeat || nextBeat.t0 - beat.t1 > d.next_beat_s;
    const pushed = shots.some(shot => shot.zoneA.name === "settled" && shot.arrival <= beat.t1 && shot.arrival + d.min_shot >= beat.t0);
    if (!breathe || !distantNext || pushed) continue;
    // Widen to the window itself; a fullscreen window widens to the whole screen.
    const zone: Zone = { name: "win", type: "win", bbox: beat.window_rect ?? [0, 0, width, height] };
    drafts.push({
      t: beat.t0 + d.breathe_s,
      build: (until) => frame(zone, 1, width, height, beat.window_rect, d, project, cuts, beat.t0 + d.breathe_s, until),
      importance: 0,
      breathe: true,
    });
  }
  return drafts.filter((draft) => draft.t >= start && draft.t < end
    && (draft.startAfter ?? start) < end).sort((a, b) => a.t - b.t);
}

/** Frame every draft against its guard window. */
function materialize(drafts: Draft[], windows: number[]): Target[] {
  return drafts.map((draft, index) => {
    const { build, ...target } = draft;
    const until = windows[index]!;
    return { ...target, draft: index, until, state: build(until) };
  });
}

/** A move the sampler actually started, keyed by its draft. */
interface EmittedMove {
  draft: number;
  start: number;
}

/** A hold the camera actually shows: the move that opens it, and the guard
 * window that judged its framing. */
export interface EmittedHold {
  draft: number;
  t: number;
  moveStart: number;
  until: number;
}

function holdsFromEmitted(drafts: Draft[], drags: Gesture[], emitted: EmittedMove[], windows: number[], end: number): EmittedHold[] {
  return emitted.sort((a, b) => a.start - b.start || a.draft - b.draft).map((move) => ({
    draft: move.draft,
    t: move.draft < drafts.length ? drafts[move.draft]!.t : drags[move.draft - drafts.length]!.t1 / 1000,
    moveStart: move.start,
    until: windows[move.draft] ?? end,
  }));
}

/** Every hold's window reaches the next move (or the take end). */
function holdsCovered(holds: EmittedHold[], end: number): boolean {
  return holds.every((hold, index) => hold.until >= (holds[index + 1]?.moveStart ?? end));
}

function distance(from: CameraState, to: CameraState, baseW: number): number {
  return Math.hypot(to.cx - from.cx, to.cy - from.cy) / (baseW / from.z)
    + Math.abs(Math.log(to.z / from.z));
}

/** Apply the long-pan/high-zoom hop rule and compute the move interval. */
function createMove(from: CameraState, to: CameraState, arrival: number, baseW: number, d: CameraDefaults, startAfter = 0): Move {
  const viewportW = baseW / from.z;
  const pan = Math.hypot(to.cx - from.cx, to.cy - from.cy) / viewportW;
  const hop = from.z > d.hop_zoom && to.z > d.hop_zoom && pan > d.hop_pan;
  const mid = hop
    ? { cx: (from.cx + to.cx) / 2, cy: (from.cy + to.cy) / 2, z: Math.max(1, Math.min(from.z, to.z) / d.hop_zoom_div) }
    : from;
  // Smootherstep peaks at 15/8; leave headroom below the 1 ln/s output bar.
  const zoom = hop ? 2 * Math.max(Math.abs(Math.log(mid.z / from.z)), Math.abs(Math.log(to.z / mid.z)))
    : Math.abs(Math.log(to.z / from.z));
  const duration = Math.max(moveDuration(distance(from, to, baseW), d) * (hop ? d.hop_t_scale : 1), 1.875 * zoom / 0.9);
  const start = Math.max(arrival - duration, startAfter);
  return { from, to, mid, start, end: start + duration, hop };
}

/** MOVE rule: smootherstep, logarithmic zoom about the views' fixed point. */
function interpolateMove(move: Move, time: number): CameraState {
  let u = clamp((time - move.start) / (move.end - move.start), 0, 1);
  let from = move.from;
  let to = move.to;
  if (move.hop) {
    if (u < 0.5) {
      u *= 2;
      to = move.mid;
    } else {
      u = (u - 0.5) * 2;
      from = move.mid;
    }
  }
  return blend(from, to, smooth(u));
}

/**
 * One step of a critically damped spring toward `target`. Keeping velocity makes this
 * a true second-order filter: about 2/omega of lag, no overshoot, no long tail.
 */
function spring(value: number, velocity: number, target: number, dt: number, omega: number): [number, number] {
  const elapsed = Math.max(0, dt);
  const decay = Math.exp(-omega * elapsed);
  const offset = value - target;
  return [
    target + (offset + (velocity + omega * offset) * elapsed) * decay,
    (velocity - omega * (velocity + omega * offset) * elapsed) * decay,
  ];
}

/** The nearest view to a centre that `ok` accepts, searched in rings of `step` source px: a follow
 * lands only on a view whose edges cut no word and that still shows the pointer. Along an axis it
 * travels (sign sx, sy) it may go on the way it is going but never back, so the follow never reverses. */
function cleanAim(x: number, y: number, sx: number, sy: number, step: number,
  ok: (cx: number, cy: number) => boolean): [number, number] {
  if (ok(x, y)) return [x, y];
  for (let k = 1; k <= 80; k++) {
    let best: [number, number] | undefined, cost = Infinity;
    for (let i = -k; i <= k; i++) for (let j = -k; j <= k; j++) {
      if (Math.max(Math.abs(i), Math.abs(j)) !== k || (sx && i * sx < 0) || (sy && j * sy < 0)) continue;
      const c = i * i + j * j;
      if (c < cost && ok(x + i * step, y + j * step)) { best = [x + i * step, y + j * step]; cost = c; }
    }
    if (best) return best;
  }
  return [x, y];
}

const cleanStep = (viewportW: number) => Math.max(2, viewportW / 640);

function followPointer(
  state: CameraState,
  previous: CameraState,
  beat: Beat,
  decisions: Map<string, Decision>,
  baseW: number,
  time: number,
  dt: number,
  velocity: { x: number; y: number },
  d: CameraDefaults,
  ok?: (cx: number, cy: number) => boolean,
  seen?: { x: number; y: number },
): CameraState {
  // The planner's follow answer: a beat it says should not be followed keeps the camera where it is.
  if (decisions.get(beat.id)?.follow === false) return state;
  const points = beat.actions
    .map((action) => action as { t?: number; x?: number; y?: number })
    .filter((action) => Number.isFinite(action.x) && Number.isFinite(action.y))
    .sort((a, b) => (a.t ?? -Infinity) - (b.t ?? -Infinity));
  const before = points.filter((point) => point.t === undefined || point.t / 1000 <= time).at(-1);
  const after = points.find((point) => point.t !== undefined && point.t / 1000 > time);
  const ratio = before?.t !== undefined && after?.t !== undefined
    ? (time - before.t / 1000) / ((after.t - before.t) / 1000) : 0;
  const pointer = before && {
    x: lerp(before.x!, after?.x ?? before.x!, ratio),
    y: lerp(before.y!, after?.y ?? before.y!, ratio),
  };
  const decision = decisions.get(beat.id);
  const zone = beat.zones.find((candidate) => candidate.name === decision?.A);
  const subject = pointer ?? (zone ? {
    x: zone.bbox[0] + zone.bbox[2] / 2,
    y: zone.bbox[1] + zone.bbox[3] / 2,
  } : undefined);
  if (!subject) return state;

  const viewportW = baseW / state.z;
  const viewportH = viewportW * d.out_h / d.out_w;
  const dx = (subject.x as number) - state.cx;
  const dy = (subject.y as number) - state.cy;
  if (Math.abs(dx) <= viewportW * d.follow_inner / 2
    && Math.abs(dy) <= viewportH * d.follow_inner / 2) return state;

  // Aim at the inner zone's edge, not the pointer: the target is the nominal view while the pointer
  // is inside the zone and grows from there, so it never jumps as the pointer crosses the boundary.
  let targetX = state.cx + (Math.abs(dx) <= viewportW * d.follow_inner / 2 ? 0
    : dx - Math.sign(dx) * viewportW * d.follow_inner / 2);
  let targetY = state.cy + (Math.abs(dy) <= viewportH * d.follow_inner / 2 ? 0
    : dy - Math.sign(dy) * viewportH * d.follow_inner / 2);
  if (seen) Object.assign(seen, { x: subject.x, y: subject.y });
  if (ok) [targetX, targetY] = cleanAim(targetX, targetY, Math.sign(targetX - state.cx), Math.sign(targetY - state.cy), cleanStep(baseW / state.z), ok);
  const omega = d.follow_omega;
  const decay = Math.exp(-omega * dt);
  const offsetX = previous.cx - targetX;
  const offsetY = previous.cy - targetY;
  const oldVelocityX = velocity.x;
  const oldVelocityY = velocity.y;
  const nextX = targetX + (offsetX + (oldVelocityX + omega * offsetX) * dt) * decay;
  const nextY = targetY + (offsetY + (oldVelocityY + omega * offsetY) * dt) * decay;
  velocity.x = (oldVelocityX - omega * (oldVelocityX + omega * offsetX) * dt) * decay;
  velocity.y = (oldVelocityY - omega * (oldVelocityY + omega * offsetY) * dt) * decay;
  return { ...state, cx: nextX, cy: nextY };
}

/** The same constrained, critically damped step for sampling and preparation planning. */
function filterState(requested: CameraState, previous: CameraState,
  velocity: { x: number; y: number; w: number }, dt: number,
  width: number, height: number, d: CameraDefaults): [CameraState, number] {
  // Spring the crop's edges and width alike: a zoom about a fixed point stays one through the
  // spring, and a monotone request stays monotone, so the page edge never turns back.
  const crop = toFrame(requested, width, height, d), from = toFrame(previous, width, height, d);
  const [x, vx] = spring(from.x, velocity.x, crop.x, dt, d.lowpass_omega);
  const [y, vy] = spring(from.y, velocity.y, crop.y, dt, d.lowpass_omega);
  const [w, vw] = spring(from.w, velocity.w, crop.w, dt, d.lowpass_omega);
  const h = w * d.out_h / d.out_w, z = baseWidth(width, height, d) / w;
  Object.assign(velocity, { x: vx, y: vy, w: vw });
  return [{ cx: x + w / 2, cy: y + h / 2, z }, Math.log(z)];
}

/** Pass a carried view through unfiltered, handing its motion on to the spring. */
function carried(requested: CameraState, previous: CameraState,
  velocity: { x: number; y: number; w: number }, dt: number,
  width: number, height: number, d: CameraDefaults): [CameraState, number] {
  const crop = toFrame(requested, width, height, d);
  const state = { cx: crop.x + crop.w / 2, cy: crop.y + crop.h / 2, z: baseWidth(width, height, d) / crop.w };
  const from = toFrame(previous, width, height, d);
  if (dt > 0) Object.assign(velocity, { x: (crop.x - from.x) / dt, y: (crop.y - from.y) / dt, w: (crop.w - from.w) / dt });
  return [state, Math.log(state.z)];
}

/** Seconds past a move's end until the spring, started at rest, trails its target by under half a source pixel. */
function springTail(move: Move, width: number, height: number, d: CameraDefaults): number {
  const duration = move.end - move.start, step = 1 / d.fps;
  const target = toFrame(move.to, width, height, d);
  const velocity = { x: 0, y: 0, w: 0 };
  let state = move.from;
  for (let time = step; time < duration + Math.log(1e6) / d.lowpass_omega; time += step) {
    [state] = filterState(time < duration ? interpolateMove(move, move.start + time) : move.to,
      state, velocity, step, width, height, d);
    const crop = toFrame(state, width, height, d);
    if (time >= duration && Math.max(Math.abs(crop.x - target.x), Math.abs(crop.y - target.y),
      Math.abs(crop.w - target.w)) < 0.5) return time - duration;
  }
  return Math.log(1e6) / d.lowpass_omega;
}

/** First whole-subject sample along the existing move/spring, with preceding focus retained. */
function preparationTime(from: CameraState, to: CameraState, outgoing: Zone, incoming: Zone,
  velocity: { x: number; y: number; w: number }, width: number, height: number,
  d: CameraDefaults, project: (frame: CameraFrame) => CameraFrame,
  plan: { start: number; beats: Beat[]; decisions: Map<string, Decision>;
    reveals: { start: number; end: number }[]; baseW: number;
    followVelocity: { x: number; y: number } }): number | undefined {
  const move = createMove(from, to, 0, baseWidth(width, height, d), d);
  const filteredVelocity = { ...velocity };
  const followVelocity = { ...plan.followVelocity };
  let previous = from;
  let firstWhole: number | undefined;
  // A fixed move bound plus a spring decay bound: cost never grows with take duration.
  const limit = Math.ceil((d.move_t_max + Math.log(1e6) / d.lowpass_omega + 1) * d.fps);
  for (let i = 1; i <= limit; i++) {
    const time = i / d.fps;
    let requested = time < move.end ? interpolateMove(move, time) : to;
    const at = plan.start + time;
    const activeBeat = plan.beats.find((beat) => beat.t0 <= at && beat.t1 >= at
      && ["drag", "travel"].includes(beat.kind));
    const revealing = plan.reveals.some((reveal) => at >= reveal.start && at <= reveal.end);
    if (activeBeat && !revealing) {
      requested = followPointer(requested, previous, activeBeat, plan.decisions,
        plan.baseW, at, 1 / d.fps, followVelocity, d);
    }
    [previous] = filterState(requested, previous, filteredVelocity, 1 / d.fps, width, height, d);
    const crop = project(toFrame(previous, width, height, d));
    if (clippedFractions(crop, [outgoing.bbox])[0] !== 0) return undefined;
    const whole = clippedFractions(crop, [incoming.bbox])[0] === 0;
    if (firstWhole !== undefined && !whole) return undefined;
    if (firstWhole === undefined && whole) firstWhole = time;
    if (time >= move.end + 2 / d.lowpass_omega && firstWhole !== undefined) {
      return firstWhole + 1 / d.fps; // one output sample covers the live scheduling boundary
    }
  }
  return undefined;
}

/** Sample HOLD/MOVE/FOLLOW/BREATHE camera states at output fps. */
function sampleCamera(
  targets: Target[],
  initial: CameraState,
  beats: Beat[],
  drags: Gesture[],
  decisions: Map<string, Decision>,
  width: number,
  height: number,
  start: number,
  end: number,
  d: CameraDefaults,
  project: (frame: CameraFrame) => CameraFrame,
  cuts: EdgeCuts | undefined,
  windows: number[],
  draftCount: number,
  emitted: EmittedMove[],
  changes: { t: number; bbox: Box }[],
): CameraFrame[] {
  const baseW = baseWidth(width, height, d);
  const narrow = cropped(width, height, d);
  let state = initial;
  let previousFiltered = state;
  let previousTime = start;
  let move: Move | undefined;
  let focus: Zone | undefined;
  const preparations = new Map<Target, { start: number; deadline: number }>();
  const deferredSince = new Map<Target, number>();
  const deferLimit = d.move_t_max + Math.log(1e6) / d.lowpass_omega + 1;
  let targetIndex = 0;
  const velocity = { x: 0, y: 0 };
  const filterVelocity = { x: 0, y: 0, w: 0 };
  let lastZoomMotion = start;
  let lastZoomDirection = 0;
  // Per axis, like zoom: the last time and direction the page origin moved on screen.
  const lastPan = [start, start], lastPanDirection = [0, 0];
  let lastFollow = -Infinity;
  // A followed view is held until the view has settled and then rested a shot's length; its rest
  // view must be clean for all of that, and shows the pointer.
  const followRest = d.min_shot + 12 / d.follow_omega;
  const pointer = { x: 0, y: 0 };
  let rest: [number, number] | undefined;
  let held = { cx: 0, cy: 0, vx: 0, vy: 0 };
  const frames: CameraFrame[] = [];
  const intentTimes = beats.flatMap((beat) => beat.actions).flatMap((action) => {
    const event = action as { k?: string; t?: number; t0?: number };
    if (!["click", "drag", "type", "scroll", "shortcut"].includes(event.k ?? "")) return [];
    const time = event.t ?? event.t0;
    return time === undefined ? [] : [time / 1000];
  }).sort((a, b) => a - b);
  let dragFrom: CameraState | undefined;
  let activeDrag: Gesture | undefined;
  const reveals = beats.flatMap((beat) => (beat.dialog_results ?? []).map((result) => ({
    start: result.t - d.move_t_max - 0.3,
    end: intentTimes.find((time) => time > result.t + 0.1) ?? end,
  })));

  for (let index = 0; index <= Math.floor((end - start) * d.fps); index++) {
    const time = start + index / d.fps;
    // Start each move early enough to arrive at its intended shot time, but
    // never before the previous arrival has visibly held for the minimum dwell
    // (the spring trails the ideal path by about 2/omega): result
    // and breathe targets obey it too, so no shot flashes by unread.
    const settle = move ? move.end + 2 / d.lowpass_omega : 0;
    // Quantize the minimum hold upward to the output clock, including
    // one interval for the sampled spring's visible settling boundary.
    // A preparation widen is not a readable hold, so it stays exempt from dwell.
    const heldUntil = move ? Math.ceil((settle + (move.preparation ? 0 : d.dwell)) * d.fps) / d.fps + 1 / d.fps : 0;
    // A close result preempts pending action targets, even when those targets
    // were delayed by dwell. Otherwise an old click can arrive after its dialog
    // has disappeared. Start from the visible camera to keep the move continuous.
    const revealIndex = targets.findIndex((target, i) => i >= targetIndex && target.reveal
      && createMove(previousFiltered, target.state, target.t, baseW, d, Math.max(start, target.startAfter ?? start)).start <= time);
    if (revealIndex >= 0) {
      targetIndex = revealIndex;
      state = previousFiltered;
    }
    // No shot starts while a crop-to-fill view carries a dragged surface.
    const drag = drags.find((g) => time >= g.t0 / 1000 && time <= g.t1 / 1000);
    if (activeDrag !== drag) {
      if (activeDrag && !drag) {
        // Judge the drop on its settled layout: wait out the burst of on-screen
        // changes the release starts (each within cut_settle_ms of the last, for
        // at most the preparation deferral limit), then pan to the crop nearest the
        // drop that cuts no text the hold shows, zooming out only when no pan at
        // this width fits. A drag without a whole object anchors on its drop
        // point: its bbox is the pointer's path, not an object.
        const view = project(toFrame(previousFiltered, width, height, d));
        let at = activeDrag.t1 / 1000;
        for (const change of changes) {
          if (change.t > at && change.t <= Math.min(at + d.cut_settle_ms / 1000, activeDrag.t1 / 1000 + deferLimit)
            && clippedFractions(view, [change.bbox])[0]! < 1) at = change.t;
        }
        const until = windows[draftCount + drags.indexOf(activeDrag)]!;
        // A side edge in a word gap misses every glyph but still cuts the line: text
        // within a word gap (g) on both sides of it is one line running through it.
        const g = width / 160;
        const near = (v: CameraFrame, dx: number, dw: number) => {
          for (let k = 6; k <= g; k += 6) if (cuts!({ ...v, x: v.x + dx * k, w: v.w + dw * k }, at, until) > 0) return true;
          return false;
        };
        // Text an edge only grazes still reads as cut: each edge inside the screen
        // must also cut nothing moved wholeCrop's gap (1% of the short side) in or
        // out. An edge on the screen's own border cuts nothing, as in edgeCuts.
        const clear = (v: CameraFrame) => {
          const m = Math.min(v.w, v.h) * 0.01;
          const [l, t] = [Math.round(v.x) > 0 ? m : 0, Math.round(v.y) > 0 ? m : 0];
          const [r, b] = [Math.round(v.x + v.w) < width ? m : 0, Math.round(v.y + v.h) < height ? m : 0];
          const grow = (k: number) => ({ ...v, x: v.x - k * l, y: v.y - k * t, w: v.w + k * (l + r), h: v.h + k * (t + b) });
          return !cuts || [0, -1, 1].every((k) => cuts(grow(k), at, until) === 0)
            && !(near(v, -1, 1) && near(v, 1, -1)) && !(near(v, 0, 1) && near(v, 0, -1));
        };
        if (cuts && at < until && !clear(view)) {
          const [x, y, w, h] = activeDrag.whole_object ?? [...activeDrag.from, 1, 1];
          const fit = wholeCrop(toFrame(previousFiltered, width, height, d).w, baseW, d.out_w / d.out_h,
            [x + activeDrag.to[0] - activeDrag.from[0], y + activeDrag.to[1] - activeDrag.from[1], w, h], [],
            width, height, (crop) => clear(project(crop)), [], project, Math.max(1, Math.round(width / 960)));
          if (fit) move = createMove(previousFiltered, { cx: fit.x + fit.w / 2, cy: fit.y + fit.h / 2, z: baseW / fit.w },
            0, baseW, d, at);
        }
      }
      dragFrom = undefined;
      activeDrag = drag;
      if (drag) emitted.push({ draft: draftCount + drags.indexOf(drag), start: time });
    }
    while (!drag && targetIndex < targets.length) {
      const target = targets[targetIndex]!;
      // A shot due before a drag's release is stale once the carried view has replaced it.
      if (drags.some((g) => target.t <= g.t1 / 1000 && time > g.t1 / 1000)) { targetIndex++; continue; }
      // The move in flight already goes there: restarting it from the spring's view would step the
      // request back and bounce the view.
      if (move && time < move.end && (["cx", "cy", "z"] as const).every(k => Math.abs(move!.to[k] - target.state[k]) < 1e-6)) {
        targetIndex++;
        continue;
      }
      const urgent = Boolean(target.reveal);
      const prepared = preparations.get(target);
      if (!urgent && move && previousTime < heldUntil
        && !(move.preparation && prepared && time >= prepared.deadline)) break;
      const reversing = lastZoomDirection !== 0
        && Math.sign(Math.log(target.state.z / state.z)) === -lastZoomDirection;
      // Include result and breathe targets: arrivals alone do not enforce
      // a visible hold between opposite zooms once the spring settles.
      // A pan back the way the page last moved waits out a shot's rest, even for a reveal: else it
      // reads as a bounce. A shot a cut brings in still arrives on time: its screen replaces the page.
      const here = origin(toFrame(state, width, height, d), d), there = origin(toFrame(target.state, width, height, d), d);
      const panHold = Math.min(target.cut ? createMove(state, target.state, target.t, baseW, d).start : Infinity,
        Math.max(-Infinity, ...[0, 1].filter(k => Math.abs(there[k]! - here[k]!) >= 1
          && Math.sign(there[k]! - here[k]!) === -lastPanDirection[k]!).map(k => lastPan[k]! + d.min_shot)));
      const zoomHold = Math.max(heldUntil, reversing ? lastZoomMotion + d.min_shot : -Infinity, panHold);
      const earliest = urgent ? Math.max(start + d.establish_s, target.startAfter ?? start, previousTime, panHold)
        : Math.max(start + d.establish_s, target.startAfter ?? 0, zoomHold, previousTime,
          lastFollow + followRest);
      let candidateMove = createMove(state, target.state, target.t, baseW, d, earliest);
      // A crop-to-fill view has no slack around its subject: arrive with the
      // spring settled, not merely the ideal path.
      if (narrow && !urgent) candidateMove = createMove(state, target.state,
        target.t - springTail(candidateMove, width, height, d), baseW, d, earliest);
      let preparation = preparations.get(target);
      const subject = target.subject;
      // A whole-span focus cannot enter from a tight hold already cut. Prepare
      // only that required viewport, while the preceding result remains focused.
      // A crop-to-fill view never holds such a subject whole, so preparing for
      // it would defer the move until it is dropped: move as usual instead.
      const spansSource = subject && !narrow && ((subject.bbox[0] === 0 && subject.bbox[2] === width)
        || (subject.bbox[1] === 0 && subject.bbox[3] === height));
      if (!preparation && !urgent && focus && spansSource && target.state.z === 1
        && !["all", "win"].includes(subject.type)
        && clippedFractions(project(toFrame(previousFiltered, width, height, d)), [subject.bbox])[0] !== 0) {
        const duration = preparationTime(previousFiltered, target.state, focus, subject,
          filterVelocity, width, height, d, project,
          { start: time, beats, decisions, reveals, baseW, followVelocity: velocity });
        const deadline = Math.ceil(candidateMove.start * d.fps) / d.fps;
        if (duration === undefined || deadline - duration < time) {
          const since = deferredSince.get(target) ?? time;
          deferredSince.set(target, since);
          if (time - since >= deferLimit) {
            deferredSince.delete(target);
            targetIndex++;
            continue;
          }
          target.startAfter = time + 1 / d.fps;
          break;
        }
        preparation = { start: deadline - duration, deadline };
        preparations.set(target, preparation);
      }
      if (preparation && time >= preparation.start && !move?.preparation && time < preparation.deadline) {
        if (focus && subject) {
          const fresh = preparationTime(previousFiltered, target.state, focus, subject,
            filterVelocity, width, height, d, project,
            { start: time, beats, decisions, reveals, baseW, followVelocity: velocity });
          const renewed = Math.ceil(candidateMove.start * d.fps) / d.fps;
          if (fresh === undefined || renewed - fresh < time) {
            preparations.delete(target);
            break;
          }
          preparation = { start: renewed - fresh, deadline: renewed };
          preparations.set(target, preparation);
          if (time < preparation.start) break;
        }
        move = { ...createMove(previousFiltered, target.state, 0, baseW, d, time), preparation: true };
        emitted.push({ draft: target.draft, start: time });
        break;
      }
      if (preparation && time >= preparation.deadline && subject
        && clippedFractions(project(toFrame(previousFiltered, width, height, d)), [subject.bbox])[0] === 0) {
        targetIndex++;
        focus = subject;
        continue;
      }
      if (candidateMove.start > time) break;
      targetIndex++;
      focus = subject && !["all", "win"].includes(subject.type) ? subject : undefined;
      // A screen change that the hold rules would skip (edge clamping on tall
      // screens fits both subjects in one viewport, or the new subject sits
      // inside the hold deadzone) would render as a multi-second hold across
      // two beats. Acknowledge it with a subtle out-and-back through the
      // existing hop path so every change reads on screen.
      if (target.screenChange) {
        move = { ...candidateMove, mid: { ...state, z: Math.max(1, state.z / 1.03) }, hop: true };
      } else {
        if (!urgent && canHold(state, target, width, height, d, project, cuts)) continue;
        move = candidateMove;
      }
      emitted.push({ draft: target.draft, start: move.start });
      if (urgent) break;
    }

    if (move && time >= move.start && time < move.end) {
      state = interpolateMove(move, time);
    } else if (move && time >= move.end) {
      state = move.to;
    }
    // Carry the view in lockstep with the dragged surface from where it is on
    // screen at the grab, so it lands whole on its drop target; the drop then
    // holds like any arrival. A view that does not hold the grab (a drag the
    // film first shows mid-gesture, its press trimmed or cut away, so the footage
    // cuts to it there) starts the carry centred on the grab instead.
    if (drag) {
      if (!dragFrom) {
        const grab: Box = drag.whole_object ?? [drag.from[0] - 8, drag.from[1] - 8, 32, 40];
        dragFrom = clippedFractions(project(toFrame(previousFiltered, width, height, d)), [grab])[0] === 0
          ? previousFiltered : { ...previousFiltered, cx: grab[0] + grab[2] / 2, cy: grab[1] + grab[3] / 2 };
      }
      const [px, py] = gesturePointer(drag, time);
      state = { ...dragFrom, cx: dragFrom.cx + px - drag.from[0], cy: dragFrom.cy + py - drag.from[1] };
      move = { from: state, to: state, mid: state, start: time, end: time, hop: false };
    }

    // FOLLOW rule: track the pointer of drag/travel beats only after it leaves
    // the inner 60%. Typing is not followed: its region is a fixed bbox the A
    // shot already frames, and chasing the beat's older click points pulled the
    // camera off a result shot (an opened menu) mid-beat.
    const activeBeat = beats.find((beat) => beat.t0 <= time && beat.t1 >= time
      && ["drag", "travel"].includes(beat.kind));
    // Keep the result through passive dwell at the now-vanished close button.
    // Resume follow when a new intentional action begins.
    const revealing = reveals.some((reveal) => time >= reveal.start && time <= reveal.end);
    // A crop-to-fill drag is framed by its grab and carried to its drop: following the
    // beat's clicks would pull the view off the dragged surface.
    // A move's spring tail is not followed: the follow would fight the settling arrival.
    // Where the follow comes to rest, the view also stays clean with its edges SWEEP_CLEARANCE in
    // or out (an edge on the screen's border cuts nothing), so the follow and the next move are
    // sweeping by the time an edge meets text, instead of crawling into it from the rest.
    const restOk = (nominal: CameraState, clearance = 0) => (cx: number, cy: number) => {
      const view = toFrame({ ...nominal, cx, cy }, width, height, d);
      if (Math.abs(pointer.x - view.x - view.w / 2) > view.w * 0.47
        || Math.abs(pointer.y - view.y - view.h / 2) > view.h * 0.47) return false;
      const seen = project(view), m = clearance * seen.w / d.out_w;
      if (!m) return cuts!(seen, time, time + followRest) === 0;
      const [l, t] = [Math.round(seen.x) > 0 ? m : 0, Math.round(seen.y) > 0 ? m : 0];
      const [r, b] = [Math.round(seen.x + seen.w) < width ? m : 0, Math.round(seen.y + seen.h) < height ? m : 0];
      return [0, -1, 1].every((k) => cuts!({ ...seen, x: seen.x - k * l, y: seen.y - k * t,
        w: seen.w + k * (l + r), h: seen.h + k * (t + b) }, time, time + followRest) === 0);
    };
    let followed = state;
    if (activeBeat && !revealing && !drag && !(narrow && gestures(activeBeat).length)
      && !(move && time < move.end + 3 / d.lowpass_omega)) {
      followed = followPointer(state, previousFiltered, activeBeat, decisions, baseW,
        time, time - previousTime, velocity, d, cuts && restOk(state), pointer);
    }
    // Where the follow leaves the view it stays for a readable hold, instead of snapping
    // back to the nominal view the moment the pointer returns inside the inner zone. The hold
    // is the nearest clean view to where the follow stopped, never the view mid-flight.
    if (followed !== state) {
      const dt = time - previousTime, from = lastFollow === previousTime ? held : state;
      lastFollow = time;
      rest = undefined;
      held = { cx: followed.cx, cy: followed.cy,
        vx: dt > 0 ? (followed.cx - from.cx) / dt : 0, vy: dt > 0 ? (followed.cy - from.cy) / dt : 0 };
    } else if (time - lastFollow < followRest && !(move && time < move.end) && !drag) {
      // On from where it was going; a view that has all but stopped goes on away from the nominal one.
      const going = (v: number, away: number) => Math.sign(Math.abs(v) > 5 ? v : away);
      // The follow's own momentum carries it v / omega on before a critically damped spring can stop.
      rest ??= cuts ? cleanAim(held.cx + held.vx / d.follow_omega, held.cy + held.vy / d.follow_omega,
        going(held.vx, held.cx - state.cx), going(held.vy, held.cy - state.cy),
        cleanStep(baseW / state.z), restOk(state, SWEEP_CLEARANCE)) : [held.cx, held.cy];
      const dt = time - previousTime;
      const [cx, vx] = spring(held.cx, held.vx, rest[0], dt, d.follow_omega);
      const [cy, vy] = spring(held.cy, held.vy, rest[1], dt, d.follow_omega);
      held = { cx, cy, vx, vy };
      followed = { ...state, cx, cy };
    }
    state = followed;

    // Constrain the requested viewport before filtering. Clamping the spring's
    // output instead turns a smooth edge arrival into an abrupt velocity stop.
    const dt = time - previousTime;
    // A carried view is exact: the drag's own easing already smooths it.
    const [filtered, lz] = drag ? carried(state, previousFiltered, filterVelocity, dt, width, height, d)
      : filterState(state, previousFiltered, filterVelocity, dt, width, height, d);
    state = filtered;
    const zoomSpeed = dt > 0 ? (lz - Math.log(previousFiltered.z)) / dt : 0;
    // A hold begins when visible zoom falls below 1% per second. Remember the
    // direction through pan-only targets, so they cannot bypass the guard.
    if (Math.abs(zoomSpeed) > 0.01) {
      lastZoomMotion = time;
      lastZoomDirection = Math.sign(zoomSpeed);
    }
    previousFiltered = state;
    previousTime = time;
    frames.push({ ...toFrame(state, width, height, d), t: time - start });
    const [p, q] = frames.slice(-2);
    if (q) origin(q, d).forEach((o, k) => {
      const v = (o - origin(p!, d)[k]!) * d.fps;
      if (Math.abs(v) >= 1) { lastPan[k] = time; lastPanDirection[k] = Math.sign(v); }
    });
  }
  return frames;
}

function validateCameraInputs(beats: Beat[], decisions: Decision[], take: TakeMeta): void {
  const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  const time = (value: unknown) => finite(value) && value >= 0;
  const rect = (value: unknown, width: number, height: number) => Array.isArray(value) && value.length === 4
    && value.every(finite) && value[0]! >= 0 && value[1]! >= 0
    && value[2]! > 0 && value[3]! > 0
    && value[0]! + value[2]! <= width && value[1]! + value[3]! <= height;
  if (!Array.isArray(beats) || !Array.isArray(decisions) || !take
    || !Number.isInteger(take.width) || take.width <= 0
    || !Number.isInteger(take.height) || take.height <= 0
    || (take.trim_start !== undefined && !time(take.trim_start))
    || (take.trim_end !== undefined && !time(take.trim_end))
    || (take.trim_end !== undefined && take.trim_end <= (take.trim_start ?? 0))) {
    throw new Error("invalid take geometry, trim, or camera inputs");
  }
  const beatIds = new Set<string>();
  for (const beat of beats) {
    if (!beat || typeof beat.id !== "string" || !beat.id || beatIds.has(beat.id)
      || !time(beat.t0) || !time(beat.t1) || beat.t1 < beat.t0
      || !time(beat.anchor_t) || beat.anchor_t < beat.t0 || beat.anchor_t > beat.t1
      || !Array.isArray(beat.zones) || !Array.isArray(beat.actions)
      || (beat.window_rect !== undefined && !rect(beat.window_rect, take.width, take.height))
      || (beat.changed_frac !== undefined && (!Array.isArray(beat.changed_frac)
        || beat.changed_frac.some((sample) => !sample || !time(sample.t)
          || !finite(sample.f) || sample.f < 0 || sample.f > 1)))
      || (beat.dialog_results !== undefined && (!Array.isArray(beat.dialog_results)
        || beat.dialog_results.some((result) => !result || !time(result.t)
          || !rect(result.bbox, take.width, take.height))))
      || beat.zones.some((zone) => !zone || typeof zone.name !== "string" || !zone.name
        || !rect(zone.bbox, take.width, take.height)
        || (zone.boxes !== undefined && (!Array.isArray(zone.boxes)
          || zone.boxes.some((box) => !rect(box, take.width, take.height))))
        || (zone.t_change !== undefined && (!time(zone.t_change)
          || zone.t_change < beat.t0 || zone.t_change > beat.t1)))
      || new Set(beat.zones.map((zone) => zone.name)).size !== beat.zones.length
      || beat.actions.some((action) => {
        if (!action || typeof action !== "object") return true;
        const event = action as { k?: string; t?: unknown; x?: unknown; y?: unknown;
          t0?: number; t1?: number; from?: number[]; to?: number[]; bbox?: number[];
          whole_object?: number[]; path?: { t: number; x: number; y: number }[] };
        if (event.k === "drag" || event.k === "travel") {
          const point = (p: unknown) => Array.isArray(p) && p.length === 2 && p.every(finite)
            && p[0]! >= 0 && p[0]! <= take.width && p[1]! >= 0 && p[1]! <= take.height;
          if (!finite(event.t0) || event.t0 < 0 || !finite(event.t1) || event.t1 < event.t0
            || !point(event.from) || !point(event.to)
            || !Array.isArray(event.bbox) || event.bbox.length !== 4 || !event.bbox.every(finite)
            || event.bbox[0]! < 0 || event.bbox[1]! < 0 || event.bbox[2]! < 0 || event.bbox[3]! < 0
            || event.bbox[0]! + event.bbox[2]! > take.width || event.bbox[1]! + event.bbox[3]! > take.height
            || (event.whole_object !== undefined && !rect(event.whole_object, take.width, take.height))
            || (event.path !== undefined && (!Array.isArray(event.path) || event.path.some((p, i) =>
              !p || !time(p.t) || p.t < event.t0! || p.t > event.t1! || !point([p.x, p.y])
              || (i > 0 && p.t < event.path![i - 1]!.t))))) return true;
        }
        return (event.t !== undefined && !time(event.t))
          || ((event.k === "ptr" || event.x !== undefined || event.y !== undefined)
            && (!finite(event.x) || !finite(event.y)
              || event.x < 0 || event.x > take.width || event.y < 0 || event.y > take.height
              || (event.k === "ptr" && !time(event.t))));
      })) throw new Error(`invalid camera input for beat ${beat?.id}`);
    beatIds.add(beat.id);
  }
  const decided = new Set<string>();
  for (const decision of decisions) {
    if (!decision || !beatIds.has(decision.beat) || decided.has(decision.beat)
      || !Number.isInteger(decision.K) || decision.K < 0 || decision.K > 2) {
      throw new Error(`invalid camera decision for beat ${decision?.beat}`);
    }
    decided.add(decision.beat);
  }
}

/** Pan acceleration a press shot's moves stay under: headroom below scripts/quality.ts's 9000 output px/s². */
const PRESS_PAN_ACCEL = 8000;

/**
 * A crop-to-fill view is too narrow to hold a far control beside its shot's subject, so a
 * click on it (or a scroll's whole run) can happen off screen. Each press the solved path
 * misses gets its own hold: the control (with any neighbouring act the same view can also
 * hold) from the approach through the press, then an ease back to the solved path. A hold
 * lasts at least a shot, so the camera never darts there and back; it departs from and
 * returns to the solved view at rest, and each move is long enough to keep its pan
 * acceleration in bounds. Presses whose controls fit one view share a hold. The solved path
 * stays for a click that redraws the screen (the shot belongs to the dialog it opened), for a
 * control no view frames without an edge through a word, and for a press with no room for
 * the moves between the acts around it (or inside the opening hold).
 */
function pressShots(frames: CameraFrame[], beats: Beat[], width: number, height: number, start: number,
  d: CameraDefaults, project: (frame: CameraFrame) => CameraFrame, cuts?: EdgeCuts): CameraFrame[] {
  const baseW = baseWidth(width, height, d), aspect = d.out_w / d.out_h;
  const end = start + frames.at(-1)!.t;
  const lead = d.dwell, tail = Math.max(0, d.min_shot - d.dwell), minHold = d.min_shot + 1 / d.fps;
  const at = (t: number) => frames[clamp(Math.round((t - start) * d.fps), 0, frames.length - 1)]!;
  // Every view here is the one shown: a raw crop the corner inset pulls back would kink the path.
  const state = (f: CameraFrame): CameraState => {
    const v = project(f);
    return { cx: v.x + v.w / 2, cy: v.y + v.h / 2, z: baseW / v.w };
  };
  // Quintic easing peaks at 5.774 D/T² for a pan of D output px over T seconds.
  const moveTime = (from: CameraState, to: CameraState) => {
    const w = baseW / Math.min(from.z, to.z);
    const pan = Math.hypot((to.cx - from.cx) * d.out_w / w, (to.cy - from.cy) * d.out_h / (w / aspect));
    return Math.max(moveDuration(distance(from, to, baseW), d), Math.sqrt(5.774 * pan / PRESS_PAN_ACCEL));
  };
  const near = width / 60;
  const fits = (box: Box) => box[2] <= baseW && box[3] <= baseW / aspect;
  const shows = (t0: number, t1: number, box: Box) => {
    for (let t = t0; t <= t1 + 1e-9; t += 1 / d.fps) if (clippedFractions(project(at(t)), [box])[0] !== 0) return false;
    return true;
  };
  type Action = { k?: string; t?: number; t0?: number; t1?: number; x?: number; y?: number; region?: Box; bbox?: Box };
  type Act = { t0: number; t1: number; box: Box; press: boolean };
  const acts: Act[] = beats.flatMap((beat) => {
    const boxes = beat.zones.flatMap((zone) => zone.boxes ?? []);
    return (beat.actions as Action[]).flatMap((a): Act[] => {
      const t0 = (a.t ?? a.t0 ?? NaN) / 1000, t1 = (a.t ?? a.t1 ?? a.t0 ?? NaN) / 1000;
      if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 < start || t0 > end) return [];
      if (a.k === "type" && a.region) return [{ t0, t1, box: a.region, press: false }];
      if (a.k === "drag" && a.bbox) return [{ t0, t1, box: a.bbox, press: false }];
      if ((a.k !== "click" && a.k !== "scroll") || a.x === undefined || a.y === undefined) return [];
      const [x, y] = [a.x, a.y];
      // The control under the pointer, with room for the pointer itself.
      const pointer: Box = [x - near / 2, y - near / 2, near, near];
      const control = boxes.filter(([bx, by, bw, bh]) => x >= bx && x <= bx + bw && y >= by && y <= by + bh
        && bw * bh <= LABEL_AREA_MAX * width * height).sort((p, q) => p[2] * p[3] - q[2] * q[3])[0];
      const box = control && fits(unionBBox(control, pointer)) ? unionBBox(control, pointer) : pointer;
      return [{ t0, t1, box, press: true }];
    });
  }).sort((p, q) => p.t0 - q.t0);
  // A click that redraws the screen (opens a dialog) hands the shot to what it opened, already framed.
  const redraws = beats.filter((beat) => beat.kind === "cut").map((beat) => beat.anchor_t);
  const spans: Act[] = [];
  for (const press of acts.filter((a) => a.press)) {
    if (redraws.some((t) => Math.abs(t - press.t0) <= d.cut_settle_ms / 1000)) continue;
    if (shows(Math.max(start, press.t0 - lead), Math.min(end, press.t1), press.box)) continue;
    const last = spans.at(-1);
    const union = last && unionBBox(last.box, press.box);
    if (last && union && press.t0 - last.t1 < 2 * d.move_t_max && fits(union)) {
      last.t1 = Math.max(last.t1, press.t1);
      last.box = union;
    } else spans.push({ ...press });
  }
  if (!spans.length) return frames;
  const step = Math.max(1, Math.round(width / 960));
  const holds = spans.flatMap((span) => {
    // Neighbouring acts within a move of the press stay in view when the window can hold them too.
    let box = span.box;
    for (const act of acts.filter((a) => a.t1 >= span.t0 - lead - d.move_t_max && a.t0 <= span.t1 + tail + d.move_t_max)
      .sort((p, q) => Math.min(Math.abs(p.t0 - span.t1), Math.abs(p.t1 - span.t0))
        - Math.min(Math.abs(q.t0 - span.t1), Math.abs(q.t1 - span.t0)))) {
      if (fits(unionBBox(box, act.box))) box = unionBBox(box, act.box);
    }
    const a = Math.max(start, span.t0 - lead), b = Math.min(end, span.t1 + tail);
    const w0 = at(span.t0).w;
    const clean = (crop: CameraFrame) => clippedFractions(project(crop), [box])[0] === 0
      && (!cuts || cuts(project(crop), a, b) === 0);
    // No framing holds the control without an edge through a word: the planned shot stays.
    const crop = wholeCrop(w0, baseW, aspect, box, [], width, height, clean, [], project, step);
    if (!crop) return [];
    const target = state(crop);
    // Acts outside this view: the hold enters after the one before and leaves before the next where it can.
    const outside = acts.filter((act) => clippedFractions(crop, [act.box])[0] !== 0);
    const before = Math.max(start + d.establish_s, ...outside.filter((act) => act.t1 < span.t0 - 1e-6).map((act) => act.t1));
    const after = Math.min(end, ...outside.filter((act) => act.t0 > span.t1 + 1e-6).map((act) => act.t0));
    return [{ a, b, press0: span.t0, press1: span.t1, target, before, after, s0: a, enter: 0, leave: 0,
      from: undefined as CameraState | undefined, to: undefined as CameraState | undefined }];
  });
  // The solved view at rest (under 1 output px/s, the quality gate's own rest): a hold departs
  // from and returns to a still view, never one mid-move or creeping the other way.
  const still = (t: number) => [t - 1 / d.fps, t].every((u) => {
    const p = state(at(u)), q = state(at(u + 1 / d.fps));
    return Math.hypot(q.cx - p.cx, q.cy - p.cy) * d.out_w * q.z / baseW * d.fps < 1 && Math.abs(Math.log(q.z / p.z)) * d.fps < 0.005;
  });
  const kept: typeof holds = [];
  for (const hold of holds) {
    const previous = kept.at(-1);
    const lo = Math.max(hold.before, previous ? previous.b + previous.leave : start);
    const enter = moveTime(state(at(hold.a)), hold.target), leave = moveTime(hold.target, state(at(hold.b)));
    // Leave in time for the next act; lengthen the approach rather than shorten the hold.
    hold.b = Math.max(hold.press1, Math.min(hold.b, hold.after - leave));
    hold.a = Math.max(Math.min(hold.a, hold.b - minHold), Math.min(hold.press0, lo + enter));
    hold.b = Math.max(hold.b, hold.a + minHold);
    hold.leave = leave;
    // Only where the whole move in, hold and move out fit between the acts around it.
    if (hold.a - enter < lo - 1e-6 || hold.b + leave > Math.min(hold.after, end) + 1e-6) continue;
    // Return once the solved view has stopped: hold the control while it is still travelling.
    for (let t = hold.b + leave; t <= Math.min(hold.after, end - 1 / d.fps); t += 1 / d.fps) {
      if (!still(t)) continue;
      hold.b = t - leave;
      hold.to = state(at(t));
      break;
    }
    // Depart from where the solved view last stood still.
    hold.s0 = hold.a - enter;
    for (let t = hold.s0; t >= lo; t -= 1 / d.fps) {
      if (!still(t)) continue;
      hold.s0 = t;
      hold.from = state(at(t));
      break;
    }
    hold.enter = hold.a - hold.s0;
    kept.push(hold);
  }
  return frames.map((f) => {
    const t = f.t + start;
    const hold = kept.find((h) => t >= h.s0 && t <= h.b + h.leave);
    if (!hold) return f;
    const [from, to, u] = t < hold.a ? [hold.from ?? state(f), hold.target, hold.enter > 0 ? smooth((t - hold.s0) / hold.enter) : 1]
      : t > hold.b ? [hold.to ?? state(f), hold.target, 1 - smooth((t - hold.b) / hold.leave)]
      : [hold.target, hold.target, 1];
    return { ...toFrame(blend(from, to, u), width, height, d), t: f.t };
  });
}

export function solveCameraDetailed(
  beats: Beat[],
  decisions: Decision[],
  take: TakeMeta,
  d: CameraDefaults = DEFAULTS,
  project: (frame: CameraFrame) => CameraFrame = identity,
  cuts?: EdgeCuts,
  changes: { t: number; bbox: Box }[] = [],
): { frames: CameraFrame[]; holds: EmittedHold[] } {
  validateCameraInputs(beats, decisions, take);
  const start = take.trim_start ?? 0;
  const end = take.trim_end ?? Math.max(0, ...beats.flatMap(beat => [beat.t1, ...gestures(beat).map(g => g.t1 / 1000)]));
  if (end <= start) throw new Error("invalid camera trim duration");
  const width = take.width;
  const height = take.height;
  const decisionMap = new Map(decisions.map((decision) => [decision.beat, decision]));
  const visibleBeats = beats.filter(beat => (beat.t1 > start && beat.t0 < end)
    || gestures(beat).some(g => g.t1 / 1000 > start && g.t0 / 1000 < end));
  const shots = buildShots(beats.filter(beat => !beat.camera_suppressed), decisions, start, d)
    .filter((shot) => visibleBeats.includes(shot.beat));
  const quietShots = withScrollPushIns(applyDwellAndShotLength(shots, d), visibleBeats.filter(beat => !beat.camera_suppressed),
    decisionMap, changes, width, height, end, d).filter((shot) => shot.arrival < end);
  const directed = visibleBeats.filter(beat => !beat.camera_suppressed);
  const drafts = buildDrafts(quietShots, directed, width, height, start, end, d, project, cuts, decisionMap);
  drafts.unshift({ t: start, importance: 0,
    build: (until) => compose({ cx: width / 2, cy: height / 2, z: 1 },
      { name: "initial", type: "act", bbox: [width / 2, height / 2, 1, 1] },
      [], width, height, d, project, cuts, start, until) });
  const sampledBeats = visibleBeats.map((beat) => ({ ...beat,
    kind: quietShots.some((shot) => shot.beat === beat) ? beat.kind : "idle",
    actions: quietShots.some((shot) => shot.beat === beat) ? beat.actions : [],
  }));
  // A crop-to-fill view carries every drag the film shows, even one whose shot merged away or
  // whose beat lost its shot to a cut.
  const drags = cropped(width, height, d) ? visibleBeats.flatMap(gestures) : [];
  // Start with arrival-only masks, then extend them to the next emitted move,
  // not the next planned draft: rate limiting, deferral and drag can drop it.
  // Reframing can change which moves survive, so repeat until covered. Windows
  // only extend, on the finite output-frame clock, and never past the take end.
  const windows = [...drafts.map(draft => draft.t), ...drags.map(drag => Math.min(end, drag.t1 / 1000))];
  let sampled: CameraFrame[] = [];
  let holds: EmittedHold[] = [];
  for (;;) {
    const [initial, ...requested] = materialize(drafts, windows);
    const targets = applyMoveRateLimit(requested, initial!.state,
      width, height, d, project, cuts);
    const emitted: EmittedMove[] = [{ draft: 0, start }];
    sampled = sampleCamera(targets, initial!.state, sampledBeats, drags, decisionMap, width, height,
      start, end, d, project, cuts, windows, drafts.length, emitted, changes);
    holds = holdsFromEmitted(drafts, drags, emitted, windows, end);
    if (holdsCovered(holds, end)) break;
    holds.forEach((hold, index) => {
      const until = holds[index + 1]?.moveStart ?? end;
      windows[hold.draft] = Math.max(windows[hold.draft]!, Math.min(end, Math.ceil(until * d.fps) / d.fps));
    });
    if (!cuts) {
      holds = holdsFromEmitted(drafts, drags, emitted, windows, end);
      break;
    }
  }
  if (cropped(width, height, d)) sampled = pressShots(sampled, directed, width, height, start, d, project, cuts);
  // Bookends are editorial boundaries, independent of action dwell, move caps
  // and pointer follow. Ease out before the outro, then hold the exact stage.
  // Drag visibility is applied last, so a drag-safe viewport is never discarded:
  // a crop-to-fill view cannot widen to a drag, so its carried view is that
  // viewport, and the bookends give way to it for the drag, easing to and from
  // it over one move.
  const carry = (framed: CameraFrame[]) => drags.length === 0 ? framed : framed.map((f, i) => {
    const s = sampled[i]!, t = f.t + start;
    const u = smooth(Math.max(0, ...drags.map(g =>
      1 - Math.min(1, Math.max(g.t0 / 1000 - t, t - g.t1 / 1000, 0) / d.move_t_max))));
    if (u === 0 || f === s) return f;
    if (u === 1) return s;
    const w = Math.exp(lerp(Math.log(f.w), Math.log(s.w), u)), h = w * d.out_h / d.out_w, k = along(f.w, s.w, w, u);
    return { t: f.t, w, h, x: lerp(f.x + f.w / 2, s.x + s.w / 2, k) - w / 2, y: lerp(f.y + f.h / 2, s.y + s.h / 2, k) - h / 2 };
  });
  const wide = d.outro_s > 0 ? toFrame({ cx: width / 2, cy: height / 2, z: 1 }, width, height, d) : null;
  // The outro gives way to the last action: its pull-back waits until the last shot has landed and
  // held for min_shot, and when the take ends first the film ends on that shot. Only a take with no
  // shot at all and no room for the outro holds the whole stage throughout.
  const settled = quietShots.length ? Math.max(...quietShots.map(shot => shot.arrival)) - start + d.min_shot : 0;
  const planned = wide ? Math.max(end - start - d.outro_s - d.move_t_max, settled) : 0;
  // The shot lands when the solved view stops, not at its planned arrival: wait out a move still
  // running, then a min_shot rest from its last moving frame.
  let still = Math.min(sampled.length, Math.floor(planned * d.fps));
  while (still < sampled.length && still > 0 && moving(sampled[still - 1]!, sampled[still]!, d)) still++;
  let last = Math.min(still, sampled.length - 1);
  while (last > 0 && !moving(sampled[last - 1]!, sampled[last]!, d)) last--;
  const moveStart = wide && last > 0 ? Math.max(planned, sampled[last]!.t + d.min_shot) : planned;
  const arrival = Math.min(end - start, moveStart + d.move_t_max);
  if (wide && quietShots.length && moveStart + d.move_t_min > end - start) {
    return { frames: applyDragVisibility(carry(sampled), visibleBeats, width, height, start, d), holds };
  }
  if (!wide || (moveStart <= d.establish_s && !quietShots.length)) {
    return { frames: applyDragVisibility(carry(wide ? sampled.map(f => ({ ...wide, t: f.t })) : sampled),
      visibleBeats, width, height, start, d), holds };
  }
  const origin = sampled[Math.floor(moveStart * d.fps)]!;
  return { frames: applyDragVisibility(carry(sampled.map(f => {
    if (f.t < moveStart) return f;
    if (f.t >= arrival) return { ...wide, t: f.t };
    const u = smooth((f.t - moveStart) / (arrival - moveStart));
    const w = Math.exp(lerp(Math.log(origin.w), Math.log(wide.w), u));
    const h = w * d.out_h / d.out_w, k = along(origin.w, wide.w, w, u);
    return { t: f.t, w, h,
      x: lerp(origin.x + origin.w / 2, wide.x + wide.w / 2, k) - w / 2,
      y: lerp(origin.y + origin.h / 2, wide.y + wide.h / 2, k) - h / 2 };
  })), visibleBeats, width, height, start, d), holds };
}

export function solveCamera(
  beats: Beat[],
  decisions: Decision[],
  take: TakeMeta,
  d: CameraDefaults = DEFAULTS,
  project: (frame: CameraFrame) => CameraFrame = identity,
  cuts?: EdgeCuts,
  changes: { t: number; bbox: Box }[] = [],
): CameraFrame[] {
  return solveCameraDetailed(beats, decisions, take, d, project, cuts, changes).frames;
}
