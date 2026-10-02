import type { Action } from "../types.ts";

export function actionVideoSeconds(a: Action, videoStartMs: number): Action {
  const seconds = (ms: number) => (ms - videoStartMs) / 1000;
  return "t1" in a ? { ...a, t0: seconds(a.t0), t1: seconds(a.t1),
    ...(a.k === "drag" && a.path ? { path: a.path.map(p => ({ ...p, t: seconds(p.t) })) } : {}) }
    : { ...a, t: seconds(a.t) };
}

export function actionCameraMilliseconds(action: unknown): unknown {
  const a = action as { t?: number; t0?: number; t1?: number; path?: { t: number; x: number; y: number }[] };
  return { ...a, ...(a.t === undefined ? {} : { t: a.t * 1000 }),
    ...(a.t0 === undefined ? {} : { t0: a.t0 * 1000 }),
    ...(a.t1 === undefined ? {} : { t1: a.t1 * 1000 }),
    ...(a.path ? { path: a.path.map(p => ({ ...p, t: p.t * 1000 })) } : {}) };
}
