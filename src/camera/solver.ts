import { WIN_MAX_COVER } from "../beats/zones.ts";
import { DEFAULTS, type CameraDefaults } from "./defaults.ts";
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
  subject?: Zone;
  boxes?: Box[];
  startAfter?: number;
  /** A long-idle widen: quiet by definition, so exempt from the rate cap. */
  breathe?: boolean;
}

interface Move {
  from: CameraState;
  to: CameraState;
  mid: CameraState;
  start: number;
  end: number;
  hop: boolean;
}

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const smooth = (u: number) => u * u * u * (u * (u * 6 - 15) + 10);

type Box = Zone["bbox"];
export const HIGH_CLIP_FRACTION = 0.9;

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
function withContext(zone: Zone, boxes: Box[], width: number, height: number): Zone {
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
  return subject;
}

/** Search edge-aligned crops at this zoom, then widen only if none can hold the UI whole. */
function compose(state: CameraState, subject: Zone, boxes: Box[], width: number, height: number, d: CameraDefaults): CameraState {
  if (!boxes.length || state.z === 1) return state;
  const desired = toFrame(state, width, height, d);
  const aspect = d.out_w / d.out_h;
  const baseW = baseWidth(width, height, d);
  const [sx, sy, sw, sh] = subject.bbox;
  for (let w = desired.w; ; w = Math.min(baseW, w + baseW * 0.025)) {
    const h = w / aspect;
    const gap = Math.min(w, h) * 0.01;
    const positions = (s: number, span: number, view: number, size: number, axis: 0 | 1): number[] => {
      if (view >= size) return [(size - view) / 2];
      const low = Math.max(0, s + span + Math.min(gap, size - s - span) - view);
      const high = Math.min(size - view, s - Math.min(gap, s));
      if (low > high) return [];
      const candidates = [(low + high) / 2, low, high];
      for (const box of boxes) {
        const start = box[axis];
        const end = start + box[axis + 2]!;
        candidates.push(start - gap, end + gap, start - gap - view, end + gap - view);
      }
      return [...new Set(candidates.map((p) => clamp(p, low, high)))];
    };
    let best: CameraFrame | undefined;
    let bestScore = Infinity;
    for (const x of positions(sx, sw, w, width, 0)) {
      for (const y of positions(sy, sh, h, height, 1)) {
        const crop = { t: 0, x, y, w, h };
        const clips = clippedFractions(crop, boxes);
        if (clips.some((f) => f > 0 && f < HIGH_CLIP_FRACTION)) continue;
        // Balance space around the visible cluster, rather than an isolated click.
        const visible = boxes.filter((_, i) => clips[i] === 0);
        let cluster = subject;
        for (const box of visible) cluster = mergeZones(cluster, { ...subject, bbox: box });
        const [cx, cy, cw, ch] = cluster.bbox;
        const score = Math.pow((x + w / 2 - cx - cw / 2) / w, 2)
          + Math.pow((y + h / 2 - cy - ch / 2) / h, 2);
        if (score < bestScore) { best = crop; bestScore = score; }
      }
    }
    if (best) return { cx: best.x + w / 2, cy: best.y + h / 2, z: baseW / w };
    if (w >= baseW) return { cx: width / 2, cy: height / 2, z: 1 };
  }
}

/** Width of the output-aspect canvas the source sits in; z = 1 shows all of it. */
export function baseWidth(width: number, height: number, d: CameraDefaults = DEFAULTS): number {
  return Math.max(width, height * d.out_w / d.out_h);
}

/** Deepest zoom, measured against the aspect-padded canvas, that keeps within max_upscale. */
export function zMax(width: number, height: number, d: CameraDefaults = DEFAULTS): number {
  return Math.max(1, baseWidth(width, height, d) / (d.out_w / d.max_upscale));
}

/** Convert a camera centre to an output-aspect viewport, allowing padded overscan. */
function toFrame(
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

/** Expand a zone at its requested tightness, preserving output aspect and zoom bounds. */
export function frame(
  zone: Zone,
  level: number,
  width: number,
  height: number,
  windowRect?: [number, number, number, number],
  d: CameraDefaults = DEFAULTS,
): CameraState {
  if (level === 0 || zone.type === "all") {
    return { cx: width / 2, cy: height / 2, z: 1 };
  }

  const boxes = zone.boxes ?? [];
  zone = withContext(zone, boxes, width, height);

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
    const padding = level === 1 ? d.l1_pad : level === 2 ? d.l2_pad : d.l3_pad;
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

  return compose({
    cx: rx + rw / 2,
    cy: ry + rh / 2,
    z: clamp(baseWidth(width, height, d) / rw, 1, zMax(width, height, d)),
  }, rect === windowRect ? { ...zone, bbox: rect } : zone, boxes, width, height, d);
}

export function moveDuration(drift: number, d: CameraDefaults = DEFAULTS): number {
  const proposed = d.move_t_min + d.move_t_slope * Math.log2(1 + Math.max(0, drift));
  return clamp(proposed, d.move_t_min, d.move_t_max);
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
function canHold(state: CameraState, target: Target, width: number, height: number, d: CameraDefaults): boolean {
  if (!isDeadzone(state, target.state, baseWidth(width, height, d), d)) return false;
  if (!target.boxes?.length || !target.subject) return true;
  const crop = toFrame(state, width, height, d);
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
  for (const shot of shots) {
    if (shot.beat.kind === "scroll" || shot.beat.kind === "idle") continue;
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
      if (shot.arrival - previous.arrival < d.min_shot) continue;
    }
    accepted.push(shot);
    wide = wholeStage(shot);
  }
  return accepted;
}

function applyMoveRateLimit(targets: Target[], width: number, height: number, d: CameraDefaults): Target[] {
  const baseW = baseWidth(width, height, d);
  targets = targets.map((target) => {
    const viewport = toFrame(target.state, width, height, d);
    return { ...target, state: { cx: viewport.x + viewport.w / 2,
      cy: viewport.y + viewport.h / 2, z: baseW / viewport.w } };
  });
  let state: CameraState = { cx: width / 2, cy: height / 2, z: 1 };
  const moving: Target[] = [];
  for (const target of targets) {
    if (canHold(state, target, width, height, d)) {
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
    const window = kept.filter((target) => !target.breathe && target.t >= anchor.t
      && target.t < anchor.t + d.rate_window);
    if (window.length <= d.rate_max) continue;
    const winners = new Set([...window]
      .sort((a, b) => b.importance - a.importance)
      .slice(0, d.rate_max));
    kept = kept.filter((target) => !window.includes(target) || winners.has(target));
  }
  state = { cx: width / 2, cy: height / 2, z: 1 };
  return kept.filter((target) => {
    if (canHold(state, target, width, height, d)) return false;
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

/** Build A/B shots and idle widen targets; this is the camera timeline. */
function buildTargets(
  shots: Shot[],
  beats: Beat[],
  width: number,
  height: number,
  start: number,
  end: number,
  d: CameraDefaults,
): Target[] {
  const targets = shots.flatMap((shot) => {
    const boxesFor = (zone: Zone): Box[] => zone.boxes?.length ? zone.boxes
      : shot.beat.zones.filter((z) => !["all", "win", "path"].includes(z.type)).map((z) => z.bbox);
    const framed = (zone: Zone): CameraState => frame({ ...zone, boxes: boxesFor(zone) },
      shot.decision.L, width, height, shot.beat.window_rect, d);
    const targetA = framed(shot.zoneA);
    const result: Target[] = [{
      t: shot.arrival,
      state: targetA,
      importance: shot.decision.K,
      subject: withContext(shot.zoneA, boxesFor(shot.zoneA), width, height),
      boxes: boxesFor(shot.zoneA),
      startAfter: shot.beat.kind === "cut" ? cutSettledAt(shot.beat, shot.arrival, d) : undefined,
    }];
    if (shot.zoneB !== shot.zoneA && shot.decision.B) {
      const resultTime = shot.zoneB.t_change ?? shot.beat.t1;
      if (resultTime >= start && resultTime < end) result.push({
        t: resultTime + d.result_late,
        state: framed(shot.zoneB),
        importance: shot.decision.K,
        subject: withContext(shot.zoneB, boxesFor(shot.zoneB), width, height),
        boxes: boxesFor(shot.zoneB),
      });
    }
    return result;
  });

  // BREATHE rule: widen during long idle gaps when the following beat is distant.
  for (const [index, beat] of beats.entries()) {
    const nextBeat = beats[index + 1];
    const longIdle = beat.kind === "idle" && beat.t1 - beat.t0 > d.idle_s;
    const distantNext = !nextBeat || nextBeat.t0 - beat.t1 > d.next_beat_s;
    if (!longIdle || !distantNext) continue;
    // Widen to the window itself; a fullscreen window widens to the whole screen.
    const zone: Zone = { name: "win", type: "win", bbox: beat.window_rect ?? [0, 0, width, height] };
    targets.push({
      t: beat.t0 + d.breathe_s,
      state: frame(zone, 1, width, height, beat.window_rect, d),
      importance: 0,
      breathe: true,
    });
  }
  // OUTRO rule: settle back to the whole stage for the closing seconds.
  if (d.outro_s > 0 && end - d.outro_s > start + d.establish_s) {
    targets.push({ t: end - d.outro_s, state: { cx: width / 2, cy: height / 2, z: 1 }, importance: 0 });
  }
  return targets.filter((target) => target.t >= start && target.t < end
    && (target.startAfter ?? start) < end).sort((a, b) => a.t - b.t);
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
  const duration = moveDuration(distance(from, to, baseW), d) * (hop ? d.hop_t_scale : 1);
  const mid = hop
    ? { cx: (from.cx + to.cx) / 2, cy: (from.cy + to.cy) / 2, z: Math.max(1, Math.min(from.z, to.z) / d.hop_zoom_div) }
    : from;
  const start = Math.max(arrival - duration, startAfter);
  return { from, to, mid, start, end: start + duration, hop };
}

/** MOVE rule: smootherstep centre interpolation with logarithmic zoom. */
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
  u = smooth(u);
  return {
    cx: lerp(from.cx, to.cx, u),
    cy: lerp(from.cy, to.cy, u),
    z: Math.exp(lerp(Math.log(from.z), Math.log(to.z), u)),
  };
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

function pointerAt(beat: Beat, time: number): { x: number; y: number } | undefined {
  const actions = beat.actions.map((action) => action as {
    t?: number; x?: number; y?: number; t0?: number; t1?: number;
    from?: [number, number]; to?: [number, number];
  });
  const samples = actions.filter((action) => Number.isFinite(action.x) && Number.isFinite(action.y));
  const points = (samples.length ? samples.flatMap((point) => [{ t: point.t, x: point.x!, y: point.y! }])
    : actions.flatMap((action) => Number.isFinite(action.t0) && Number.isFinite(action.t1)
      && action.from?.every(Number.isFinite) && action.to?.every(Number.isFinite)
      ? [{ t: action.t0, x: action.from[0], y: action.from[1] }, { t: action.t1, x: action.to[0], y: action.to[1] }]
      : [])).sort((a, b) => (a.t ?? -Infinity) - (b.t ?? -Infinity));
  const before = points.filter((point) => point.t === undefined || point.t <= time).at(-1);
  const after = points.find((point) => point.t !== undefined && point.t > time);
  const ratio = before?.t !== undefined && after?.t !== undefined
    ? (time - before.t) / (after.t - before.t) : 0;
  const pointer = before && {
    x: lerp(before.x!, after?.x ?? before.x!, ratio),
    y: lerp(before.y!, after?.y ?? before.y!, ratio),
  };
  return pointer;
}

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
): CameraState {
  const pointer = pointerAt(beat, time);
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

  const omega = d.follow_omega;
  const decay = Math.exp(-omega * dt);
  const offsetX = previous.cx - (subject.x as number);
  const offsetY = previous.cy - (subject.y as number);
  const oldVelocityX = velocity.x;
  const oldVelocityY = velocity.y;
  const nextX = (subject.x as number) + (offsetX + (oldVelocityX + omega * offsetX) * dt) * decay;
  const nextY = (subject.y as number) + (offsetY + (oldVelocityY + omega * offsetY) * dt) * decay;
  velocity.x = (oldVelocityX - omega * (oldVelocityX + omega * offsetX) * dt) * decay;
  velocity.y = (oldVelocityY - omega * (oldVelocityY + omega * offsetY) * dt) * decay;
  return { ...state, cx: nextX, cy: nextY };
}

/** Keep the followed focus zone readable after pointer following and camera filtering. */
function containFollowedSubject(state: CameraState, zone: Zone, width: number, height: number, d: CameraDefaults): CameraState {
  const baseW = baseWidth(width, height, d);
  const [x, y, w, h] = zone.bbox;
  const aspect = d.out_w / d.out_h;
  const padding = Math.min(w, h) * 0.01;
  const viewW = Math.min(baseW, Math.max(baseW / state.z, w + padding * 2, (h + padding * 2) * aspect));
  const viewH = viewW / aspect;
  const left = x - padding;
  const top = y - padding;
  const minX = left + viewW / 2;
  const maxX = x + w + padding - viewW / 2;
  const minY = top + viewH / 2;
  const maxY = y + h + padding - viewH / 2;
  return {
    cx: minX > maxX ? (x + w / 2) : clamp(state.cx, minX, maxX),
    cy: minY > maxY ? (y + h / 2) : clamp(state.cy, minY, maxY),
    z: baseW / viewW,
  };
}

function followFocus(zone: Zone, pointer: { x: number; y: number } | undefined): Zone {
  if (!pointer || !zone.boxes?.length) return zone;
  const nearest = zone.boxes.reduce((best, box) => {
    const dx = Math.max(box[0] - pointer.x, 0, pointer.x - box[0] - box[2]);
    const dy = Math.max(box[1] - pointer.y, 0, pointer.y - box[1] - box[3]);
    const distance = dx * dx + dy * dy;
    const bestDx = Math.max(best[0] - pointer.x, 0, pointer.x - best[0] - best[2]);
    const bestDy = Math.max(best[1] - pointer.y, 0, pointer.y - best[1] - best[3]);
    const bestDistance = bestDx * bestDx + bestDy * bestDy;
    return distance < bestDistance || (distance === bestDistance && box[2] * box[3] < best[2] * best[3])
      ? box : best;
  });
  return { ...zone, bbox: [pointer.x - nearest[2] / 2, pointer.y - nearest[3] / 2, nearest[2], nearest[3]] };
}

/** Sample HOLD/MOVE/FOLLOW/BREATHE camera states at output fps. */
function sampleCamera(
  targets: Target[],
  beats: Beat[],
  decisions: Map<string, Decision>,
  width: number,
  height: number,
  start: number,
  end: number,
  d: CameraDefaults,
): CameraFrame[] {
  const baseW = baseWidth(width, height, d);
  let state: CameraState = { cx: width / 2, cy: height / 2, z: 1 };
  let previousFiltered = state;
  let previousTime = start;
  let move: Move | undefined;
  let targetIndex = 0;
  const velocity = { x: 0, y: 0 };
  const filterVelocity = { cx: 0, cy: 0, lz: 0 };
  let lastZoomMotion = start;
  let lastZoomDirection = 0;
  const frames: CameraFrame[] = [];

  for (let index = 0; index <= Math.floor((end - start) * d.fps); index++) {
    const time = start + index / d.fps;
    // Start each move early enough to arrive at its intended shot time, but
    // never before the previous arrival has visibly held for the minimum dwell
    // (the spring trails the ideal path by about 2/omega): result
    // and breathe targets obey it too, so no shot flashes by unread.
    const settle = move ? move.end + 2 / d.lowpass_omega : 0;
    const heldUntil = move ? settle + d.dwell : 0;
    while (targetIndex < targets.length) {
      if (move && previousTime < heldUntil) break;
      const target = targets[targetIndex]!;
      const reversing = lastZoomDirection !== 0
        && Math.sign(Math.log(target.state.z / state.z)) === -lastZoomDirection;
      // Include result, breathe and outro targets: arrivals alone do not enforce
      // a visible hold between opposite zooms once the spring settles.
      const zoomHold = reversing ? Math.max(heldUntil, lastZoomMotion + d.min_shot) : heldUntil;
      const candidateMove = createMove(state, target.state, target.t, baseW, d,
        Math.max(target.startAfter ?? 0, zoomHold, previousTime));
      if (candidateMove.start > time) break;
      targetIndex++;
      if (canHold(state, target, width, height, d)) continue;
      move = candidateMove;
    }

    if (move && time >= move.start && time < move.end) {
      state = interpolateMove(move, time);
    } else if (move && time >= move.end) {
      state = move.to;
    }

    // FOLLOW rule: track the pointer of drag/travel beats only after it leaves
    // the inner 60%. Typing is not followed: its region is a fixed bbox the A
    // shot already frames, and chasing the beat's older click points pulled the
    // camera off a result shot (an opened menu) mid-beat.
    const activeBeat = beats.find((beat) => beat.t0 <= time && beat.t1 >= time
      && ["drag", "travel"].includes(beat.kind));
    if (activeBeat) {
      state = followPointer(state, previousFiltered, activeBeat, decisions, baseW,
        time, time - previousTime, velocity, d);
    }

    // Constrain the requested viewport before filtering. Clamping the spring's
    // output instead turns a smooth edge arrival into an abrupt velocity stop.
    const targetFrame = toFrame(state, width, height, d);
    state = { cx: targetFrame.x + targetFrame.w / 2, cy: targetFrame.y + targetFrame.h / 2,
      z: baseW / targetFrame.w };

    const dt = time - previousTime;
    const [cx, vx] = spring(previousFiltered.cx, filterVelocity.cx, state.cx, dt, d.lowpass_omega);
    const [cy, vy] = spring(previousFiltered.cy, filterVelocity.cy, state.cy, dt, d.lowpass_omega);
    const [lz, vz] = spring(Math.log(previousFiltered.z), filterVelocity.lz, Math.log(state.z), dt, d.lowpass_omega);
    Object.assign(filterVelocity, { cx: vx, cy: vy, lz: vz });
    const zoomSpeed = dt > 0 ? (lz - Math.log(previousFiltered.z)) / dt : 0;
    // A hold begins when visible zoom falls below 1% per second. Remember the
    // direction through pan-only targets, so they cannot bypass the guard.
    if (Math.abs(zoomSpeed) > 0.01) {
      lastZoomMotion = time;
      lastZoomDirection = Math.sign(zoomSpeed);
    }
    state = { cx, cy, z: Math.exp(lz) };
    if (activeBeat) {
      const decision = decisions.get(activeBeat.id);
      const subject = activeBeat.zones.find((zone) => zone.name === decision?.A);
      if (subject) {
        state = containFollowedSubject(state, followFocus(subject, pointerAt(activeBeat, time)), width, height, d);
      }
    }
    previousFiltered = state;
    previousTime = time;
    frames.push({ ...toFrame(state, width, height, d), t: time - start });
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
      || beat.zones.some((zone) => !zone || typeof zone.name !== "string" || !zone.name
        || !rect(zone.bbox, take.width, take.height)
        || (zone.boxes !== undefined && (!Array.isArray(zone.boxes)
          || zone.boxes.some((box) => !rect(box, take.width, take.height))))
        || (zone.t_change !== undefined && (!time(zone.t_change)
          || zone.t_change < beat.t0 || zone.t_change > beat.t1)))
      || new Set(beat.zones.map((zone) => zone.name)).size !== beat.zones.length
      || beat.actions.some((action) => {
        if (!action || typeof action !== "object") return true;
        const event = action as { k?: string; t?: unknown; x?: unknown; y?: unknown };
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

export function solveCamera(
  beats: Beat[],
  decisions: Decision[],
  take: TakeMeta,
  d: CameraDefaults = DEFAULTS,
): CameraFrame[] {
  validateCameraInputs(beats, decisions, take);
  const start = take.trim_start ?? 0;
  const end = take.trim_end ?? Math.max(0, ...beats.map((beat) => beat.t1));
  if (end <= start) throw new Error("invalid camera trim duration");
  const width = take.width;
  const height = take.height;
  const decisionMap = new Map(decisions.map((decision) => [decision.beat, decision]));
  const visibleBeats = beats.filter((beat) => beat.t1 > start && beat.t0 < end);
  const shots = buildShots(beats, decisions, start, d)
    .filter((shot) => visibleBeats.includes(shot.beat));
  const quietShots = applyDwellAndShotLength(shots, d).filter((shot) => shot.arrival < end);
  const targets = applyMoveRateLimit(buildTargets(quietShots, visibleBeats, width, height, start, end, d), width, height, d);
  return sampleCamera(targets, quietShots.map((shot) => shot.beat), decisionMap, width, height, start, end, d);
}
