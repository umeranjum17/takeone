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
import { beatAnswers, buildChunk, planChunks, TIGHTNESS_LEVELS, CHUNK_TOKEN_CAP, type BeatHint, type ChunkCtx } from "./decide/request.ts";
import { appBrightness, appliedFilm, buildFilm, filmOverrides, mapFilm, type FilmDecision } from "./decide/film.ts";
import type { Answer, DecideCache, ImageInput } from "@byokit/decide";
import { ConfigError } from "@byokit/decide";
import { KeystoreError } from "@byokit/secrets";
import { SecretStoreUnavailable } from "./secrets.ts";
import { heuristicDecision, RULE_WORDS } from "./decide/heuristics.ts";
import { mapAnswers, frameRect } from "./decide/mapping.ts";
import {
  askChunk,
  toPlannerAnswers,
  resolvePlanner,
  PlannerUnavailable,
  PlannerFileCache,
  seesImages,
  modelOf,
  pooled,
  type ResolvedPlanner,
  type AskOutcome,
} from "./decide/planner.ts";
import { estimateUsd } from "./decide/prices.ts";
import { keyframeThumb, ocrZone } from "./decide/ocr.ts";
import { redactText } from "./decide/redact.ts";
import { renderTake } from "./render/render.ts";
import { resolveTheme } from "./themes.ts";
import { DEFAULTS, applyOverrides, type CameraDefaults } from "./camera/defaults.ts";
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
  /** Style hint for the film call. */
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
  /** The raw `--set key=value` pairs; a key set here is never replaced by the film call. */
  set?: string[];
  /** false skips the film call; the chunk requests are unchanged. */
  film?: boolean;
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

/** Planner accounting for one make. `requests` counts planner asks, cache hits
 * included (`cached`); `request_tokens` is their estimated size. */
export interface PlannerStats {
  input_tokens: number;
  output_tokens: number;
  usd: number | null;
  failed: number;
  requests: number;
  cached: number;
  request_tokens: number;
}

export interface MakeResult {
  take: TakeMeta;
  beats: Beat[];
  decisions: Decision[];
  /** usd is null when the backend's price is unknown ("cost unknown"), never a made-up $0 */
  planner: PlannerStats;
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
  delete take.film; // a film from an earlier make stays only if this make decides one
  // Portrait takes (phone footage) default to a portrait output unless the
  // caller overrode the output size; desktop behaviour is unchanged.
  const themed = resolveTheme(opts.theme ?? take.theme);
  if (opts.theme !== undefined) take.theme = opts.theme;
  let camera = opts.camera
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
  let plannerOff = "no credential is set";
  if (!opts.noAi) {
    try {
      planner = await resolvePlanner({
        apiKeyOverride: opts.apiKey,
        ...(opts.configDir === undefined ? {} : { configDir: opts.configDir }),
      });
    } catch (e) {
      // A corrupt planner.json is user error: fail fast instead of hiding it
      // behind the fallback. An unreadable secret store falls back, and the
      // banner names it.
      if (e instanceof ConfigError) throw e;
      if (!(e instanceof SecretStoreUnavailable) &&
          !(e instanceof KeystoreError && ["unavailable", "unsupported"].includes(e.code))) throw e;
      planner = null;
      plannerOff = "the secret store cannot be read";
    }
    if (planner && !planner.active) {
      if (!planner.defaulted && opts.apiKey === undefined) {
        // The user chose a provider but its credential is missing: stop with
        // the choices instead of silently falling back (or switching provider).
        const auth = (planner.config as { auth: string }).auth;
        throw new PlannerUnavailable(planner.label, `no ${auth === "account" ? "sign-in" : "key"} for ${planner.label}`);
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
      tap: take.device === "android",
    });
    if (take.device === "android" && b.actions.some((action) => action.k === "click")) {
      b.hint = "The first candidate zone is the tapped control; prefer it for the action's start shot.";
    }
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
      ...(b.hint ? { hint: b.hint } : {}),
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
      ` AI planner is OFF: ${plannerOff}. This film uses fallback rules:\n` +
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
  let filmDecision: FilmDecision | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let failed = 0;
  let requests = 0;
  let cachedRequests = 0;
  let requestTokens = 0;
  const minutes = Math.max(takeMs / 60000, 1 / 60);
  let usd: number | null = 0;
  let planned: MakeResult["planned"] = { planned_tokens: 0, usd: 0 };
  const plannerBackend = planner ? (planner.config as { backend: string }).backend : null;
  const plannerModel = planner ? modelOf(planner.config) : null;

  if (planner) {
    const maxTokens = opts.maxTokens ?? Math.ceil(DEFAULT_TOKENS_PER_MIN * minutes);
    if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
      throw new PreflightRefusal("--max-tokens must be a positive integer");
    }
    // Thumbnails go to a decider that reads images; a capture sends them only
    // with screen text opted in. Without screen text every word is blacked out.
    const vision = (!opts.capture || opts.screenText === true) && await seesImages(planner);
    const frameTime = (t: number) => Math.max(videoStartMs, Math.min(endMs, t));
    const resultMs = (b: Beat) => frameTime(Math.max(b.t1, ...b.zones
      .filter((z) => z.kind === "res" && z.t !== undefined)
      .map((z) => Math.max(b.t0, z.t!))));
    // Keyframes for a model that reads images: the action, and the result when the beat has one.
    const keyframes = (b: Beat) => [
      { id: `${b.id}_act`, t: frameTime(b.anchor_t) },
      ...(b.zones.some((z) => z.kind === "res") ? [{ id: `${b.id}_res`, t: resultMs(b) }] : []),
    ];
    const images = new Map<string, ImageInput>();
    let thumbsRead = false; // before extraction the preflight counts every planned thumbnail
    const chunkCtx = (group: number[], decided: Decision[]): ChunkCtx => {
      const i0 = group[0]!;
      const iN = group.at(-1)!;
      // The rules' choice for every beat of the chunk, starting from the shot
      // the previous chunk decided: the hints, and the in-chunk shot guess.
      const hints = new Map<number, BeatHint>();
      let shot: BBox | null = i0 === 0 ? null : finalFrame(beats[i0 - 1]!, decided[i0 - 1]!, winFor(beats[i0 - 1]!.anchor_t)?.rect ?? null, take.stream, aspect);
      for (let i = i0; i <= iN; i++) {
        const d = heuristicDecision(beats[i]!, { viewport: shot ? { bbox: shot } : null });
        hints.set(i, {
          suggest_shot: { start: d.A, end: d.B, tightness: TIGHTNESS_LEVELS[d.L]!, rule: RULE_WORDS[beats[i]!.kind] },
          fits_current_shot: d.p === 0 ? "yes" : "no",
        });
        shot = finalFrame(beats[i]!, d, winFor(beats[i]!.anchor_t)?.rect ?? null, take.stream, aspect);
      }
      return {
        goal: opts.goal,
        style: opts.style,
        currentShot: shotDescription(beats[i0 - 1] ?? null, decided[i0 - 1] ?? null, i0 > 0 ? winFor(beats[i0 - 1]!.anchor_t)?.rect ?? null : null, take.stream, aspect, opts.capture),
        nextBeat: beats[iN + 1],
        hints: group.map((i) => hints.get(i)!),
        ...(vision ? { images: group.map((i) => keyframes(beats[i]!).map((k) => k.id).filter((id) => !thumbsRead || images.has(id))) } : {}),
      };
    };
    const build = (decided: Decision[]) => (group: number[]) => {
      const chunk = buildChunk(group.map((i) => beats[i]!), chunkCtx(group, decided));
      noteTrimmedContext(chunk.trimmed);
      return chunk;
    };
    // Beats with one zone have nothing to choose; they keep the rules uncounted.
    const asked = beats.map((_, i) => i).filter((i) => beats[i]!.zones.length >= 2);
    const chunks = planChunks(asked, build(heuristics), () => failed++);
    // The film call decides the whole take once; a take too long for one request keeps the base look.
    const filmPlan = beats.length === 0 || opts.film === false ? null : buildFilm({
      goal: opts.goal, style: opts.style, seconds: takeMs / 1000,
      source: `${take.stream.w}x${take.stream.h}`, device: take.device ?? "desktop",
      brightness: appBrightness(dec.frames), beats,
    });
    if (!filmPlan && beats.length > 0 && opts.film !== false) warn(`film call: the take is over ${CHUNK_TOKEN_CAP} estimated tokens for one request; the film keeps the base look`);
    const plannedTokens = chunks.reduce((n, c) => n + c.chunk.tokens, 0) + (filmPlan?.tokens ?? 0);
    // One re-ask of the largest chunk is reserved for a malformed answer.
    const reservedTokens = plannedTokens + Math.max(0, ...chunks.map((c) => c.chunk.tokens));
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
    const thumbCount = vision ? chunks.flatMap((c) => c.items).reduce((n, i) => n + keyframes(beats[i]!).length, 0) : 0;
    log(
      `AI planner: ${planner.label}. ${beats.length} beats, ${chunks.length + (filmPlan ? 1 : 0)} calls planned, ${planned.usd === null ? "cost unknown" : `about $${planned.usd.toFixed(4)}`}.` +
      (readScreenText ? " reading screen words (redacted; turn off with --no-screen-text)" : "") +
      (vision ? ` ${thumbCount} redacted keyframe thumbnails.` : ""),
    );
    log(
      `preflight: ${beats.length} beats, ${chunks.length + (filmPlan ? 1 : 0)} calls (film included), ${reservedTokens} planned tokens, ${costText(planned.usd)} planned`,
    );
    // --plan-only stops here: the plan is priced but no planner call is made
    // and nothing is rendered.
    if (opts.planOnly) {
      return { take, beats, decisions, planner: { input_tokens: 0, output_tokens: 0, usd: 0, failed, requests: 0, cached: 0, request_tokens: 0 }, planned, out: null, seconds: 0 };
    }

    if (vision) {
      let warned = false;
      const shots = chunks.flatMap((c) => c.items).flatMap((i) => keyframes(beats[i]!).map((k) => ({ ...k, i })));
      await pooled(shots, 2, async (k) => {
        try {
          const textZones = readScreenText ? beats[k.i]!.zones.filter((z) => z.area_frac < OCR_MAX_AREA).map((z) => z.bbox) : [];
          const bytes = await keyframeThumb(webm, k.t - videoStartMs, beats[k.i]!.zones, textZones, take.stream);
          images.set(k.id, { id: k.id, mime: "image/jpeg", bytes });
        } catch (e) {
          if (!warned) warn(`keyframe thumbnails: ${e instanceof Error ? e.message : String(e)}; those beats ask with zone notes only`);
          warned = true;
        }
      });
      thumbsRead = true;
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
    const takeOutcome = (r: AskOutcome): void => {
      if (r.inputTokens) {
        inputTokens += r.inputTokens;
        const cost = estimateUsd(plannerBackend!, r.inputTokens);
        usd = usd === null || cost === undefined ? null : usd + cost;
      }
      if (r.outputTokens) outputTokens += r.outputTokens;
    };
    // The film call runs first: its answers set the look, and its tokens are already reserved.
    if (filmPlan) {
      const r = await askChunk(filmPlan.state, filmPlan.questions, planner, cache, { fetchImpl: opts.fetchImpl, keepAnswers: true });
      requests++;
      requestTokens += filmPlan.tokens;
      if (r.decisionSource === "cache") cachedRequests++;
      takeOutcome(r);
      filmDecision = mapFilm(r.answers ?? {}, filmPlan.endings);
    }
    let reasks = 1;
    let overReserve = 0;
    // Chunks run in order: each one starts from the shot the previous chunk decided.
    for (const [c, plannedChunk] of chunks.entries()) {
      const later = chunks.slice(c + 1).reduce((n, next) => n + next.chunk.tokens, 0);
      const rebuilt = planChunks(plannedChunk.items, build(decisions), () => failed++);
      let remaining = rebuilt.reduce((n, part) => n + part.chunk.tokens, 0);
      // Reserve every rebuilt sibling, later planned chunk, and the possible re-ask.
      const covered = (tokens: number) => requestTokens + tokens + (remaining - tokens) + later <= reservedTokens;
      for (const { items, chunk } of rebuilt) {
        if (!covered(chunk.tokens)) {
          remaining -= chunk.tokens;
          failed += items.length;
          overReserve += items.length;
          continue;
        }
        const ask = async (from: DecideCache) => {
          const r = await askChunk(chunk.state, chunk.questions, planner, from, { fetchImpl: opts.fetchImpl,
            usable: (answers) => items.every((i) => {
              const a = toPlannerAnswers(beatAnswers(answers, beats[i]!.id));
              return a !== null && mapAnswers(beats[i]!, a, mapCtx(i)) !== null;
            }),
            images: items.flatMap((i) => keyframes(beats[i]!)).flatMap((k) => images.get(k.id) ?? []),
          });
          // PlannerUnavailable (provider limit, auth or timeout) propagates: the
          // run stops before rendering instead of silently using rules.
          requests++;
          requestTokens += chunk.tokens;
          if (r.decisionSource === "cache") cachedRequests++;
          takeOutcome(r);
          return r;
        };
        const outcomes = [await ask(cache)];
        remaining -= chunk.tokens;
        if (outcomes[0]!.decisionSource === "failed" && reasks > 0 && requestTokens + chunk.tokens + remaining + later <= reservedTokens) {
          // A malformed chunk is asked once more without the cache; beats the
          // re-ask still cannot map keep the first answer, then the rules.
          reasks--;
          outcomes.unshift(await ask({ get: async () => undefined, set: (k, v) => cacheFile.set(k, v) }));
        }
        for (const i of items) {
          const viewport = i === 0 ? null : finalFrame(beats[i - 1]!, decisions[i - 1]!, winFor(beats[i]!.anchor_t - 1)?.rect ?? null, take.stream, aspect);
          let d: Decision | null = null;
          for (const o of outcomes) {
            d = o.answers ? mapPlannerResponse(beats[i]!, beatAnswers(o.answers, beats[i]!.id), { ...mapCtx(i), viewport }) : null;
            if (d) {
              if (o.inputTokens) d.input_tokens = o.inputTokens;
              break;
            }
          }
          if (d) decisions[i] = d;
          else failed++;
        }
      }
    }
    if (overReserve) warn(`planner: ${overReserve} beats keep the rules; their rebuilt chunk no longer fit the preflight reserve`);
  }
  if (filmDecision) {
    // Theme tokens, then the film's choices, then the user's --set pairs (never replaced) and a picked theme.
    const pinned = (opts.set ?? []).map((pair) => pair.split("=")[0]!);
    const f = appliedFilm(filmDecision, { pinned, themeFree: take.theme === undefined, endFree: take.trim?.end === undefined });
    camera = applyOverrides(filmOverrides(f, take.theme === undefined, pinned), camera);
    take.film = f;
    const theme = take.theme !== undefined ? `kept (${take.theme} picked)` : f.theme ?? "unchanged";
    log(`film: theme ${theme}, pace ${f.pace ?? "unchanged"}, camera ${f.camera_path ?? "unchanged"}, ` +
      `opening ${f.establish_s ?? "unchanged"} s, ends on ${f.end_beat ?? "unchanged"} (${Object.values(f.by).filter((v) => v === "ai").length} of ${Object.keys(f.by).length} by AI)`);
  }

  // --plan-only without a planner credential: nothing planned, nothing rendered.
  if (opts.planOnly) {
    return { take, beats, decisions, planner: { input_tokens: 0, output_tokens: 0, usd: 0, failed: 0, requests: 0, cached: 0, request_tokens: 0 }, planned, out: null, seconds: 0 };
  }

  const renderDecisions: RenderDecision[] = decisions.map((d) => ({
    ...d, conf: Math.max(0, Math.min(1, d.conf.A ?? d.conf.B ?? d.conf.L ?? 0)),
  }));
  writeFileSync(join(analysisDir, "decisions.jsonl"), renderDecisions.map((d) => JSON.stringify(d)).join("\n") + "\n");
  const byAi = decisions.filter((d) => d.decided_by === "ai").length;
  const byRule = decisions.length - byAi;
  const plannerStats: PlannerStats = {
    input_tokens: inputTokens, output_tokens: outputTokens, usd, failed,
    requests, cached: cachedRequests, request_tokens: requestTokens,
  };
  take.planner = {
    mode: byAi > 0 ? "ai" : "fallback",
    backend: plannerBackend,
    model: plannerModel,
    ...plannerStats,
    calls_per_min: Math.round((requests / minutes) * 10) / 10,
    request_tokens_per_min: Math.round(requestTokens / minutes),
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
  // The film's ending keeps an outro after its beat.
  const filmEnd = take.film?.end_beat;
  if (filmEnd !== undefined) {
    const end = renderBeats.find((b) => b.id === filmEnd)!;
    meta.trim_end = Math.min(seconds(videoEndMs), end.t1 + camera.outro_s);
  }
  writeFileSync(join(dir, "take.json"), JSON.stringify(meta, null, 1) + "\n");
  const { out, seconds: renderSeconds } = await renderTake(dir, camera);

  if (planner) {
    log(`plan: ${byAi} choices by AI, ${byRule} by rules. ` +
      `make: ${beats.length} beats; ${byAi} by ai, ${byRule} by heuristic; ` +
      `${inputTokens} input tokens, ${costText(usd)}, ${failed} failed`);
    log(`planner: ${requests} requests (${cachedRequests} from cache), ${requestTokens} request tokens; ` +
      `${take.planner.calls_per_min} calls a minute, ${take.planner.request_tokens_per_min} request tokens a minute`);
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
