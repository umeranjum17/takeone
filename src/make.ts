import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  Beat,
  Decision,
  JevAnswers,
  TakeMeta,
} from "./types.ts";
import { dialogResults } from "./perceive/dialogs.ts";
import { perceiveRegions } from "./perceive/regions.ts";
import { actionsFromEvents } from "./perceive/actions.ts";
import { decodeAnalysisFrames, firstFrameTimeMs, readEvents } from "./perceive/decode.ts";
import { segmentBeats } from "./beats/segment.ts";
import { zonesForBeat, OCR_MAX_AREA } from "./beats/zones.ts";
import { buildRequest, PRICE_PER_MTOK, REQUEST_TOKEN_CAP, RequestTooLarge } from "./decide/request.ts";
import type { Question } from "@byokit/decide";
import { heuristicDecision } from "./decide/heuristics.ts";
import { mapAnswers, frameRect, sumsTo1 } from "./decide/mapping.ts";
import {
  askBeat,
  CONCURRENCY,
  JevFileCache,
  loadApiKey,
  pooled,
} from "./decide/jev.ts";
import { ocrZone } from "./decide/ocr.ts";
import { redactText } from "./decide/redact.ts";
import { renderTake } from "./render/render.ts";
import { resolveTheme } from "./themes.ts";
import { DEFAULTS, type CameraDefaults } from "./camera/defaults.ts";
import type { Beat as RenderBeat, Decision as RenderDecision, TakeMeta as RenderMeta } from "./camera/types.ts";
import { clampBBox, type BBox } from "./types.ts";

export const DEFAULT_TOKENS_PER_MIN = 40000;

export interface MakeOptions {
  /** Capture privacy: drop window titles, cache hashes only, no coords in current_shot. */
  capture?: boolean;
  noJev?: boolean;
  about?: string;
  screenText?: boolean;
  maxTokens?: number;
  /** Host-passed BYOKit override; null disables Jev, undefined loads the configured store. */
  apiKey?: string | null;
  /** injectable for tests */
  fetchImpl?: typeof fetch;
  /** camera defaults override for the render; tests pass a fast preset */
  camera?: CameraDefaults;
  /** Named look; explicit make selections are saved with the take. */
  theme?: string;
  /** stop after the preflight: no planner calls, no render; returns planned tokens */
  planOnly?: boolean;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

export class PreflightRefusal extends Error {
  readonly plannedTokens?: number;
  readonly cap?: number;
  constructor(message: string, o: { plannedTokens?: number; cap?: number } = {}) {
    super(message);
    this.name = "PreflightRefusal";
    this.plannedTokens = o.plannedTokens;
    this.cap = o.cap;
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
  /** reserved preflight tokens and their planned cost; zeros without a planner key */
  planned: { planned_tokens: number; usd: number };
  /** render output path and output seconds; null/0 when planOnly skips the render */
  out: string | null;
  seconds: number;
}

export function readTakeMeta(dir: string): TakeMeta {
  return JSON.parse(readFileSync(join(dir, "take.json"), "utf8")) as TakeMeta;
}

/** Blank window titles in events.jsonl, keeping every other line byte-identical. */
function scrubEventTitles(eventsPath: string): void {
  const raw = readFileSync(eventsPath, "utf8").split("\n");
  let changed = false;
  const out = raw.map((line) => {
    if (!line.trim()) return line;
    let e: { k?: unknown; title?: unknown };
    try {
      e = JSON.parse(line);
    } catch {
      return line;
    }
    if (e && typeof e === "object" && e.k === "win" && typeof e.title === "string" && e.title !== "") {
      changed = true;
      return JSON.stringify({ ...e, title: "" });
    }
    return line;
  });
  if (changed) writeFileSync(eventsPath, out.join("\n"));
}

export async function makeTake(dir: string, opts: MakeOptions = {}): Promise<MakeResult> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const warn = opts.warn ?? ((s: string) => console.error(s));
  const take = readTakeMeta(dir);
  // Portrait takes (phone footage) default to a portrait output unless the
  // caller overrode the output size; desktop behaviour is unchanged.
  const themed = resolveTheme(opts.theme ?? take.theme);
  if (opts.theme !== undefined) take.theme = opts.theme;
  const camera = opts.camera
    ?? (take.stream.h > take.stream.w ? { ...themed, out_w: 1080, out_h: 1920 } : themed);
  const { out_w, out_h } = camera ?? DEFAULTS;
  const aspect = out_w / out_h; // the decide-side frame estimate shares the render's aspect
  const framesTsv = join(dir, "frames.tsv");
  const webm = join(dir, "screen.webm");
  for (const [file, path] of [["screen.webm", webm], ["frames.tsv", framesTsv]] as const) {
    if (!existsSync(path)) throw new TakeInputError(file, "missing");
  }
  const eventsPath = join(dir, "events.jsonl");
  const hasEvents = existsSync(eventsPath);
  if (!hasEvents && take.events !== "none") throw new TakeInputError("events.jsonl", "missing");
  if (opts.capture && hasEvents) scrubEventTitles(eventsPath);
  const events = hasEvents ? await readEvents(eventsPath) : [];
  if (hasEvents && events.length === 0 && statSync(eventsPath).size > 0 && take.events !== "none") {
    throw new TakeInputError("events.jsonl", "invalid event data");
  }

  // 1 perceive ------------------------------------------------------------
  let videoStartMs: number;
  try {
    videoStartMs = firstFrameTimeMs(framesTsv, take);
  } catch {
    throw new TakeInputError("frames.tsv", "invalid first frame timestamp");
  }
  const dec = await decodeAnalysisFrames(webm, take, framesTsv);
  const videoEndMs = videoStartMs + dec.frames.length * 100;
  const startMs = Math.max(videoStartMs, take.trim?.start ?? videoStartMs);
  const endMs = Math.min(videoEndMs, take.trim?.end ?? videoEndMs);
  if (!(endMs > startMs)) throw new TakeInputError("take.json", "trim does not overlap video");
  // advancing pointer walk: both streams are time-ordered
  let pi = 0;
  let last: { x: number; y: number } | null = null;
  const pointers = dec.frames.map((f) => {
    while (pi < events.length) {
      const e = events[pi]!;
      if (e.t > f.t) break;
      if (e.k === "ptr") last = e;
      else if (e.k === "ptr-lost") last = null;
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
  const revealed = dialogResults(dec.frames.map((f) => f.data), dec.frames.map((f) => f.t), pointers,
    { w: dec.w, h: dec.h, streamW: take.stream.w, streamH: take.stream.h })
    .filter((result) => result.t >= startMs && result.t <= endMs);
  const takeMs = endMs - startMs;
  const scopedFrames = frames.filter((f) => f.t >= startMs && f.t <= endMs);
  const winFor = (t: number): { cls: string; rect: BBox; title: string } | null => {
    let found: { cls: string; rect: BBox; title: string } | null = null;
    for (const e of events) {
      if (e.k !== "win") continue;
      if (e.t > t) break;
      found = e.rect === null ? null : { cls: e.cls, rect: e.rect, title: e.title };
    }
    return found;
  };
  const actions = actionsFromEvents(events, scopedFrames, {
    stream: take.stream,
    pointer: take.pointer ?? "hyprland",
    startMs,
    endMs,
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
      scale: take.scale ?? 1,
      frames: scopedFrames,
    });
    if (opts.screenText) await addScreenText(b, opts.capture ? null : win, webm, videoStartMs);
  }
  const seconds = (ms: number) => (ms - videoStartMs) / 1000;
  const renderBeats: RenderBeat[] = beats.map((b) => {
    const window = winFor(b.anchor_t);
    const windowRect = window && clampBBox(window.rect, take.stream.w, take.stream.h);
    return {
      id: b.id, t0: seconds(b.t0), t1: seconds(b.t1), anchor_t: seconds(b.anchor_t),
      kind: b.kind, window_cls: b.window_cls,
      ...(windowRect ? { window_rect: windowRect } : {}),
      actions: b.actions.map((a) => "t1" in a ? { ...a, t0: seconds(a.t0), t1: seconds(a.t1) } : { ...a, t: seconds(a.t) }),
      zones: b.zones.map((z) => ({ name: z.name, type: z.kind, bbox: z.bbox,
        ...(z.boxes?.length ? { boxes: z.boxes } : {}),
        ...(z.kind === "res" && z.t !== undefined ? { t_change: seconds(Math.max(b.t0, Math.min(b.t1, z.t))) } : {}),
      })),
      ...(b.kind === "cut" ? { changed_frac: scopedFrames.filter((f) => f.t >= b.t0 && f.t <= b.t1).map((f) => ({ t: seconds(f.t), f: f.changed_frac })) } : {}),
    };
  });
  // Keep close results independently of shot selection and segmentation: a
  // dismissal can occur inside a drag/dwell beat whose action target survives.
  for (const result of revealed) {
    const owner = renderBeats.find((beat) => beat.t0 <= seconds(result.t) && beat.t1 >= seconds(result.t))
      ?? renderBeats.filter((beat) => beat.t0 <= seconds(result.t)).at(-1);
    if (owner) (owner.dialog_results ??= []).push({ t: seconds(result.t), bbox: result.bbox });
  }
  writeFileSync(join(analysisDir, "beats.json"), JSON.stringify(renderBeats, null, 1));

  // 3 decide --------------------------------------------------------------
  let key: string | null = null;
  if (!opts.noJev) {
    try {
      key = opts.apiKey === null ? null : await loadApiKey(opts.apiKey !== undefined
        ? { env: { TYPESAFE_API_KEY: opts.apiKey } } : {});
    } catch {
      warn("Jev secret store unavailable; enable the OS keyring or supply TAKEONE_SECRETS_PASSPHRASE_FD for the BYOKit sealed store");
    }
    if (!key) warn("no Jev key; run takeone key set (stdin); using heuristic policy for all beats");
  }

  // heuristic pre-pass, in shot order, to fill current_shot
  const heuristics: Decision[] = [];
  let viewport: BBox | null = null; // null = full screen
  for (const b of beats) {
    const d = heuristicDecision(b, { viewport: viewport ? { bbox: viewport } : null });
    heuristics.push(d);
    viewport = finalFrame(b, d, winFor(b.anchor_t)?.rect ?? null, take.stream, aspect);
  }

  const decisions: Decision[] = [...heuristics];
  let inputTokens = 0;
  let failed = 0;
  let usd = 0;
  let planned = { planned_tokens: 0, usd: 0 };

  if (key) {
    const minutes = Math.max(takeMs / 60000, 1 / 60);
    const maxTokens = opts.maxTokens ?? Math.ceil(DEFAULT_TOKENS_PER_MIN * minutes);
    if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
      throw new PreflightRefusal("--max-tokens must be a positive integer");
    }
    const ctxs = beats.map((b, i) => ({
      about: opts.about,
      currentShot: shotDescription(beats[i - 1] ?? null, heuristics[i - 1] ?? null, i > 0 ? winFor(beats[i - 1]!.anchor_t)?.rect ?? null : null, take.stream, aspect, opts.capture),
      nextBeat: beats[i + 1],
    }));
    interface Job {
      i: number;
      state: unknown;
      questions: Record<string, Question>;
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
        jobs.push({ i, state: request.state, questions: request.questions });
        plannedTokens += request.tokens;
      } catch (e) {
        if (!(e instanceof RequestTooLarge)) throw e;
        skipped.add(i);
        failed++;
      }
    }
    const reservedTokens = plannedTokens + jobs.filter((j) => j.i > 0).length * REQUEST_TOKEN_CAP;
    planned = { planned_tokens: reservedTokens, usd: (reservedTokens * PRICE_PER_MTOK) / 1e6 };
    if (reservedTokens > maxTokens) {
      throw new PreflightRefusal(
        `planned ${reservedTokens} tokens exceeds the cap of ${maxTokens} (--max-tokens); ` +
          `use --no-jev or raise the cap`,
        { plannedTokens: reservedTokens, cap: maxTokens },
      );
    }
    log(
      `preflight: ${beats.length} beats, ${reservedTokens} planned tokens, $${planned.usd.toFixed(6)} planned`,
    );
    // --plan-only stops here: the plan is priced but no planner call is made
    // and nothing is rendered.
    if (opts.planOnly) {
      return { take, beats, decisions, jev: { input_tokens: 0, usd: 0, failed }, planned, out: null, seconds: 0 };
    }

    const cache = new JevFileCache(join(analysisDir, "jev-cache.jsonl"), { omitRequestBody: opts.capture });
    const outcomes: ({ response: unknown; inputTokens?: number } | "failed")[] = new Array(beats.length);
    await pooled(jobs, CONCURRENCY, async (j) => {
      const r = await askBeat(j.state, j.questions, key, cache, { fetchImpl: opts.fetchImpl,
        usable: (response) => mapJevResponse(beats[j.i]!, response, { viewport: null, winRect: winFor(beats[j.i]!.anchor_t)?.rect ?? null, stream: take.stream, aspect, about: opts.about }) !== null,
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
        viewport: i === 0 ? null : finalFrame(beats[i - 1]!, decisions[i - 1]!, winFor(beats[i]!.anchor_t - 1)?.rect ?? null, take.stream, aspect),
        winRect: winFor(beats[i]!.anchor_t)?.rect ?? null,
        stream: take.stream,
        aspect,
        about: opts.about,
      });
      if (d) {
        if (o.inputTokens) d.input_tokens = o.inputTokens;
        decisions[i] = d;
      } else failed++;
    }

    for (let i = 1; i < beats.length; i++) {
      if (skipped.has(i)) continue;
      const actual = shotDescription(beats[i - 1]!, decisions[i - 1]!, winFor(beats[i - 1]!.anchor_t)?.rect ?? null, take.stream, aspect, opts.capture);
      if (actual === ctxs[i]!.currentShot) continue;
      let state: unknown;
      let questions: Record<string, Question>;
      try {
        const request = buildRequest(beats[i]!, { ...ctxs[i]!, currentShot: actual }, Boolean(opts.about));
        state = request.state;
        questions = request.questions;
      } catch (e) {
        if (!(e instanceof RequestTooLarge)) throw e;
        decisions[i] = heuristics[i]!;
        failed++;
        continue;
      }
      const r = await askBeat(state, questions, key, cache, { fetchImpl: opts.fetchImpl,
        usable: (response) => mapJevResponse(beats[i]!, response, { viewport: null, winRect: winFor(beats[i]!.anchor_t)?.rect ?? null, stream: take.stream, aspect, about: opts.about }) !== null,
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
        viewport: finalFrame(beats[i - 1]!, decisions[i - 1]!, winFor(beats[i]!.anchor_t - 1)?.rect ?? null, take.stream, aspect),
        winRect: winFor(beats[i]!.anchor_t)?.rect ?? null,
        stream: take.stream,
        aspect,
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

  // --plan-only without a planner key: nothing planned, nothing rendered.
  if (opts.planOnly) {
    return { take, beats, decisions, jev: { input_tokens: 0, usd: 0, failed: 0 }, planned, out: null, seconds: 0 };
  }

  const renderDecisions: RenderDecision[] = decisions.map((d) => ({
    ...d, conf: Math.max(0, Math.min(1, d.conf.A ?? d.conf.B ?? d.conf.L ?? 0)),
  }));
  writeFileSync(join(analysisDir, "decisions.jsonl"), renderDecisions.map((d) => JSON.stringify(d)).join("\n") + "\n");
  const jev = { input_tokens: inputTokens, usd, failed };
  take.jev = jev;
  const renderMeta: RenderMeta = {
    id: take.id, width: take.stream.w, height: take.stream.h,
    trim_start: seconds(startMs), trim_end: seconds(endMs),
  };
  writeFileSync(join(dir, "take.json"), JSON.stringify({ ...take, ...renderMeta }, null, 1) + "\n");
  const { out, seconds: renderSeconds } = await renderTake(dir, camera);

  const byJev = decisions.filter((d) => d.decided_by === "jev").length;
  log(`make: ${beats.length} beats; ${byJev} by jev, ${decisions.length - byJev} by heuristic` +
    (key ? `; ${inputTokens} input tokens, $${usd.toFixed(6)}, ${failed} failed` : ""));
  return { take, beats, decisions, jev, planned, out, seconds: renderSeconds };
}

function mapJevResponse(
  beat: Beat,
  response: unknown,
  ctx: { viewport: BBox | null; winRect: BBox | null; stream: { w: number; h: number }; about?: string; aspect?: number },
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
  /** Score probabilities arrive as arrays or as objects keyed by level ("0".."3"). */
  const asProbs = (v: unknown): number[] | undefined => {
    if (Array.isArray(v)) return v.every((n) => typeof n === "number") ? (v as number[]) : undefined;
    if (v && typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>).filter(
        ([k, n]) => /^\d+$/.test(k) && typeof n === "number",
      );
      if (entries.length === 0) return undefined;
      const arr: number[] = [];
      for (const [k, n] of entries) arr[Number(k)] = n as number;
      // dense iff length matches: a skipped level leaves a hole and length > count
      return arr.length === entries.length ? arr : undefined;
    }
    return undefined;
  };
  const asScore = (v: Record<string, unknown> | undefined) =>
    v
      ? {
          probabilities: asProbs(v["probabilities"]),
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
          : ns && typeof ns["noul"] === "number"
            ? { p: ns["noul"] as number }
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
  if (typeof v["noul"] === "number") return v["noul"] as number;
  return undefined;
}

function finalFrame(
  beat: Beat,
  d: Decision,
  winRect: BBox | null,
  stream: { w: number; h: number },
  aspect: number,
): BBox {
  const zone = beat.zones.find((z) => z.name === d.B) ?? null;
  return frameRect(zone, d.L, { stream, winRect, aspect });
}

/** Words for the shot on screen at the start of a beat. */
function shotDescription(prevBeat: Beat | null, prevDecision: Decision | null, winRect: BBox | null, stream: { w: number; h: number }, aspect: number, capture = false): string {
  if (!prevBeat || !prevDecision) return "Framing the entire screen.";
  const z = prevBeat.zones.find((zone) => zone.name === prevDecision.B);
  const shows = z?.desc.shows ?? "the screen";
  // Capture privacy: a coarse zone reference, never rect coordinates.
  if (capture) return `Framing ${shows} in zone ${z?.name ?? "full screen"}.`;
  const rect = finalFrame(prevBeat, prevDecision, winRect, stream, aspect);
  return `Framing ${shows} at ${rect.join(",")}.`;
}

async function addScreenText(
  beat: Beat,
  win: { rect: BBox; title: string; cls: string } | null,
  webm: string,
  videoStartMs: number,
): Promise<void> {
  for (const z of beat.zones) {
    if (z.area_frac >= OCR_MAX_AREA) continue;
    const text = await ocrZone(webm, z.bbox, Math.max(0, Math.max(beat.t0, Math.min(beat.t1, z.t ?? beat.anchor_t)) - videoStartMs));
    if (text) z.desc.text = text;
  }
  if (win && beat.zones.length > 0) {
    const label = [win.cls, win.title].filter(Boolean).map(redactText).join(" ");
    const winZone = beat.zones.find((z) => z.kind === "win" || z.kind === "all");
    if (winZone) winZone.desc.text = winZone.desc.text ? `${winZone.desc.text} ${label}` : label;
  }
}
