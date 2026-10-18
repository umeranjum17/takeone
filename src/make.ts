import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  Beat,
  Decision,
  FrameRegions,
  TakeMeta,
} from "./types.ts";
import { dialogResults } from "./perceive/dialogs.ts";
import { perceiveRegions } from "./perceive/regions.ts";
import { analyzeUiBoxes } from "./perceive/boxes.ts";
import { actionsFromEvents } from "./perceive/actions.ts";
import { decodeAnalysisFrames, firstFrameTimeMs, readEvents } from "./perceive/decode.ts";
import { segmentBeats, actStart, resultTime, RESULT_MIN_AREA } from "./beats/segment.ts";
import { actionVideoSeconds } from "./beats/clock.ts";
import { zonesForBeat, OCR_MAX_AREA } from "./beats/zones.ts";
import { buildRequest, REQUEST_TOKEN_CAP, RequestTooLarge } from "./decide/request.ts";
import type { Answer, DecideCache, Question } from "@byokit/decide";
import { ConfigError } from "@byokit/decide";
import { heuristicDecision } from "./decide/heuristics.ts";
import { mapAnswers, frameRect } from "./decide/mapping.ts";
import {
  askBeat,
  toPlannerAnswers,
  resolvePlanner,
  PlannerUnavailable,
  CONCURRENCY,
  PlannerFileCache,
  modelOf,
  pooled,
  type ResolvedPlanner,
  type AskOutcome,
} from "./decide/planner.ts";
import { estimateUsd } from "./decide/prices.ts";
import { ocrZone } from "./decide/ocr.ts";
import { redactText } from "./decide/redact.ts";
import { renderTake } from "./render/render.ts";
import { resolveTheme } from "./themes.ts";
import { DEFAULTS, type CameraDefaults } from "./camera/defaults.ts";
import type { Beat as RenderBeat, Decision as RenderDecision, TakeMeta as RenderMeta } from "./camera/types.ts";
import { clampBBox, type BBox } from "./types.ts";

export const DEFAULT_TOKENS_PER_MIN = 40000;

/** Analysis runs at 10 fps, so the recording end lands within one frame of it. */
const ANALYSIS_FRAME_MS = 100;

export interface MakeOptions {
  /** Capture privacy: drop window titles, cache hashes only, no coords in current_shot. */
  capture?: boolean;
  /** Decide every beat with the local heuristic; zero network calls. */
  noAi?: boolean;
  /** What the demo is for; sharpens key moments. Alias --about. */
  goal?: string;
  /** Style hint for the film call (slice 5); recorded, not yet decided on. */
  style?: string;
  /** Opt out of screen words (on by default when the planner runs). */
  noScreenText?: boolean;
  /** Explicit opt-in for screen words on the privacy-scoped capture surface. */
  screenText?: boolean;
  /** Ignore saved planner answers and ask again. */
  replan?: boolean;
  maxTokens?: number;
  /** Host-passed BYOKit credential override for the configured backend;
   * null disables the planner, undefined loads the configured store. */
  apiKey?: string | null;
  /** Config dir holding planner.json and the sealed store; defaults to the
   * platform config dir. Tests point it at a throwaway dir. */
  configDir?: string;
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
  /** usd is null when the backend's price is unknown ("cost unknown"), never a made-up $0 */
  planner: { input_tokens: number; output_tokens: number; usd: number | null; failed: number };
  /** reserved preflight tokens and their planned cost; zeros without a planner credential */
  planned: { planned_tokens: number; usd: number | null };
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

/**
 * Static-head trim for video-only takes (no input events). The first frame
 * carrying a change region worth a beat opens the film, less a short lead so
 * the change itself is never cut; a take that never changes keeps its start.
 * The threshold matches the segmenter's own change beats, and the lead
 * mirrors the record-time trim's 500 ms.
 */
export const VIDEO_ONLY_HEAD_LEAD_MS = 500;

export function videoOnlyHeadStart(frames: FrameRegions[], recordStartMs: number): number {
  const first = frames.find((f) =>
    f.t >= recordStartMs && f.regions.some((r) => r.area_frac >= RESULT_MIN_AREA),
  );
  if (first === undefined) return recordStartMs;
  return Math.max(recordStartMs, first.t - VIDEO_ONLY_HEAD_LEAD_MS);
}

export async function makeTake(dir: string, opts: MakeOptions = {}): Promise<MakeResult> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const warn = opts.warn ?? ((s: string) => console.error(s));
  let warnedTrimmedContext = false;
  const noteTrimmedContext = (trimmed: boolean) => {
    if (trimmed && !warnedTrimmedContext) {
      warnedTrimmedContext = true;
      warn("planner request exceeded its context budget; shortened style or goal");
    }
  };
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

  // 0 planner -----------------------------------------------------------
  // Resolve the provider-agnostic decider before perception output is built:
  // screen words are read by default only when the planner will actually run.
  let planner: ResolvedPlanner | null = null;
  if (!opts.noAi) {
    try {
      planner = await resolvePlanner({
        apiKeyOverride: opts.apiKey,
        ...(opts.configDir === undefined ? {} : { configDir: opts.configDir }),
      });
    } catch (e) {
      // A corrupt planner.json is user error: fail fast instead of hiding it
      // behind the fallback. Anything else (no store, no credential) falls back.
      if (e instanceof ConfigError) throw e;
      planner = null;
      warn("planner store unavailable; using heuristic policy for all beats");
    }
    if (planner && !planner.active) {
      if (!planner.defaulted && opts.apiKey === undefined) {
        // The user chose a provider but its credential is missing: stop with
        // the choices instead of silently falling back (or switching provider).
        const auth = (planner.config as { auth: string }).auth;
        throw new PlannerUnavailable(planner.label, `no ${auth === "account" ? "sign-in" : "key"} for ${planner.label}`, opts.capture ? "--no-planner" : "--no-ai");
      }
      planner = null;
    }
  }
  const aiActive = planner !== null;
  const readScreenText = aiActive && !opts.noScreenText && (!opts.capture || opts.screenText === true);

  // 1 perceive ------------------------------------------------------------
  let videoStartMs: number;
  try {
    videoStartMs = firstFrameTimeMs(framesTsv, take);
  } catch {
    throw new TakeInputError("frames.tsv", "invalid first frame timestamp");
  }
  const dec = await decodeAnalysisFrames(webm, take, framesTsv);
  const videoEndMs = videoStartMs + dec.frames.length * 100;
  const recordStartMs = Math.max(videoStartMs, take.trim?.start ?? videoStartMs);
  const endMs = Math.min(videoEndMs, take.trim?.end ?? videoEndMs);
  if (!(endMs > recordStartMs)) throw new TakeInputError("take.json", "trim does not overlap video");
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
  // Video-only takes have no input events, so the record-time trim never
  // anchors and the film would open on the static head. Start just before the
  // first visual change instead; takes with events keep the record trim.
  const startMs = take.events === "none" ? videoOnlyHeadStart(frames, recordStartMs) : recordStartMs;
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
  const beats = segmentBeats(actions, scopedFrames, { stream: take.stream, takeMs, startMs, endMs, videoOnly: take.events === "none" });
  const uiBoxes = analyzeUiBoxes(dec, take.stream, startMs, endMs, beats.flatMap(b =>
    [b.anchor_t, ...b.actions.map(actStart), resultTime(b, scopedFrames) ?? b.anchor_t]));
  writeFileSync(join(analysisDir, "ui-boxes.json"), JSON.stringify(uiBoxes, null, 1));
  log(`UI boxes: ${uiBoxes.cost.references} references; ${uiBoxes.cost.analysis_ms_per_minute.toFixed(1)} ms/min; zero model calls`);
  for (const b of beats) {
    const win = winFor(b.anchor_t);
    b.zones = zonesForBeat(b, {
      winRect: win?.rect ?? null,
      stream: take.stream,
      scale: take.scale ?? 1,
      frames: scopedFrames,
      uiBoxes: uiBoxes.frames,
    });
    if (readScreenText) await addScreenText(b, opts.capture ? null : win, webm, videoStartMs);
  }
  const seconds = (ms: number) => (ms - videoStartMs) / 1000;
  const renderBeats: RenderBeat[] = beats.map((b) => {
    const window = winFor(b.anchor_t);
    const windowRect = window && clampBBox(window.rect, take.stream.w, take.stream.h);
    // A result lands after the beat's last action; the beat stays live until it.
    const resultT = Math.max(b.t1, ...b.zones
      .filter((z) => z.kind === "res" && z.t !== undefined)
      .map((z) => Math.max(b.t0, Math.min(endMs, z.t!))));
    return {
      id: b.id, t0: seconds(b.t0), t1: seconds(resultT), anchor_t: seconds(b.anchor_t),
      kind: b.kind, window_cls: b.window_cls,
      ...(windowRect ? { window_rect: windowRect } : {}),
      actions: b.actions.map(a => actionVideoSeconds(a, videoStartMs)),
      zones: b.zones.map((z) => ({ name: z.name, type: z.kind, bbox: z.bbox,
        ...(z.boxes?.length ? { boxes: z.boxes } : {}),
        // A typed field changes when typing starts: a shot that ends on it arrives then, not at beat end.
        ...((z.kind === "res" || z.kind === "txt") && z.t !== undefined ? { t_change: seconds(Math.max(b.t0, Math.min(endMs, z.t))) } : {}),
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
  if (!planner && !opts.noAi) {
    warn(
      "──────────────────────────────────────────────────────────────\n" +
      " AI planner is OFF: no credential is set. This film uses fallback rules:\n" +
      " generic framing, every pause sped up, no captions, default theme.\n" +
      " Set a key:  read -rs k; printf %s \"$k\" | takeone key set\n" +
      " Hide this:  takeone make <id> --no-ai\n" +
      "──────────────────────────────────────────────────────────────",
    );
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
  let outputTokens = 0;
  let failed = 0;
  let usd: number | null = 0;
  let planned: MakeResult["planned"] = { planned_tokens: 0, usd: 0 };
  const plannerBackend = planner ? (planner.config as { backend: string }).backend : null;
  const plannerModel = planner ? modelOf(planner.config) : null;

  if (planner) {
    const minutes = Math.max(takeMs / 60000, 1 / 60);
    const maxTokens = opts.maxTokens ?? Math.ceil(DEFAULT_TOKENS_PER_MIN * minutes);
    if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
      throw new PreflightRefusal("--max-tokens must be a positive integer");
    }
    const ctxs = beats.map((b, i) => ({
      goal: opts.goal,
      style: opts.style,
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
        const request = buildRequest(beats[i]!, ctxs[i]!);
        noteTrimmedContext(request.trimmed);
        jobs.push({ i, state: request.state, questions: request.questions });
        plannedTokens += request.tokens;
      } catch (e) {
        if (!(e instanceof RequestTooLarge)) throw e;
        skipped.add(i);
        failed++;
      }
    }
    const reservedTokens = plannedTokens + jobs.filter((j) => j.i > 0).length * REQUEST_TOKEN_CAP;
    // The ceiling is estimated in the default request shape; other backends
    // answer the same questions, so the bound still holds within its margin.
    planned = { planned_tokens: reservedTokens, usd: estimateUsd(plannerBackend!, reservedTokens) ?? null };
    if (reservedTokens > maxTokens) {
      throw new PreflightRefusal(
        `planned ${reservedTokens} tokens exceeds the cap of ${maxTokens} (--max-tokens); ` +
          `use --no-ai or raise the cap`,
        { plannedTokens: reservedTokens, cap: maxTokens },
      );
    }
    log(
      `AI planner: ${planner.label}. ${beats.length} beats, ${jobs.length} calls planned, ${planned.usd === null ? "cost unknown" : `about $${planned.usd.toFixed(4)}`}.` +
      (readScreenText ? " reading screen words (redacted; turn off with --no-screen-text)" : ""),
    );
    log(
      `preflight: ${beats.length} beats, ${reservedTokens} planned tokens, ${costText(planned.usd)} planned`,
    );
    // --plan-only stops here: the plan is priced but no planner call is made
    // and nothing is rendered.
    if (opts.planOnly) {
      return { take, beats, decisions, planner: { input_tokens: 0, output_tokens: 0, usd: 0, failed }, planned, out: null, seconds: 0 };
    }

    const cacheFile = new PlannerFileCache(join(analysisDir, "planner-cache.jsonl"));
    const cache: DecideCache = opts.replan
      ? { get: async () => undefined, set: (k, v) => cacheFile.set(k, v) }
      : cacheFile;
    const mapCtx = (i: number) => ({
      viewport: null as BBox | null,
      winRect: winFor(beats[i]!.anchor_t)?.rect ?? null,
      stream: take.stream,
      aspect,
      model: plannerModel!,
    });
    const outcomes: AskOutcome[] = new Array(beats.length);
    await pooled(jobs, CONCURRENCY, async (j) => {
      const r = await askBeat(j.state, j.questions, planner, cache, { fetchImpl: opts.fetchImpl,
        usable: (answers) => toPlannerAnswers(answers) !== null &&
          mapAnswers(beats[j.i]!, toPlannerAnswers(answers)!, mapCtx(j.i)) !== null,
      });
      // PlannerUnavailable (provider limit, auth or timeout) propagates: the
      // run stops before rendering instead of silently using rules.
      outcomes[j.i] = r;
    });
    const takeOutcome = (r: AskOutcome): void => {
      if (r.inputTokens) {
        inputTokens += r.inputTokens;
        const cost = estimateUsd(plannerBackend!, r.inputTokens);
        usd = usd === null || cost === undefined ? null : usd + cost;
      }
      if (r.outputTokens) outputTokens += r.outputTokens;
    };
    const failedBeats = new Set<number>();
    for (let i = 0; i < beats.length; i++) {
      if (skipped.has(i)) continue;
      const o = outcomes[i]!;
      takeOutcome(o);
      const d = o.decisionSource === "failed" ? null : mapPlannerResponse(beats[i]!, o.answers!, {
        ...mapCtx(i),
        viewport: i === 0 ? null : finalFrame(beats[i - 1]!, decisions[i - 1]!, winFor(beats[i]!.anchor_t - 1)?.rect ?? null, take.stream, aspect),
      });
      if (d) {
        if (o.inputTokens) d.input_tokens = o.inputTokens;
        decisions[i] = d;
      } else {
        failedBeats.add(i);
        failed++;
      }
    }

    for (let i = 1; i < beats.length; i++) {
      if (skipped.has(i)) continue;
      const actual = shotDescription(beats[i - 1]!, decisions[i - 1]!, winFor(beats[i - 1]!.anchor_t)?.rect ?? null, take.stream, aspect, opts.capture);
      if (actual === ctxs[i]!.currentShot) continue;
      let state: unknown;
      let questions: Record<string, Question>;
      try {
        const request = buildRequest(beats[i]!, { ...ctxs[i]!, currentShot: actual });
        noteTrimmedContext(request.trimmed);
        state = request.state;
        questions = request.questions;
      } catch (e) {
        if (!(e instanceof RequestTooLarge)) throw e;
        continue;
      }
      const r = await askBeat(state, questions, planner, cache, { fetchImpl: opts.fetchImpl,
        usable: (answers) => toPlannerAnswers(answers) !== null &&
          mapAnswers(beats[i]!, toPlannerAnswers(answers)!, mapCtx(i)) !== null,
      });
      takeOutcome(r);
      if (r.decisionSource === "failed") continue;
      const d = mapPlannerResponse(beats[i]!, r.answers!, {
        ...mapCtx(i),
        viewport: finalFrame(beats[i - 1]!, decisions[i - 1]!, winFor(beats[i]!.anchor_t - 1)?.rect ?? null, take.stream, aspect),
      });
      if (d) {
        if (r.inputTokens) d.input_tokens = r.inputTokens;
        decisions[i] = d;
        if (failedBeats.delete(i)) failed--;
      }
    }
  }

  // --plan-only without a planner credential: nothing planned, nothing rendered.
  if (opts.planOnly) {
    return { take, beats, decisions, planner: { input_tokens: 0, output_tokens: 0, usd: 0, failed: 0 }, planned, out: null, seconds: 0 };
  }

  const renderDecisions: RenderDecision[] = decisions.map((d) => ({
    ...d, conf: Math.max(0, Math.min(1, d.conf.A ?? d.conf.B ?? d.conf.L ?? 0)),
  }));
  writeFileSync(join(analysisDir, "decisions.jsonl"), renderDecisions.map((d) => JSON.stringify(d)).join("\n") + "\n");
  const byAi = decisions.filter((d) => d.decided_by === "ai").length;
  const byRule = decisions.length - byAi;
  const plannerStats = { input_tokens: inputTokens, output_tokens: outputTokens, usd, failed };
  take.planner = {
    mode: byAi > 0 ? "ai" : "fallback",
    backend: plannerBackend,
    model: plannerModel,
    ...plannerStats,
  };
  const renderMeta: RenderMeta = {
    id: take.id, width: take.stream.w, height: take.stream.h,
    trim_start: seconds(startMs), duration: seconds(videoEndMs),
  };
  // record.ts marks the trim it wrote; that one ends at the recording length, so
  // it bounds nothing and honouring it would export the dead tail past the last
  // result. Any other trim is the caller's and is exported as given, clamped to
  // the recording. An end an earlier run recorded is not a caller's trim either.
  // Takes recorded before the marker existed carry no provenance: their trim end
  // is the capture length, which the 10 fps analysis timeline rounds to a frame
  // boundary in either direction, so an unmarked end within one analysis frame of
  // the video's end is record's too.
  const meta: RenderMeta = { ...take, ...renderMeta };
  const trimEnd = take.trim?.end;
  const recorderOwned = trimEnd !== undefined && Math.abs(videoEndMs - trimEnd) <= ANALYSIS_FRAME_MS;
  const autoTrim = take.auto_trim === true ? trimEnd === take.duration_ms : recorderOwned;
  if (take.trim?.end !== undefined && !autoTrim) meta.trim_end = seconds(endMs);
  else delete meta.trim_end;
  writeFileSync(join(dir, "take.json"), JSON.stringify(meta, null, 1) + "\n");
  const { out, seconds: renderSeconds } = await renderTake(dir, camera);

  if (planner) {
    log(`plan: ${byAi} choices by AI, ${byRule} by rules. ` +
      `make: ${beats.length} beats; ${byAi} by ai, ${byRule} by heuristic; ` +
      `${inputTokens} input tokens, ${costText(usd)}, ${failed} failed`);
  } else {
    log(`make: ${beats.length} beats; ${byRule} by heuristic (planner: fallback)`);
  }
  return { take, beats, decisions, planner: plannerStats, planned, out, seconds: renderSeconds };
}

function costText(usd: number | null): string {
  return usd === null ? "cost unknown" : `$${usd.toFixed(6)}`;
}

function mapPlannerResponse(
  beat: Beat,
  answers: Record<string, Answer>,
  ctx: { viewport: BBox | null; winRect: BBox | null; stream: { w: number; h: number }; aspect?: number; model: string },
): Decision | null {
  const adapted = toPlannerAnswers(answers);
  if (!adapted) return null;
  const d = mapAnswers(beat, adapted, ctx);
  if (d) d.input_tokens = undefined; // set by the caller from usage
  return d;
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
