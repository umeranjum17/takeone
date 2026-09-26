// takeone make, steps 1-3: perceive, segment, decide. Steps 4-5 (shoot,
// render) arrive in a later slice and consume this module's output:
//   analysis/regions.json, analysis/actions.json, analysis/beats.json,
//   analysis/decisions.json (+ decisions.jsonl cache), take.json jev fields.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  Beat,
  Decision,
  Event,
  FrameRegions,
  JevAnswers,
  TakeMeta,
} from "./types.ts";
import { perceiveRegions } from "./perceive/regions.ts";
import { actionsFromEvents } from "./perceive/actions.ts";
import { decodeAnalysisFrames, firstFrameTimeMs, readEvents } from "./perceive/decode.ts";
import { segmentBeats } from "./beats/segment.ts";
import { zonesForBeat, OCR_MAX_AREA } from "./beats/zones.ts";
import { buildRequest, PRICE_PER_MTOK, REQUEST_TOKEN_CAP, RequestTooLarge } from "./decide/request.ts";
import { heuristicDecision } from "./decide/heuristics.ts";
import { mapAnswers, frameRect, sumsTo1 } from "./decide/mapping.ts";
import {
  askBeat,
  CONCURRENCY,
  DecisionCache,
  loadApiKey,
  pooled,
} from "./decide/jev.ts";
import { ocrZone } from "./decide/ocr.ts";
import { redactText } from "./decide/redact.ts";
import type { BBox } from "./types.ts";

export const DEFAULT_TOKENS_PER_MIN = 40000;

export interface MakeOptions {
  noJev?: boolean;
  about?: string;
  screenText?: boolean;
  maxTokens?: number;
  /** overrides loadApiKey(); injectable for tests */
  apiKey?: string | null;
  /** injectable for tests */
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

export class PreflightRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreflightRefusal";
  }
}

export class TakeInputError extends Error {
  readonly file: string;
  constructor(file: string, reason: string) {
    super(`${file}: ${reason}`);
    this.name = "TakeInputError";
    this.file = file;
  }
}

export interface MakeResult {
  take: TakeMeta;
  beats: Beat[];
  decisions: Decision[];
  jev: { input_tokens: number; usd: number; failed: number };
}

export async function makeTake(dir: string, opts: MakeOptions = {}): Promise<MakeResult> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const warn = opts.warn ?? ((s: string) => console.error(s));
  const take = JSON.parse(readFileSync(join(dir, "take.json"), "utf8")) as TakeMeta;
  const framesTsv = join(dir, "frames.tsv");
  const webm = join(dir, "screen.webm");
  for (const [file, path] of [["screen.webm", webm], ["frames.tsv", framesTsv]]) {
    if (!existsSync(path)) throw new TakeInputError(file, "missing");
  }
  const eventsPath = join(dir, "events.jsonl");
  const events = existsSync(eventsPath) ? await readEvents(eventsPath) : [];
  if (events.length === 0 && take.events !== "none") throw new TakeInputError("events.jsonl", "missing or empty; take.json events must be none for video-only mode");

  // 1 perceive ------------------------------------------------------------
  let videoStartMs: number;
  try {
    videoStartMs = firstFrameTimeMs(framesTsv, take);
  } catch {
    throw new TakeInputError("frames.tsv", "invalid first frame timestamp");
  }
  const dec = await decodeAnalysisFrames(webm, take, framesTsv);
  // advancing pointer walk: both streams are time-ordered
  let pi = 0;
  let last: { x: number; y: number } | null = null;
  const pointers = dec.frames.map((f) => {
    while (pi < events.length) {
      const e = events[pi]!;
      if (e.k !== "ptr") {
        pi++;
        continue;
      }
      if (e.t > f.t) break;
      last = e;
      pi++;
    }
    if (!last) return null;
    return [(last.x * dec.w) / take.stream.w, (last.y * dec.h) / take.stream.h] as [number, number];
  });
  const frames = perceiveRegions(
    dec.frames.map((f) => f.data),
    dec.frames.map((f) => f.t),
    pointers,
    { w: dec.w, h: dec.h, streamW: take.stream.w, streamH: take.stream.h },
  );
  const startMs = take.trim?.start ?? 0;
  const endMs = take.trim?.end ?? takeDuration(frames, events);
  const takeMs = Math.max(0, endMs - startMs);
  const scopedFrames = frames.filter((f) => f.t >= startMs && f.t <= endMs);
  const winFor = (t: number): { cls: string; rect: BBox; title: string } | null => {
    let found: { cls: string; rect: BBox; title: string } | null = null;
    for (const e of events) {
      if (e.k !== "win") continue;
      if (e.t > t) break;
      found = { cls: e.cls, rect: e.rect, title: e.title };
    }
    return found;
  };
  const actions = actionsFromEvents(events, scopedFrames, {
    stream: take.stream,
    pointer: take.pointer ?? "hyprland",
  });
  actions.push(...frames.filter((f) => f.cut).map((f) => ({ k: "cut" as const, t: f.t, changed_frac: f.changed_frac, window_cls: winFor(f.t)?.cls ?? "" })));
  actions.sort((a, b) => ("t" in a ? a.t : a.t0) - ("t" in b ? b.t : b.t0));

  const analysisDir = join(dir, "analysis");
  mkdirSync(analysisDir, { recursive: true });
  writeFileSync(join(analysisDir, "regions.json"), JSON.stringify({ take: take.id, fps: 10, frames }, null, 1));
  writeFileSync(join(analysisDir, "actions.json"), JSON.stringify({ take: take.id, actions }, null, 1));

  // 2 segment -------------------------------------------------------------
  const beats = segmentBeats(actions, scopedFrames, { stream: take.stream, takeMs, startMs, endMs });
  for (const b of beats) {
    const win = winFor(b.anchor_t);
    b.zones = zonesForBeat(b, {
      winRect: win?.rect ?? null,
      stream: take.stream,
      scale: take.scale,
      frames: scopedFrames,
    });
    if (opts.screenText) await addScreenText(b, win, webm, videoStartMs);
  }
  writeFileSync(join(analysisDir, "beats.json"), JSON.stringify({ take: take.id, beats }, null, 1));

  // 3 decide --------------------------------------------------------------
  const key = opts.noJev ? null : opts.apiKey !== undefined ? opts.apiKey : loadApiKey();
  if (!opts.noJev && !key) warn("no TYPESAFE_API_KEY; using heuristic policy for all beats");

  // heuristic pre-pass, in shot order, to fill current_shot
  const heuristics: Decision[] = [];
  let viewport: BBox | null = null; // null = full screen
  for (const b of beats) {
    const d = heuristicDecision(b, { viewport: viewport ? { bbox: viewport } : null });
    heuristics.push(d);
    viewport = finalFrame(b, d, winFor(b.anchor_t)?.rect ?? null, take.stream);
  }

  const decisions: Decision[] = [...heuristics];
  let inputTokens = 0;
  let failed = 0;
  let usd = 0;

  if (key) {
    const minutes = Math.max(takeMs / 60000, 1 / 60);
    const maxTokens = opts.maxTokens ?? Math.ceil(DEFAULT_TOKENS_PER_MIN * minutes);
    if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
      throw new PreflightRefusal("--max-tokens must be a positive integer");
    }
    const ctxs = beats.map((b, i) => ({
      about: opts.about,
      currentShot: shotDescription(beats[i - 1] ?? null, heuristics[i - 1] ?? null, i > 0 ? winFor(beats[i - 1]!.anchor_t)?.rect ?? null : null, take.stream),
      nextBeat: beats[i + 1],
    }));
    interface Job {
      i: number;
      body: string;
    }
    const jobs: Job[] = [];
    const skipped = new Set<number>();
    let plannedTokens = 0;
    for (let i = 0; i < beats.length; i++) {
      if (beats[i]!.zones.length < 2) {
        skipped.add(i);
        continue;
      }
      try {
        const request = buildRequest(beats[i]!, ctxs[i]!, Boolean(opts.about));
        jobs.push({ i, body: request.body });
        plannedTokens += request.tokens;
      } catch (e) {
        if (!(e instanceof RequestTooLarge)) throw e;
        skipped.add(i);
        failed++;
      }
    }
    const reservedTokens = plannedTokens + jobs.filter((j) => j.i > 0).length * REQUEST_TOKEN_CAP;
    if (reservedTokens > maxTokens) {
      throw new PreflightRefusal(
        `planned ${reservedTokens} tokens exceeds the cap of ${maxTokens} (--max-tokens); ` +
          `use --no-jev or raise the cap`,
      );
    }
    log(
      `preflight: ${beats.length} beats, ${reservedTokens} planned tokens, $${(reservedTokens * PRICE_PER_MTOK / 1e6).toFixed(6)} planned`,
    );

    const cache = new DecisionCache(join(analysisDir, "decisions.jsonl"));
    const outcomes: ({ response: unknown; inputTokens?: number } | "failed")[] = new Array(beats.length);
    await pooled(jobs, CONCURRENCY, async (j) => {
      const r = await askBeat(j.body, key, cache, { fetchImpl: opts.fetchImpl,
        usable: (response) => mapJevResponse(beats[j.i]!, response, { viewport: null, winRect: winFor(beats[j.i]!.anchor_t)?.rect ?? null, stream: take.stream, about: opts.about }) !== null,
      });
      if (r.decisionSource === "failed") {
        outcomes[j.i] = "failed";
      } else {
        outcomes[j.i] = { response: r.response, inputTokens: r.inputTokens };
      }
    });
    for (let i = 0; i < beats.length; i++) {
      if (skipped.has(i)) continue;
      const o = outcomes[i]!;
      if (o === "failed") {
        failed++;
        continue; // keep heuristic
      }
      if (o.inputTokens) {
        inputTokens += o.inputTokens;
        usd += (o.inputTokens * PRICE_PER_MTOK) / 1e6;
      }
      const d = mapJevResponse(beats[i]!, o.response, {
        viewport: i === 0 ? null : finalFrame(beats[i - 1]!, decisions[i - 1]!, winFor(beats[i]!.anchor_t - 1)?.rect ?? null, take.stream),
        winRect: winFor(beats[i]!.anchor_t)?.rect ?? null,
        stream: take.stream,
        about: opts.about,
      });
      if (d) {
        if (o.inputTokens) d.input_tokens = o.inputTokens;
        decisions[i] = d;
      } else failed++;
    }

    for (let i = 1; i < beats.length; i++) {
      if (skipped.has(i)) continue;
      const actual = shotDescription(beats[i - 1]!, decisions[i - 1]!, winFor(beats[i - 1]!.anchor_t)?.rect ?? null, take.stream);
      if (actual === ctxs[i]!.currentShot) continue;
      let body: string;
      try {
        body = buildRequest(beats[i]!, { ...ctxs[i]!, currentShot: actual }, Boolean(opts.about)).body;
      } catch (e) {
        if (!(e instanceof RequestTooLarge)) throw e;
        decisions[i] = heuristics[i]!;
        failed++;
        continue;
      }
      const r = await askBeat(body, key, cache, { fetchImpl: opts.fetchImpl,
        usable: (response) => mapJevResponse(beats[i]!, response, { viewport: null, winRect: winFor(beats[i]!.anchor_t)?.rect ?? null, stream: take.stream, about: opts.about }) !== null,
      });
      if (r.decisionSource === "failed") {
        decisions[i] = heuristics[i]!;
        failed++;
        continue;
      }
      if (r.inputTokens) {
        inputTokens += r.inputTokens;
        usd += (r.inputTokens * PRICE_PER_MTOK) / 1e6;
      }
      const d = mapJevResponse(beats[i]!, r.response, {
        viewport: finalFrame(beats[i - 1]!, decisions[i - 1]!, winFor(beats[i]!.anchor_t - 1)?.rect ?? null, take.stream),
        winRect: winFor(beats[i]!.anchor_t)?.rect ?? null,
        stream: take.stream,
        about: opts.about,
      });
      if (d) {
        if (r.inputTokens) d.input_tokens = r.inputTokens;
        decisions[i] = d;
      } else {
        decisions[i] = heuristics[i]!;
        failed++;
      }
    }
  }

  writeFileSync(join(analysisDir, "decisions.json"), JSON.stringify(decisions, null, 1));
  const jev = { input_tokens: inputTokens, usd, failed };
  take.jev = jev;
  writeFileSync(join(dir, "take.json"), JSON.stringify(take, null, 1) + "\n");

  const byJev = decisions.filter((d) => d.decided_by === "jev").length;
  log(`make: ${beats.length} beats; ${byJev} by jev, ${decisions.length - byJev} by heuristic` +
    (key ? `; ${inputTokens} input tokens, $${usd.toFixed(6)}, ${failed} failed` : ""));
  // seam: steps 4-5 (shoot, render) consume analysis/beats.json + decisions.json
  return { take, beats, decisions, jev };
}

function mapJevResponse(
  beat: Beat,
  response: unknown,
  ctx: { viewport: BBox | null; winRect: BBox | null; stream: { w: number; h: number }; about?: string },
): Decision | null {
  const answers = extractAnswers(response);
  if (!answers) return null;
  const d = mapAnswers(beat, answers, ctx);
  if (d) d.input_tokens = undefined; // set by the caller from usage
  return d;
}

/** Pull the five question answers out of a systemone response. */
function extractAnswers(response: unknown): JevAnswers | null {
  const r = response as {
    answers?: Record<string, unknown>;
    questions?: Record<string, unknown>;
  };
  const src = r?.answers ?? r?.questions ?? null;
  if (!src || typeof src !== "object") return null;
  const pick = (k: string): Record<string, unknown> | undefined => {
    const v = (src as Record<string, unknown>)[k];
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  };
  const asChoices = (v: Record<string, unknown> | undefined) =>
    v
      ? {
          choice: typeof v["choice"] === "string" ? (v["choice"] as string) : undefined,
          probabilities:
            v["probabilities"] && typeof v["probabilities"] === "object"
              ? (v["probabilities"] as Record<string, number>)
              : undefined,
          confidence: typeof v["confidence"] === "number" ? (v["confidence"] as number) : undefined,
        }
      : undefined;
  const asScore = (v: Record<string, unknown> | undefined) =>
    v
      ? {
          probabilities: Array.isArray(v["probabilities"]) ? (v["probabilities"] as number[]) : undefined,
          confidence: typeof v["confidence"] === "number" ? (v["confidence"] as number) : undefined,
        }
      : undefined;
  const ns = pick("new_subject");
  return {
    focus_start: asChoices(pick("focus_start")),
    focus_end: asChoices(pick("focus_end")),
    tightness: asScore(pick("tightness")),
    new_subject:
      ns && typeof ns["p"] === "number"
        ? { p: ns["p"] as number }
        : ns && ns["probabilities"] !== undefined
          ? { p: noulP(ns) }
          : undefined,
    key_moment: asScore(pick("key_moment")),
  };
}

function noulP(v: Record<string, unknown>): number | undefined {
  const probs = v["probabilities"];
  if (Array.isArray(probs) && probs.length === 2 && sumsTo1(probs)) {
    return probs[1];
  }
  if (typeof v["p"] === "number") return v["p"] as number;
  return undefined;
}

function takeDuration(frames: FrameRegions[], events: Event[]): number {
  let maxT = 0;
  if (frames.length > 0) maxT = frames[frames.length - 1]!.t;
  for (const e of events) if (e.t > maxT) maxT = e.t;
  return Math.max(maxT, 1000);
}

function finalFrame(
  beat: Beat,
  d: Decision,
  winRect: BBox | null,
  stream: { w: number; h: number },
): BBox {
  const zone = beat.zones.find((z) => z.name === d.B) ?? null;
  return frameRect(zone, d.L, { stream, winRect });
}

/** Words for the shot on screen at the start of a beat. */
function shotDescription(prevBeat: Beat | null, prevDecision: Decision | null, winRect: BBox | null, stream: { w: number; h: number }): string {
  if (!prevBeat || !prevDecision) return "Framing the entire screen.";
  const z = prevBeat.zones.find((zone) => zone.name === prevDecision.B);
  const rect = finalFrame(prevBeat, prevDecision, winRect, stream);
  return `Framing ${z?.desc.shows ?? "the screen"} at ${rect.join(",")}.`;
}

async function addScreenText(
  beat: Beat,
  win: { rect: BBox; title: string; cls: string } | null,
  webm: string,
  videoStartMs: number,
): Promise<void> {
  for (const z of beat.zones) {
    if (z.area_frac >= OCR_MAX_AREA) continue;
    const text = await ocrZone(webm, z.bbox, Math.max(0, (z.t ?? beat.anchor_t) - videoStartMs));
    if (text) z.desc.text = text;
  }
  if (win && beat.zones.length > 0) {
    const label = [win.cls, win.title].filter(Boolean).map(redactText).join(" ");
    const winZone = beat.zones.find((z) => z.kind === "win" || z.kind === "all");
    if (winZone) winZone.desc.text = winZone.desc.text ? `${winZone.desc.text} ${label}` : label;
  }
}
