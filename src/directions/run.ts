// `takeone directions` and `takeone pick`: render two or three distinct cuts of one planned take, have the independent
// judge score each from sampled frames, post them to the sign-off board as one pick, and save the picked one on the take.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CameraDefaults } from "../camera/defaults.ts";
import type { TakeMeta } from "../camera/types.ts";
import { makeTake } from "../make.ts";
import { renderTake } from "../render/render.ts";
import { askChunk, PlannerFileCache, PlannerUnavailable, resolveJudge, resolvePlanner, type ResolvedPlanner } from "../decide/planner.ts";
import { JudgeUnavailable, judgeRound, type JudgedCard } from "../score/judge.ts";
import { clearOverlays, compareFrames, frameHashes, measureFilm } from "../score/measure.ts";
import type { Determinism } from "../score/loop.ts";
import { boardFile, cardAnswer, postCard, replaceCard } from "../board/board.ts";
import { DIRECTION_IDS, directionsRequest, mapDirections, presetDirections, type Direction, type DirectionId, type PickedDirection } from "./directions.ts";

export interface DirectionsOptions {
  dir: string;
  count: number;
  noAi: boolean;
  goal?: string;
  style?: string;
  replan: boolean;
  set: string[];
  board?: string;
  configDir?: string;
  /** Injectable for tests: recorded routes instead of the configured planner and judge. */
  planner?: ResolvedPlanner;
  judge?: ResolvedPlanner;
  fetchImpl?: typeof fetch;
  log: (line: string) => void;
  warn: (line: string) => void;
  resolveCamera: (dir: string, pairs: string[], theme?: string) => CameraDefaults;
}

export interface JudgedDirection extends Direction {
  film: string;
  score: number | null;
  items: JudgedCard["items"];
  gaps: string[];
}

export interface DirectionsFile {
  version: 1;
  take: string;
  directions: JudgedDirection[];
  recommended: DirectionId;
  planner: string;
  judge: string | null;
  determinism: Determinism & { measuredOn: DirectionId };
  calls: { planner: number; judge: number };
  /** The user's own --set pairs, under every direction's. */
  set: string[];
  board?: { file: string; key: string };
}

export function readMeta(dir: string): TakeMeta {
  return JSON.parse(readFileSync(join(dir, "take.json"), "utf8")) as TakeMeta;
}

export function writeMeta(dir: string, meta: TakeMeta): void {
  writeFileSync(join(dir, "take.json"), JSON.stringify(meta, null, 1) + "\n");
}

export function takeId(dir: string): string {
  return readMeta(dir).id ?? dir.split("/").filter(Boolean).at(-1)!;
}

export function readDirections(dir: string): DirectionsFile {
  const path = join(dir, "directions", "directions.json");
  if (!existsSync(path)) throw new Error(`no directions for ${dir}; run \`takeone directions ${dir}\` first`);
  return JSON.parse(readFileSync(path, "utf8")) as DirectionsFile;
}

interface SavedBeat { id: string; t0: number; t1: number; kind?: string; hint?: string }

function timeline(dir: string): string[] {
  const beats = JSON.parse(readFileSync(join(dir, "analysis", "beats.json"), "utf8")) as SavedBeat[];
  return beats.map((b) => `${b.id}, ${(b.t1 - b.t0).toFixed(1)} seconds: ${b.kind ?? "beat"}${b.hint ? ` - ${b.hint}` : ""}`);
}

/** The judge must not be the model that chose the options: a different backend or model. */
export function sameModel(a: ResolvedPlanner, b: ResolvedPlanner): boolean {
  const x = a.config as { backend: string; model?: string };
  const y = b.config as { backend: string; model?: string };
  return x.backend === y.backend && (x.model ?? "") === (y.model ?? "");
}

const letter = (id: string) => id.toUpperCase();

export function judgeCost(calls: number, frames = 3): string {
  return `${calls} judge call${calls === 1 ? "" : "s"}, ${frames} sampled frames each`;
}

export async function runDirections(o: DirectionsOptions): Promise<DirectionsFile> {
  if (!Number.isInteger(o.count) || o.count < 2 || o.count > 3) throw new Error("--count must be 2 or 3");
  const outDir = join(o.dir, "directions");
  const previous = existsSync(join(outDir, "directions.json")) ? (JSON.parse(readFileSync(join(outDir, "directions.json"), "utf8")) as DirectionsFile).board : undefined;
  // A re-run posts where the last directions went, so the older card is archived rather than left open.
  const board = boardFile(o.board) ?? previous?.file;
  const cfg = o.configDir === undefined ? {} : { configDir: o.configDir };
  // Both routes are checked before any planning is spent: the judge must not be the planner that proposes the options.
  let planner: ResolvedPlanner | null = null;
  let judge: ResolvedPlanner | null = null;
  if (!o.noAi) {
    planner = o.planner ?? await resolvePlanner(cfg);
    if (!planner.active) throw new PlannerUnavailable(planner.label, planner.refusal ?? "is not signed in", { credentialMissing: !planner.accountPresent });
    judge = o.judge ?? await resolveJudge(cfg);
    if (!judge.active) throw new JudgeUnavailable(`unavailable - ${judge.label} cannot serve: ${judge.refusal ?? "no sign-in"}. Sign in with \`claude\`, or save another route in judge.json`);
    if (sameModel(planner, judge)) throw new JudgeUnavailable(`the judge (${judge.label}) is the planner's own model; save a different model in judge.json so the judge stays independent`);
  }
  // New directions replace the old pick: the take renders with its own look again until one is picked. A run that fails
  // puts the old pick back.
  const meta = readMeta(o.dir);
  const oldPick = meta.direction;
  if (oldPick) {
    delete meta.direction;
    writeMeta(o.dir, meta);
  }
  try {
    return await directionsFor(o, board, previous, planner, judge, outDir);
  } catch (e) {
    if (oldPick) {
      const back = readMeta(o.dir);
      back.direction = oldPick;
      writeMeta(o.dir, back);
    }
    throw e;
  }
}

async function directionsFor(o: DirectionsOptions, board: string | undefined, previous: DirectionsFile["board"], planner: ResolvedPlanner | null,
  judge: ResolvedPlanner | null, outDir: string): Promise<DirectionsFile> {
  if (o.replan || !existsSync(join(o.dir, "analysis", "beats.json"))) {
    o.log("directions: planning the take once (beats, camera decisions, captions); every direction renders this one plan");
    await makeTake(o.dir, {
      noAi: o.noAi, replan: o.replan, set: o.set, render: false, log: o.log, warn: o.warn,
      camera: o.resolveCamera(o.dir, o.set),
      ...(o.goal === undefined ? {} : { goal: o.goal }),
      ...(o.style === undefined ? {} : { style: o.style }),
      ...(o.configDir === undefined ? {} : { configDir: o.configDir }),
      ...(o.fetchImpl === undefined ? {} : { fetchImpl: o.fetchImpl }),
    });
  }
  const planned = readMeta(o.dir);

  let directions: Direction[];
  let plannerLabel = "fixed table (--no-ai)";
  let plannerCalls = 0;
  if (!planner) {
    directions = presetDirections(o.count);
  } else {
    const ctx = {
      seconds: planned.duration ?? 0,
      device: planned.device ?? ("stream" in planned ? "recorded screen" : "desktop browser"),
      timeline: timeline(o.dir),
      ...(o.goal === undefined ? {} : { goal: o.goal }),
      ...(o.style === undefined ? {} : { style: o.style }),
    };
    const { state, questions } = directionsRequest(ctx, o.count);
    const cache = new PlannerFileCache(join(o.dir, "analysis", "directions-cache.jsonl"), o.warn);
    const outcome = await askChunk(state, questions, planner, cache, { keepAnswers: true, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) });
    plannerCalls = outcome.decisionSource === "api" ? 1 : 0;
    if (!outcome.answers) o.warn(`directions: the planner gave no answers (${outcome.failure ?? "no reason"}); using the fixed table`);
    directions = mapDirections(outcome.answers ?? {}, o.count);
    plannerLabel = planner.label;
  }

  mkdirSync(outDir, { recursive: true });
  const cache = new PlannerFileCache(join(o.dir, "analysis", "judge-cache.jsonl"), o.warn);
  let det: Determinism = { frames: 0, identical: 0, tolerance: 0.995 };
  let judgeCalls = 0;
  const judged: JudgedDirection[] = [];
  for (const d of directions) {
    o.log(`directions: ${letter(d.id)} - ${d.name} (${d.why})`);
    const camera = o.resolveCamera(o.dir, [...d.set, ...o.set], d.theme);
    clearOverlays(o.dir);
    const film = join(outDir, `${d.id}.mp4`);
    copyFileSync((await renderTake(o.dir, camera)).out, film);
    if (judged.length === 0) {
      // Determinism is measured once, on the first direction: every direction renders through the same path.
      clearOverlays(o.dir);
      det = compareFrames(frameHashes(film), frameHashes((await renderTake(o.dir, camera)).out));
      o.log(`directions: determinism ${det.identical}/${det.frames} decoded frames identical on a second render of ${letter(d.id)}`);
    }
    let card: JudgedCard | null = null;
    if (judge) {
      const facts = await measureFilm(film, 0, det, { dir: o.dir, camera, frameDir: join(outDir, `frames-${d.id}`) });
      card = await judgeRound(judge, facts, { cache, log: o.log, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) }, {
        gaps: true,
        context: { option: { letter: letter(d.id), direction: d.name, why: d.why } },
      });
      if (card.source === "api") judgeCalls++;
      o.log(`directions: ${letter(d.id)} scored ${card.score.toFixed(1)}/10 by ${judge.label}`);
    }
    judged.push({ ...d, film: `directions/${d.id}.mp4`, score: card?.score ?? null, items: card?.items ?? [], gaps: card?.gaps ?? [] });
  }
  const recommended = judged.reduce((best, d) => (d.score ?? -1) > (best.score ?? -1) ? d : best, judged[0]!).id;
  const file: DirectionsFile = {
    version: 1, take: takeId(o.dir), directions: judged, recommended, planner: plannerLabel, judge: judge?.label ?? null,
    determinism: { ...det, measuredOn: judged[0]!.id }, calls: { planner: plannerCalls, judge: judgeCalls }, set: o.set,
  };
  // The report is written before the card goes up: the films are already new, so a failed post leaves a report that
  // names them (pick by letter still works) and no card that shows the old ones.
  const write = () => writeFileSync(join(outDir, "directions.json"), JSON.stringify(file, null, 1) + "\n");
  write();
  if (board) {
    const runs = previous?.key.match(/-(\d+)$/);
    const key = `takeone-${file.take}-directions-${runs ? Number(runs[1]) + 1 : 1}`;
    // The board keeps one open card per decision: the older pick goes to the archive before the new one is posted.
    if (previous) replaceCard(previous.file, previous.key, o.log);
    await postCard({
      board, key, filer: `takeone-${file.take}`, recommend: recommended,
      title: `Which cut of ${file.take} should be polished?`,
      tradeoff: `Each option is a full render of the same take. Scores are from an independent judge (${judge?.label ?? "none: --no-ai"}) on 3 sampled frames per cut. Picking one starts the polish rounds.`,
      options: judged.map((d) => ({
        value: d.id, label: `${letter(d.id)} ${d.score === null ? "" : `${d.score.toFixed(1)} `}${d.name}`.slice(0, 120), film: join(o.dir, d.film), posterAt: 1,
        page: {
          badge: letter(d.id), badgeLabel: `Option ${letter(d.id)}`, title: d.name, score: d.score, target: 9,
          ...(d.id === recommended ? { pill: "Recommended cut" } : {}),
          status: [d.score === null ? "Not judged (--no-ai)" : "Option judged once", `Picked by ${d.by.theme === "ai" ? "the planner" : "rule"}: ${d.why}`],
          items: d.items.map((i) => ({ label: i.label, score: i.score, note: i.note })),
          feedback: [], changes: [], cost: `${judgeCost(judgeCalls)} for ${judged.length} options; ${plannerCalls} planner call`,
        },
      })),
    }, o.log);
    file.board = { file: board, key };
    write();
  }
  o.log(`directions: recommended ${letter(recommended)}; pick one with \`takeone pick ${o.dir} <${judged.map((d) => d.id).join("|")}>\`${file.board ? " or on the board" : ""}`);
  return file;
}

export interface PickResult {
  picked: PickedDirection;
  from: "argument" | "board";
  note?: string;
}

/** Save the picked direction on the take; with no letter, read the owner's pick from the board card. */
export function pickDirection(dir: string, id: string | undefined, log: (line: string) => void): PickResult {
  const file = readDirections(dir);
  let from: PickResult["from"] = "argument";
  let note: string | undefined;
  if (id === undefined) {
    if (!file.board) throw new Error("name a direction (a, b or c): these directions were not posted to a board");
    const answer = cardAnswer(file.board.file, file.board.key);
    if (!answer?.answer) throw new Error(`the board card ${file.board.key} is not answered yet; pick on the board or name a direction`);
    id = answer.answer;
    note = answer.note;
    from = "board";
  }
  const d = file.directions.find((x) => x.id === id);
  if (!d || !(DIRECTION_IDS as readonly string[]).includes(id)) throw new Error(`no direction ${id}; choose ${file.directions.map((x) => x.id).join(", ")}`);
  const picked: PickedDirection = { id: d.id, name: d.name, theme: d.theme, set: [...d.set] };
  // The cut goes to out/ first, so a missing film fails the pick before the take changes.
  mkdirSync(join(dir, "out"), { recursive: true });
  copyFileSync(join(dir, d.film), join(dir, "out", `${file.take}.mp4`));
  const meta = readMeta(dir);
  meta.direction = picked;
  writeMeta(dir, meta);
  log(`pick: ${letter(d.id)} - ${d.name}${from === "board" ? " (picked on the board)" : ""}; out/${file.take}.mp4 is that cut`);
  return { picked, from, ...(note ? { note } : {}) };
}
