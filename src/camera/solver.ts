import { WIN_MAX_COVER } from "../beats/zones.ts";
import { validateZooms } from "../render/edits.ts";
import { DEFAULTS, type CameraDefaults } from "./defaults.ts";
import type {
  Beat,
  CameraFrame,
  CameraState,
  Decision,
  TakeMeta,
  ManualZoom,
  Zone,
} from "./types.ts";

interface Shot {
  beat: Beat;
  decision: Decision;
  zoneA: Zone;
  zoneB: Zone;
  arrival: number;
  portraitFill?: boolean;
}

interface Target {
  t: number;
  state: CameraState;
  importance: number;
  startAfter?: number;
  /** A long-idle widen: quiet by definition, so exempt from the rate cap. */
  breathe?: boolean;
  /** An edit takes precedence over automatic shot suppression and FOLLOW. */
  manual?: "zoom" | "resume";
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
  // Overscan remains centred until the requested crop fits; pan eases into the
  // newly available margin to avoid a one-frame jump at the source boundary.
  const place = (centre: number, view: number, size: number) => {
    if (!nonWide) return clamp(centre - view / 2, 0, Math.max(0, size - view));
    const u = smooth(clamp((size - view) / (size * 0.75), 0, 1));
    const effectiveCentre = size / 2 + (centre - size / 2) * u;
    return view > size ? (size - view) / 2
      : clamp(effectiveCentre - view / 2, 0, Math.max(0, size - view));
  };
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

  return {
    cx: rx + rw / 2,
    cy: ry + rh / 2,
    z: clamp(baseWidth(width, height, d) / rw, 1, zMax(width, height, d)),
  };
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
    if (isDeadzone(state, target.state, baseW, d)) {
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
    if (isDeadzone(state, target.state, baseW, d)) return false;
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
    const targetA = frame(shot.zoneA, shot.decision.L, width, height, shot.beat.window_rect, d);
    if (shot.portraitFill) {
      const fitZoom = baseWidth(width, height, d) / (height * d.out_w / d.out_h);
      targetA.z = Math.max(targetA.z, Math.min(fitZoom, zMax(width, height, d)));
    }
    const result: Target[] = [{
      t: shot.arrival,
      state: targetA,
      importance: shot.decision.K,
      startAfter: shot.beat.kind === "cut" ? cutSettledAt(shot.beat, shot.arrival, d) : undefined,
    }];
    if (shot.zoneB !== shot.zoneA && shot.decision.B) {
      const resultTime = shot.zoneB.t_change ?? shot.beat.t1;
      if (resultTime >= start && resultTime < end) result.push({
        t: resultTime + d.result_late,
        state: frame(shot.zoneB, shot.decision.L, width, height, shot.beat.window_rect, d),
        importance: shot.decision.K,
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
function createMove(from: CameraState, to: CameraState, arrival: number, baseW: number, d: CameraDefaults, startAfter = 0, manual = false): Move {
  const viewportW = baseW / from.z;
  const pan = Math.hypot(to.cx - from.cx, to.cy - from.cy) / viewportW;
  const hop = from.z > d.hop_zoom && to.z > d.hop_zoom && pan > d.hop_pan;
  let duration = moveDuration(distance(from, to, baseW), d) * (hop ? d.hop_t_scale : 1);
  const mid = hop
    ? { cx: (from.cx + to.cx) / 2, cy: (from.cy + to.cy) / 2, z: Math.max(1, Math.min(from.z, to.z) / d.hop_zoom_div) }
    : from;
  if (manual) {
    // A user can request a much deeper zoom than the planner. Smootherstep's
    // peak slope is 1.875 and peak acceleration is <5.78: bound the ideal path
    // to 1 ln/s and 4 ln/s² before the final spring. Hops ease each half.
    const travel = hop ? 2 * Math.max(Math.abs(Math.log(mid.z / from.z)), Math.abs(Math.log(to.z / mid.z)))
      : Math.abs(Math.log(to.z / from.z));
    duration = Math.max(duration, 1.875 * travel, Math.sqrt(5.78 * travel * (hop ? 2 : 1) / 4));
  }
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
  zooms: ManualZoom[] = [],
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
    const dueEdit = targets.findIndex((target, i) => i >= targetIndex && target.manual === "resume" && target.t <= time);
    if (dueEdit >= 0) targetIndex = dueEdit;
    while (targetIndex < targets.length) {
      const target = targets[targetIndex]!;
      // A manual edit begins at its exact boundary and interrupts any auto move.
      const manualDue = target.manual !== undefined && time >= target.t;
      if (target.manual === "resume" && !manualDue) break;
      if (!manualDue && zooms.some(z => time >= z.t0 && time < z.t1)) break;
      if (!manualDue && move && previousTime < heldUntil) break;
      const reversing = lastZoomDirection !== 0
        && Math.sign(Math.log(target.state.z / state.z)) === -lastZoomDirection;
      // Include result, breathe and outro targets: arrivals alone do not enforce
      // a visible hold between opposite zooms once the spring settles.
      const zoomHold = reversing ? Math.max(heldUntil, lastZoomMotion + d.min_shot) : heldUntil;
      const candidateMove = createMove(state, target.state, target.t, baseW, d,
        target.manual === "zoom" ? 0
          : manualDue ? target.t : Math.max(target.startAfter ?? 0, zoomHold, previousTime), Boolean(target.manual));
      if (candidateMove.start > time) break;
      targetIndex++;
      if (!target.manual && isDeadzone(state, target.state, baseW, d)) continue;
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
    if (activeBeat && !zooms.some(z => time >= z.t0 && time < z.t1)) {
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
  validateZooms(take.zooms, take.width, take.height);
  const start = take.trim_start ?? 0;
  const end = take.trim_end ?? Math.max(0, ...beats.map((beat) => beat.t1));
  if (end <= start) throw new Error("invalid camera trim duration");
  const width = take.width;
  const height = take.height;
  const decisionMap = new Map(decisions.map((decision) => [decision.beat, decision]));
  const visibleBeats = beats.filter((beat) => beat.t1 > start && beat.t0 < end);
  const shots = buildShots(beats, decisions, start, d)
    .filter((shot) => visibleBeats.includes(shot.beat) && !shot.beat.camera_suppressed);
  const portraitCrop = d.out_h > d.out_w && width / height > d.out_w / d.out_h;
  if (portraitCrop) {
    const active = shots.find((shot) => shot.beat.zones.some((zone) => zone.type !== "all"));
    if (active) {
      active.arrival = Math.min(active.arrival, start + 1);
      active.zoneA = active.beat.zones.filter((zone) => zone.type !== "all")
        .sort((a, b) => Math.abs((a.t_change ?? active.beat.anchor_t) - active.beat.anchor_t)
          - Math.abs((b.t_change ?? active.beat.anchor_t) - active.beat.anchor_t))[0]!;
      active.decision = { ...active.decision, L: Math.max(2, active.decision.L) as 2 | 3 };
      active.portraitFill = true;
    }
  }
  const quietShots = applyDwellAndShotLength(shots, d).filter((shot) => shot.arrival < end);
  const automatic = applyMoveRateLimit(buildTargets(quietShots, visibleBeats.filter(beat => !beat.camera_suppressed),
    width, height, start, end, d), width, height, d);
  const zooms = (take.zooms ?? []).filter(z => z.t1 > start && z.t0 < end)
    .map(z => ({ ...z, t0: Math.max(start, z.t0), t1: Math.min(end, z.t1) }))
    .sort((a, b) => a.t0 - b.t0);
  const targets = automatic.filter(t => !zooms.some(z => t.t >= z.t0 && t.t < z.t1));
  for (const zoom of zooms) {
    const region: Zone = { name: "manual", type: "act", bbox: zoom.bbox };
    const requested = frame(region, zoom.level ?? 2, width, height, undefined, d);
    if (portraitCrop) {
      const fitZoom = baseWidth(width, height, d) / (height * d.out_w / d.out_h);
      requested.z = Math.max(requested.z, Math.min(fitZoom, zMax(width, height, d)));
    }
    const viewport = toFrame(requested, width, height, d);
    targets.push({ t: Math.max(start, zoom.t0 - 2 / d.lowpass_omega), manual: "zoom", importance: 2,
      state: { cx: viewport.x + viewport.w / 2, cy: viewport.y + viewport.h / 2, z: baseWidth(width, height, d) / viewport.w } });
    // Resume the latest automatic framing, even if its target fell inside the edit.
    if (zoom.t1 < end && !zooms.some(z => z.t0 === zoom.t1)) targets.push({
      t: zoom.t1, startAfter: zoom.t1, manual: "resume", importance: 2,
      state: automatic.filter(t => t.t <= zoom.t1).at(-1)?.state ?? { cx: width / 2, cy: height / 2, z: 1 },
    });
  }
  targets.sort((a, b) => a.t - b.t || Number(a.manual !== undefined) - Number(b.manual !== undefined));
  return sampleCamera(targets, quietShots.map((shot) => shot.beat), decisionMap, width, height, start, end, d, zooms);
}
