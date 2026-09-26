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
  startAfter?: number;
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

export function zMax(width: number, d: CameraDefaults = DEFAULTS): number {
  return Math.max(1, width / (d.out_w / d.max_upscale));
}

/** Clamp a camera centre and convert it to the 16:9 source crop. */
function toFrame(
  state: CameraState,
  width: number,
  height: number,
  d: CameraDefaults,
): CameraFrame {
  const z = clamp(state.z, 1, zMax(width, d));
  const w = Math.min(width / z, height * d.out_w / d.out_h);
  const h = w * d.out_h / d.out_w;
  const x = clamp(state.cx - w / 2, 0, Math.max(0, width - w));
  const y = clamp(state.cy - h / 2, 0, Math.max(0, height - h));
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

  return {
    cx: rx + rw / 2,
    cy: ry + rh / 2,
    z: clamp(width / rw, 1, zMax(width, d)),
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
      arrival: Math.max(start, beat.anchor_t - d.anchor_early),
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
function isDeadzone(state: CameraState, target: CameraState, width: number, d: CameraDefaults): boolean {
  const viewportW = width / state.z;
  const viewportH = viewportW * d.out_h / d.out_w;
  const fitsX = Math.abs(target.cx - state.cx) <= viewportW * (0.5 - d.deadzone_margin);
  const fitsY = Math.abs(target.cy - state.cy) <= viewportH * (0.5 - d.deadzone_margin);
  const zoomRatio = Math.max(target.z / state.z, state.z / target.z);
  return fitsX && fitsY && zoomRatio < d.deadzone_zoom;
}

/** Anti-jitter rules: no scroll chase, dwell with union framing, and minimum shot length. */
function applyDwellAndShotLength(shots: Shot[], d: CameraDefaults): Shot[] {
  const accepted: Shot[] = [];
  for (const shot of shots) {
    if (shot.beat.kind === "scroll") continue;
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
  }
  return accepted;
}

function applyMoveRateLimit(targets: Target[], width: number, height: number, d: CameraDefaults): Target[] {
  let state: CameraState = { cx: width / 2, cy: height / 2, z: 1 };
  const moving: Target[] = [];
  for (const target of targets) {
    if (isDeadzone(state, target.state, width, d)) {
      const previous = moving.at(-1);
      if (previous) previous.importance = Math.max(previous.importance, target.importance);
      continue;
    }
    moving.push({ ...target });
    state = target.state;
  }
  let kept = moving;
  for (const anchor of moving) {
    const window = kept.filter((target) => target.t >= anchor.t
      && target.t < anchor.t + d.rate_window);
    if (window.length <= d.rate_max) continue;
    const winners = new Set([...window]
      .sort((a, b) => b.importance - a.importance)
      .slice(0, d.rate_max));
    kept = kept.filter((target) => !window.includes(target) || winners.has(target));
  }
  state = { cx: width / 2, cy: height / 2, z: 1 };
  return kept.filter((target) => {
    if (isDeadzone(state, target.state, width, d)) return false;
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
  d: CameraDefaults,
): Target[] {
  const targets = shots.flatMap((shot) => {
    const targetA = frame(shot.zoneA, shot.decision.L, width, height, shot.beat.window_rect, d);
    const result: Target[] = [{
      t: shot.arrival,
      state: targetA,
      importance: shot.decision.K,
      startAfter: shot.beat.kind === "cut" ? cutSettledAt(shot.beat, shot.arrival, d) : undefined,
    }];
    if (shot.zoneB !== shot.zoneA && shot.decision.B) {
      const resultTime = shot.zoneB.t_change ?? shot.beat.t1;
      result.push({
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
    const zone = beat.zones[0] ?? { name: "all", type: "all" as const, bbox: [0, 0, width, height] as [number, number, number, number] };
    targets.push({
      t: beat.t0 + d.breathe_s,
      state: frame(zone, 1, width, height, beat.window_rect, d),
      importance: 0,
    });
  }
  return targets.sort((a, b) => a.t - b.t);
}

function distance(from: CameraState, to: CameraState, width: number): number {
  return Math.hypot(to.cx - from.cx, to.cy - from.cy) / (width / from.z)
    + Math.abs(Math.log(to.z / from.z));
}

/** Apply the long-pan/high-zoom hop rule and compute the move interval. */
function createMove(from: CameraState, to: CameraState, arrival: number, width: number, d: CameraDefaults, startAfter = 0): Move {
  const viewportW = width / from.z;
  const pan = Math.hypot(to.cx - from.cx, to.cy - from.cy) / viewportW;
  const hop = from.z > d.hop_zoom && to.z > d.hop_zoom && pan > d.hop_pan;
  const duration = moveDuration(distance(from, to, width), d) * (hop ? d.hop_t_scale : 1);
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

/** Critically damp the final state to remove small camera-path discontinuities. */
function lowpass(previous: number, target: number, dt: number, omega: number): number {
  const elapsed = Math.max(0, dt);
  const decay = Math.exp(-omega * elapsed);
  return target + (previous - target) * (1 + omega * elapsed) * decay;
}

function followPointer(
  state: CameraState,
  previous: CameraState,
  beat: Beat,
  decisions: Map<string, Decision>,
  width: number,
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

  const viewportW = width / state.z;
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
): CameraFrame[] {
  let state: CameraState = { cx: width / 2, cy: height / 2, z: 1 };
  let previousFiltered = state;
  let previousTime = start;
  let move: Move | undefined;
  let targetIndex = 0;
  const velocity = { x: 0, y: 0 };
  const frames: CameraFrame[] = [];

  for (let index = 0; index <= Math.floor((end - start) * d.fps); index++) {
    const time = start + index / d.fps;
    // Start each move early enough to arrive at its intended shot time.
    while (targetIndex < targets.length) {
      const target = targets[targetIndex];
      const candidateMove = createMove(state, target.state, target.t, width, d, target.startAfter);
      if (candidateMove.start > time) break;
      targetIndex++;
      if (isDeadzone(state, target.state, width, d)) continue;
      move = candidateMove;
    }

    if (move && time >= move.start && time < move.end) {
      state = interpolateMove(move, time);
    } else if (move && time >= move.end) {
      state = move.to;
    }

    // FOLLOW rule: track drag/travel/type subjects only after leaving inner 60%.
    const activeBeat = beats.find((beat) => beat.t0 <= time && beat.t1 >= time
      && ["drag", "travel", "type"].includes(beat.kind));
    if (activeBeat) {
      state = followPointer(state, previousFiltered, activeBeat, decisions, width,
        time, time - previousTime, velocity, d);
    }

    const dt = time - previousTime;
    state = {
      cx: lowpass(previousFiltered.cx, state.cx, dt, d.lowpass_omega),
      cy: lowpass(previousFiltered.cy, state.cy, dt, d.lowpass_omega),
      z: Math.exp(lowpass(Math.log(previousFiltered.z), Math.log(state.z), dt, d.lowpass_omega)),
    };
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
    && value.every(finite) && value[0] >= 0 && value[1] >= 0
    && value[2] > 0 && value[3] > 0
    && value[0] + value[2] <= width && value[1] + value[3] <= height;
  if (!Array.isArray(beats) || !Array.isArray(decisions) || !take
    || !Number.isInteger(take.width) || take.width <= 0
    || !Number.isInteger(take.height) || take.height <= 0
    || (take.trim_start !== undefined && !time(take.trim_start))
    || (take.trim_end !== undefined && !time(take.trim_end))
    || (take.trim_end !== undefined && take.trim_end <= (take.trim_start ?? 0))) {
    throw new Error("invalid take geometry, trim, or camera inputs");
  }
  for (const beat of beats) {
    if (!beat || !time(beat.t0) || !time(beat.t1) || beat.t1 < beat.t0
      || !time(beat.anchor_t) || !Array.isArray(beat.zones) || !Array.isArray(beat.actions)
      || (beat.window_rect !== undefined && !rect(beat.window_rect, take.width, take.height))
      || (beat.changed_frac !== undefined && (!Array.isArray(beat.changed_frac)
        || beat.changed_frac.some((sample) => !sample || !time(sample.t)
          || !finite(sample.f) || sample.f < 0 || sample.f > 1)))
      || beat.zones.some((zone) => !zone || !rect(zone.bbox, take.width, take.height)
        || (zone.t_change !== undefined && !time(zone.t_change)))
      || beat.actions.some((action) => {
        if (!action || typeof action !== "object") return true;
        const event = action as { k?: string; t?: unknown; x?: unknown; y?: unknown };
        return (event.t !== undefined && !time(event.t))
          || ((event.k === "ptr" || event.x !== undefined || event.y !== undefined)
            && (!finite(event.x) || !finite(event.y)
              || event.x < 0 || event.x > take.width || event.y < 0 || event.y > take.height
              || (event.k === "ptr" && !time(event.t))));
      })) throw new Error(`invalid camera input for beat ${beat?.id}`);
  }
  for (const decision of decisions) {
    if (!decision || !Number.isInteger(decision.K) || decision.K < 0 || decision.K > 2) {
      throw new Error(`invalid camera decision for beat ${decision?.beat}`);
    }
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
  const shots = buildShots(beats, decisions, start, d);
  const quietShots = applyDwellAndShotLength(shots, d);
  const targets = applyMoveRateLimit(buildTargets(quietShots, beats, width, height, d), width, height, d);
  return sampleCamera(targets, beats, decisionMap, width, height, start, end, d);
}
