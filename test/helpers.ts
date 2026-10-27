// Shared synthetic fixtures for the planner tests. Everything is generated in
// code; the only external binary used is ffmpeg, for one tiny webm.

import type { Event, FrameRegions, Region } from "../src/types.ts";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let ffmpegCache: boolean | undefined;
/** True when system ffmpeg+ffprobe are on PATH; video tests skip explicitly otherwise. */
export function hasFfmpeg(): boolean {
  ffmpegCache ??= ((): boolean => {
    try {
      execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
      execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  return ffmpegCache;
}

export const STREAM = { w: 160, h: 120 };

export function greyFrame(w: number, h: number, fill = 0): Uint8Array {
  return new Uint8Array(w * h).fill(fill);
}

/** Draw a filled box into a grey frame. */
export function drawBox(f: Uint8Array, w: number, h: number, x: number, y: number, bw: number, bh: number, v = 255): void {
  for (let yy = y; yy < Math.min(h, y + bh); yy++) {
    for (let xx = x; xx < Math.min(w, x + bw); xx++) f[yy * w + xx] = v;
  }
}

export function region(bbox: [number, number, number, number], t: number, areaFrac?: number): FrameRegions {
  const [x, y, w, h] = bbox;
  const r: Region = { bbox, area_frac: areaFrac ?? (w * h) / (STREAM.w * STREAM.h) };
  return { t, changed_frac: 0.01, cut: false, regions: [r] };
}

/** A minimal event stream: focus, then a click at (x,y). */
export function clickEvents(x: number, y: number, t = 500): Event[] {
  return [
    { t: 0, k: "win", cls: "chromium", title: "Doc", rect: [0, 0, STREAM.w, STREAM.h] },
    { t: t - 50, k: "ptr", x, y },
    { t, k: "btn", b: "left", down: true },
    { t: t + 60, k: "btn", b: "left", down: false },
  ];
}

export function noopFrames(count: number, startT = 0, stepMs = 100): FrameRegions[] {
  return Array.from({ length: count }, (_, i) => ({
    t: startT + i * stepMs,
    changed_frac: 0,
    cut: false,
    regions: [],
  }));
}

/** A 24 s synthetic take in `dir` with twelve beats the planner is asked
 * about (clicks, scrolls and typing in a window smaller than the screen):
 * enough for two planner chunks. */
export function buildLongTake(dir: string, title = "App"): string {
  execFileSync("ffmpeg", [
    "-nostdin", "-f", "lavfi", "-i", "color=c=gray:s=320x180:d=24:r=30",
    "-c:v", "mpeg4", "-q:v", "2", "-f", "matroska", "-frames:v", "720", "-y", join(dir, "screen.webm"),
  ], { stdio: "ignore" });
  writeFileSync(join(dir, "frames.tsv"), Array.from({ length: 720 }, (_, i) => `${i * 3000}\t${i * 33333333}\n`).join(""));
  const events = [
    { t: 0, k: "win", cls: "chromium", title, rect: [0, 0, 280, 150] },
    ...Array.from({ length: 10 }, (_, i) => 300 + i * 2300).flatMap((t, i): object[] => i % 3 === 0 ? [
      { t: t - 100, k: "ptr", x: 40 + (i % 4) * 70, y: 40 + (i % 2) * 90 },
      { t, k: "btn", b: "left", down: true },
      { t: t + 60, k: "btn", b: "left", down: false },
    ] : i % 3 === 1 ? [
      { t, k: "wheel", dx: 0, dy: 1 },
      { t: t + 200, k: "wheel", dx: 0, dy: 1 },
    ] : [
      { t, k: "key", cls: "char", down: true },
      { t: t + 100, k: "key", cls: "char", down: true },
    ]),
  ];
  writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(dir, "take.json"), JSON.stringify({ id: "t1", stream: { w: 320, h: 180 }, scale: 1, offset_ms: 0, pointer: "hyprland" }));
  return dir;
}

/** A planner chunk request split into one view per beat, in order: the beat's
 * zones and hint with its questions under their bare names, and current_shot
 * on the chunk's first beat (later beats start from the shot before them). */
export function beatViews(body: string): string[] {
  const { state, questions } = JSON.parse(body) as { state: { current_shot: string; beats?: Record<string, object> }; questions: Record<string, unknown> };
  return Object.entries(state.beats ?? {}).map(([id, beat], k) => JSON.stringify({
    state: { ...(k === 0 ? { current_shot: state.current_shot } : {}), ...beat },
    questions: Object.fromEntries(Object.entries(questions)
      .filter(([q]) => q.startsWith(`${id}_`)).map(([q, v]) => [q.slice(id.length + 1), v])),
  }));
}

/** Film answers that keep the base look: midnight theme, pace 1 (quick), the
 * establish hold and the lively camera. No ending is answered, so the take
 * keeps its last beat. */
export function filmAnswers(body?: string): Record<string, unknown> {
  const ending = body === undefined ? [] : Object.keys((JSON.parse(body) as { questions: { ending?: { criteria: Record<string, string> } } }).questions.ending?.criteria ?? {});
  return {
    theme: { choice: "midnight", probabilities: { midnight: 1, paper: 0, aurora: 0, mono: 0, sand: 0, editorial: 0 }, confidence: 1 },
    pace: { probabilities: [0, 1, 0, 0], confidence: 1 },
    opening: { choice: "establish", probabilities: { establish: 1, short: 0, straight: 0 }, confidence: 1 },
    camera_style: { choice: "lively", probabilities: { calm: 0, lively: 1 }, confidence: 1 },
    ...(ending.length ? { ending: { choice: ending[0], probabilities: Object.fromEntries(ending.map((id, i) => [id, i === 0 ? 1 : 0])), confidence: 1 } } : {}),
  };
}

/** Jev wire answers for a planner chunk request: `perBeat` answers one beat
 * under bare question names, given its zone names; keys get the beat prefix. */
export function chunkAnswers(body: string, perBeat: (names: string[], k: number) => Record<string, unknown>): Record<string, unknown> {
  const beats = (JSON.parse(body) as { state: { beats?: Record<string, { zones: Record<string, unknown> }> } }).state.beats;
  if (beats === undefined) return filmAnswers(body);
  return Object.fromEntries(Object.entries(beats ?? {}).flatMap(([id, beat], k) =>
    Object.entries(perBeat(Object.keys(beat.zones), k)).map(([q, a]) => [`${id}_${q}`, a])));
}

const recorded = JSON.parse(readFileSync(new URL("./fixtures/recorded-planner.json", import.meta.url), "utf8")) as {
  film: Record<string, unknown>;
  beat: Record<string, unknown>;
};

/** A test-only fetch response from sanitized real model answers. Zone/beat ids
 * are renamed to this request's choices; production never imports this seam.
 * ponytail: one recorded click answer is repeated for every beat; capture more
 * distinct responses when a test asserts model taste rather than pipeline wiring. */
export function recordedPlannerReply(body: string, firstZone = false): Response {
  const { state, questions } = JSON.parse(body) as {
    state: { beats?: Record<string, { zones: Record<string, unknown> }> };
    questions: Record<string, { criteria?: Record<string, unknown> }>;
  };
  let answers: Record<string, unknown>;
  if (!state.beats) {
    answers = Object.fromEntries(Object.entries(questions).map(([key, question]) => [key,
      key === "ending" ? { choice: Object.keys(question.criteria ?? {}).at(-1), probabilities: Object.fromEntries(Object.keys(question.criteria ?? {}).map((id, i, ids) => [id, i === ids.length - 1 ? 1 : 0])), confidence: 1 }
        : recorded.film[key],
    ]));
  } else {
    answers = Object.fromEntries(Object.entries(state.beats).flatMap(([id, beat]) => {
      const names = Object.keys(beat.zones);
      const chosen = firstZone ? names[0]! : names[1] ?? names[0]!;
      return Object.entries(recorded.beat).map(([field, value]) => {
        if (!field.startsWith("focus_")) return [`${id}_${field}`, value];
        const answer = value as { probabilities: Record<string, number>; confidence: number };
        return [`${id}_${field}`, { choice: chosen, probabilities: Object.fromEntries(names.map((name) => [name, name === chosen ? (names.length === 1 ? 1 : answer.probabilities.z2) : answer.probabilities.z1! / (names.length - 1)])), confidence: answer.confidence }];
      });
    }));
  }
  return new Response(JSON.stringify({ answers, usage: { input_tokens: 800 } }), { status: 200 });
}

export const recordedPlannerFetch = (async (_url: string | URL | Request, init?: RequestInit) =>
  recordedPlannerReply(String(init?.body))) as typeof fetch;
