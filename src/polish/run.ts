// `takeone polish` and `takeone polish-feedback`: refine the picked cut round by round with the loop in loop.ts. A
// round renders the picked take with the seed's settings plus this round's changes, the judge scores it from three
// sampled blurred frames and checks every piece of the owner's feedback, and the board shows each round as it lands.

import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CameraDefaults } from "../camera/defaults.ts";
import type { TakeMeta } from "../camera/types.ts";
import { planCamera, renderTake } from "../render/render.ts";
import { askChunk, PlannerFileCache, PlannerUnavailable, resolveJudge, resolvePlanner, type ResolvedPlanner } from "../decide/planner.ts";
import { JUDGE_SAMPLES, JudgeUnavailable, judgeRound, medianCard, type JudgedCard } from "../score/judge.ts";
import { improveRound } from "../score/improve.ts";
import { clearOverlays, compareFrames, frameHashes, measureFilm } from "../score/measure.ts";
import type { Determinism } from "../score/loop.ts";
import type { MeasuredFacts, ScoreCard } from "../score/rubric.ts";
import { boardFile, cardAnswer, cardNotes, postCard, replaceCard } from "../board/board.ts";
import { judgeCost, readDirections, readMeta, sameModel, takeId, writeMeta } from "../directions/run.ts";
import { IDLE_SPEED_MAX, type PickedDirection } from "../directions/directions.ts";
import { builderRequest, mapBuilder } from "./builder.ts";
import { POLISH_TARGET, roundCap, runPolish, type Candidate, type Critique, type Feedback, type PolishRound, type PolishState } from "./loop.ts";

/** Take keys a refinement may change; every round writes all of them, so a rejected round's edits never linger. */
const META_KEYS = ["trim_start", "zooms", "cursor_free"] as const;
/** Camera keys a refinement may change: the builder's knobs and the measured rules' keys. Never the theme or camera_path. */
const CAMERA_KEYS: (keyof CameraDefaults)[] = ["pace", "idle_speed", "idle_keep", "establish_s", "outro_s", "move_t_max", "l1_pad", "l2_pad", "l3_pad",
  "cursor_size", "ripple_ms", "ripple_r", "stage_margin", "caption_size", "motion_blur"];

export interface PolishOptions {
  dir: string;
  maxRounds: number;
  feedback: string[];
  set: string[];
  board?: string;
  configDir?: string;
  /** Injectable for tests: recorded routes instead of the configured judge and builder. */
  judge?: ResolvedPlanner;
  builder?: ResolvedPlanner;
  fetchImpl?: typeof fetch;
  log: (line: string) => void;
  warn: (line: string) => void;
  resolveCamera: (dir: string, pairs: string[], theme?: string) => CameraDefaults;
}

export interface PolishResult {
  state: PolishState;
  runDir: string;
  film: string | null;
}

/** "median 8.2 of 3 judgings, 8.0 to 8.4", and a band that straddles the target is called inconclusive, not a pass or a fail. */
const band = (c: Critique): string => !c.spread ? "" : ` (median of ${c.spread.scores.length} judgings, ${c.spread.low.toFixed(1)} to ${c.spread.high.toFixed(1)}${c.spread.inconclusive ? `; INCONCLUSIVE: the band crosses the ${POLISH_TARGET}/10 target, so this round is neither a pass nor a fail` : ""})`;

const json = (file: string, value: unknown, flag = "w") => writeFileSync(file, JSON.stringify(value, null, 1) + "\n", { flag });

function feedbackAt(runDir: string): Feedback[] {
  const folder = join(runDir, "feedback");
  return readdirSync(folder).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(folder, f), "utf8")) as Feedback);
}

/** Feedback is 1 to 2000 characters once trimmed. */
export function cleanFeedback(text: string): string {
  const clean = text.trim();
  if (!clean || clean.length > 2000) throw new Error("feedback must be 1-2000 characters");
  return clean;
}

function addFeedback(runDir: string, text: string, source: Feedback["source"]): Feedback {
  const clean = cleanFeedback(text);
  const entry: Feedback = { id: randomUUID(), at: new Date().toISOString(), text: clean, source };
  const n = readdirSync(join(runDir, "feedback")).length;
  json(join(runDir, "feedback", `${String(n).padStart(3, "0")}-${entry.id}.json`), entry, "wx");
  return entry;
}

/** The newest polish run of a take, or null when it has none. */
export function latestRun(dir: string): string | null {
  const root = join(dir, "polish");
  if (!existsSync(root)) return null;
  const runs = readdirSync(root).filter((f) => /^\d+$/.test(f)).map(Number).sort((a, b) => a - b);
  return runs.length ? join(root, String(runs.at(-1))) : null;
}

/** `takeone polish-feedback`: add the owner's note to the running polish; the next round reads it. */
export function polishFeedback(dir: string, text: string): Feedback {
  const run = latestRun(dir);
  if (!run || !existsSync(join(run, "run.json"))) throw new Error(`no polish run for ${dir}; start one with \`takeone polish ${dir}\``);
  const state = JSON.parse(readFileSync(join(run, "run.json"), "utf8")) as PolishState;
  if (state.status !== "running") throw new Error("this polish run has stopped; start a new one with --feedback");
  return addFeedback(run, text, "cli");
}

/** Pairs as a map, the later pair of a key winning, then back to pairs. */
function mergePairs(...lists: string[][]): string[] {
  const out = new Map<string, string>();
  for (const pair of lists.flat()) out.set(pair.split("=")[0]!, pair);
  return [...out.values()];
}

const pickMeta = (meta: TakeMeta): Record<string, unknown> => Object.fromEntries(META_KEYS.map((k) => [k, meta[k] ?? null]));

function applyMeta(dir: string, patch: Record<string, unknown>): void {
  const meta = readMeta(dir) as unknown as Record<string, unknown>;
  for (const k of META_KEYS) {
    if (patch[k] === null || patch[k] === undefined) delete meta[k];
    else meta[k] = patch[k];
  }
  writeMeta(dir, meta as unknown as TakeMeta);
}

/** What run.json keeps besides the loop state: where its cards went, so a later run or `pick` can find them. */
interface RunFile extends PolishState {
  picked: PickedDirection;
  board?: { file: string; card?: string };
}

const readRun = (runDir: string): RunFile | null => existsSync(join(runDir, "run.json")) ? JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as RunFile : null;

/** Ship one round of a polish run: its film to out/, its settings to the take. */
function ship(dir: string, picked: PickedDirection, run: string, round: PolishRound): string {
  const film = join(dir, "out", `${takeId(dir)}.mp4`);
  mkdirSync(join(dir, "out"), { recursive: true });
  copyFileSync(round.film, film);
  applyMeta(dir, round.meta);
  const meta = readMeta(dir);
  meta.direction = { ...picked, set: round.set, polished: { run, round: round.round, score: round.score! } };
  writeMeta(dir, meta);
  return film;
}

/**
 * `takeone pick <take> r<N>`, or the owner's answer on the latest polish card: ship that round of the latest run
 * instead of the one the loop chose. Returns null when there is no polish card answer to read and no round was named.
 */
export function pickRound(dir: string, round: number | undefined, log: (line: string) => void): { round: number; from: "argument" | "board" } | null {
  const runDir = latestRun(dir);
  const run = runDir ? readRun(runDir) : null;
  if (!runDir || !run) {
    if (round === undefined) return null;
    throw new Error(`no polish run for ${dir}; start one with \`takeone polish ${dir}\``);
  }
  // A polish run belongs to the direction it polished; once new directions clear or change the pick it is stale.
  if (readMeta(dir).direction?.id !== run.picked.id) {
    if (round === undefined) return null;
    throw new Error(`the latest polish run polished ${run.picked.name}, which is no longer the picked direction; pick a direction and polish again`);
  }
  let from: "argument" | "board" = "argument";
  if (round === undefined) {
    if (!run.board?.card) return null;
    const answer = cardAnswer(run.board.file, run.board.card)?.answer;
    if (!answer) return null;
    round = Number(answer.replace(/^r/, ""));
    from = "board";
  }
  const entry = run.rounds.find((r) => r.round === round);
  if (!entry || entry.score === null || !existsSync(entry.film)) throw new Error(`no judged round ${round} in ${runDir}; choose ${run.rounds.filter((r) => r.score !== null).map((r) => `r${r.round}`).join(", ")}`);
  const film = ship(dir, run.picked, runDir.split("/").at(-1)!, entry);
  log(`pick: round ${round} of polish run ${runDir.split("/").at(-1)} (${entry.score!.toFixed(1)}/10${entry.accepted ? "" : ", rejected by the loop"})${from === "board" ? ", picked on the board" : ""}; ${film} is that cut`);
  return { round, from };
}

const pathOf = (pairs: string[]) => pairs.find((p) => p.startsWith("camera_path="))?.split("=")[1] ?? "solver";

export async function runPolishCommand(o: PolishOptions): Promise<PolishResult> {
  const maxRounds = roundCap(o.maxRounds);
  const picked: PickedDirection | undefined = readMeta(o.dir).direction;
  if (!picked) throw new Error(`no picked direction on ${o.dir}; run \`takeone directions\` and \`takeone pick\` first`);
  const directions = readDirections(o.dir);
  // Cards go where the directions card went unless another board is named.
  const board = boardFile(o.board) ?? directions.board?.file;
  const take = takeId(o.dir);
  const cliFeedback = o.feedback.map(cleanFeedback);
  const cfg = o.configDir === undefined ? {} : { configDir: o.configDir };

  const judge = o.judge ?? await resolveJudge(cfg);
  if (!judge.active) throw new JudgeUnavailable(`unavailable - ${judge.label} cannot serve: ${judge.refusal ?? "no sign-in"}. Sign in with \`claude\`, or save another route in judge.json`);
  const builder = o.builder ?? await resolvePlanner(cfg);
  if (!builder.active) throw new PlannerUnavailable(builder.label, builder.refusal ?? "is not signed in", { credentialMissing: !builder.accountPresent });
  if (sameModel(builder, judge)) throw new JudgeUnavailable(`the judge (${judge.label}) is the builder's own model; save a different model in judge.json so the judge stays independent`);

  const root = join(o.dir, "polish");
  mkdirSync(root, { recursive: true });
  const before = latestRun(o.dir);
  const previousRun = before ? readRun(before) : null;
  const k = (readdirSync(root).filter((f) => /^\d+$/.test(f)).map(Number).sort((a, b) => a - b).at(-1) ?? 0) + 1;
  const runDir = join(root, String(k));
  mkdirSync(join(runDir, "feedback"), { recursive: true });
  for (const text of cliFeedback) addFeedback(runDir, text, "cli");

  // Notes the owner leaves on the board become feedback: on the directions card when they picked, on the last card of
  // the run before this one, then on each round's card.
  const keys: string[] = directions.board ? [directions.board.key] : [];
  const previousCard = previousRun?.board?.file === board ? previousRun?.board?.card : undefined;
  if (previousCard) keys.push(previousCard);
  const seenNotes = new Set<string>();
  const ingestBoard = () => {
    if (!board) return;
    for (const key of keys) {
      for (const note of cardNotes(cardAnswer(board, key))) {
        if (seenNotes.has(`${key}\n${note}`)) continue;
        seenNotes.add(`${key}\n${note}`);
        let text = note.trim();
        if (!text) continue;
        if (text.length > 2000) {
          o.warn(`polish: a board note on ${key} is ${text.length} characters; the first 2000 are kept`);
          text = text.slice(0, 2000);
        }
        if (feedbackAt(runDir).some((f) => f.text === text)) continue;
        addFeedback(runDir, text, "board");
        o.log(`polish: owner feedback from the board - "${note}"`);
      }
    }
  };

  const judgeCache = new PlannerFileCache(join(o.dir, "analysis", "judge-cache.jsonl"), o.warn);
  const builderCache = new PlannerFileCache(join(o.dir, "analysis", "polish-cache.jsonl"), o.warn);
  const measured = new Map<number, { facts: MeasuredFacts; card: ScoreCard; camera: CameraDefaults }>();
  const cameras = new Map<number, CameraDefaults>();
  const baseMeta = pickMeta(readMeta(o.dir));
  let det: Determinism = { frames: 0, identical: 0, tolerance: 0.995 };
  let builderCalls = 0;
  let judgeCalls = 0;
  let renders = 0;
  // --set is part of round 0's settings, so refinements build on it and may change it like any other setting.
  const camOf = (set: string[]) => o.resolveCamera(o.dir, set, picked.theme);

  const render = async (round: number, set: string[], meta: Record<string, unknown>): Promise<string> => {
    applyMeta(o.dir, meta);
    const camera = camOf(set);
    cameras.set(round, camera);
    clearOverlays(o.dir);
    const film = join(runDir, `round-${round}.mp4`);
    copyFileSync((await renderTake(o.dir, camera)).out, film);
    renders++;
    return film;
  };

  const build = async (round: number, seed: Candidate | null, gaps: string[], feedback: Feedback[]): Promise<Candidate | null> => {
    if (round === 0) {
      const set = mergePairs(picked.set, o.set);
      const film = await render(0, set, baseMeta);
      // Round 0 is the picked cut rendered again: comparing it with the cut the owner picked is the determinism check.
      // After an earlier polish the picked cut is that run's shipped round; --set changes the cut, so then it is no check.
      const shipped = picked.polished ? join(o.dir, "polish", picked.polished.run, `round-${picked.polished.round}.mp4`) : null;
      const reference = shipped ?? join(o.dir, directions.directions.find((d) => d.id === picked.id)!.film);
      if (o.set.length === 0 && existsSync(reference)) {
        det = compareFrames(frameHashes(reference), frameHashes(film));
        o.log(`polish: round 0 is the picked cut (${picked.name}${shipped ? `, as polish run ${picked.polished!.run} shipped it` : ""}); determinism ${det.identical}/${det.frames} frames identical to the picked render`);
      } else {
        o.log(`polish: round 0 is the picked cut (${picked.name})${o.set.length ? ` with ${o.set.join(" ")}` : ""}; no earlier render of these settings to check determinism against`);
      }
      return { film, set, meta: baseMeta, changes: [] };
    }
    const seedRound = [...measured.keys()].find((r) => runFilm(r) === seed!.film)!;
    const seeded = measured.get(seedRound)!;
    const camera = { ...seeded.camera };
    applyMeta(o.dir, seed!.meta);
    const meta = readMeta(o.dir);
    const limitations: string[] = [];
    // Measured rules first (the score loop's own changes, each checked before a round is spent on it), then the builder.
    const ruleChanges = await improveRound(seeded.card, seeded.facts, {
      dir: o.dir, camera, meta, writeMeta: () => undefined, singlePass: () => false, limitations,
      solve: async (cam, m) => (await planCamera(o.dir, cam, m)).frames,
    });
    for (const l of limitations) o.log(`polish: ${l}`);
    let changes = [...ruleChanges];
    if (camera.idle_speed > IDLE_SPEED_MAX && camera.idle_speed > seeded.camera.idle_speed) {
      // Squeezing idle footage past the cap makes the camera solve run for an hour on a 4K take: keep the seed's.
      o.log(`polish: not squeezing idle footage to ${camera.idle_speed}x (most ${IDLE_SPEED_MAX}x in polish: the camera solve gets too slow)`);
      camera.idle_speed = seeded.camera.idle_speed;
      camera.idle_keep = seeded.camera.idle_keep;
      changes = changes.filter((c) => !c.startsWith("squeeze idle footage"));
    }
    const history = polishState.rounds.map((r) => ({ round: r.round, score: r.score, accepted: r.accepted, changes: r.changes }));
    const { state, questions } = builderRequest({
      direction: { name: picked.name, theme: picked.theme }, camera, feedback, gaps, history, ruleChanges,
      score: seeded.card.score, items: seeded.card.items.map(({ label, score, note }) => ({ label, score, note })), target: polishState.target,
    });
    const outcome = await askChunk({ ...state, round }, questions, builder, builderCache, { keepAnswers: true, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) });
    if (outcome.decisionSource === "api") builderCalls++;
    if (!outcome.answers) o.warn(`polish: the builder gave no answers (${outcome.failure ?? "no reason"}); measured changes only`);
    const mapped = mapBuilder(outcome.answers ?? {}, camera);
    Object.assign(camera, mapped.change);
    changes = [...changes, ...mapped.changes];
    const pairs = CAMERA_KEYS.filter((key) => camera[key] !== seeded.camera[key]).map((key) => `${key}=${camera[key]}`);
    const metaPatch = pickMeta(meta);
    if (pairs.length === 0 && JSON.stringify(metaPatch) === JSON.stringify(seed!.meta)) {
      o.log("polish: no build input is left to change; stopping");
      return null;
    }
    const set = mergePairs(seed!.set, pairs);
    const film = await render(round, set, metaPatch);
    return { film, set, meta: metaPatch, changes };
  };
  const runFilm = (r: number) => join(runDir, `round-${r}.mp4`);

  const judgeRoundFor = async (c: Candidate, round: number, feedback: Feedback[]): Promise<Critique> => {
    const camera = cameras.get(round)!;
    const facts = await measureFilm(c.film, round, det, { dir: o.dir, camera, frameDir: join(runDir, "frames") });
    const context = {
      picked_direction: { name: picked.name, theme: picked.theme },
      round: round === 0 ? "round 0: the picked cut as the owner picked it" : `refinement ${round} of at most ${maxRounds}`,
      this_round_changes: c.changes.length ? c.changes : ["(none)"],
      earlier_rounds: polishState.rounds.map((r) => ({ round: r.round, score: r.score, accepted: r.accepted })),
    };
    // The same round is judged JUDGE_SAMPLES times through the one route. The first ask keeps its cache key as before;
    // the others name their number, so each is a fresh draw instead of the cached answer of the first.
    const samples: JudgedCard[] = [];
    for (let sample = 1; sample <= JUDGE_SAMPLES; sample++) {
      const one = await judgeRound(judge, facts, { cache: judgeCache, log: o.log, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) }, {
        gaps: true,
        feedback: feedback.map((f) => ({ id: f.id, text: f.text })),
        context: sample === 1 ? context : { ...context, judging: `sample ${sample} of ${JUDGE_SAMPLES}` },
      });
      if (one.source === "api") judgeCalls++;
      samples.push(one);
    }
    const card = medianCard(samples, POLISH_TARGET);
    measured.set(round, { facts, card, camera });
    // The picked look is structural: the theme is pinned and camera_path never leaves the picked one.
    const directionKept = camera.camera_path === o.resolveCamera(o.dir, picked.set, picked.theme).camera_path && pathOf(c.set) === pathOf(picked.set);
    return {
      score: card.score, ...(card.spread ? { spread: card.spread } : {}), ...(card.itemRange ? { itemRange: card.itemRange } : {}),
      items: card.items.map(({ id, label, score, note }) => ({ id, label, score, note })), gaps: card.gaps,
      directionKept, feedback: card.feedback, judge: judge.label,
      ...(card.inputTokens === undefined ? {} : { inputTokens: card.inputTokens }),
      ...(card.outputTokens === undefined ? {} : { outputTokens: card.outputTokens }),
    };
  };

  let polishState: PolishState = { version: 1, target: 9, max_rounds: maxRounds, status: "running", rounds: [], final: null };
  let lastKey: string | undefined = previousCard;
  const save = (s: PolishState) => {
    polishState = s;
    json(join(runDir, "run.json.tmp"), {
      ...s, take, picked, judge: judge.label, builder: builder.label,
      determinism: det, calls: { judge: judgeCalls, builder: builderCalls, renders },
      ...(board ? { board: { file: board, ...(lastKey ? { card: lastKey } : {}) } } : {}),
    });
    renameSync(join(runDir, "run.json.tmp"), join(runDir, "run.json"));
  };

  const onRound = async (entry: PolishRound, s: PolishState) => {
    json(join(runDir, `round-${entry.round}.json`), entry, "wx");
    const c = entry.critique!;
    o.log(`polish: round ${entry.round} scored ${c.score.toFixed(1)}/10${band(c)} - ${entry.accepted ? "accepted" : "rejected"}${entry.changes.length ? `; changes: ${entry.changes.join("; ")}` : ""}`);
    for (const f of c.feedback) o.log(`polish:   feedback ${f.kept ? "met" : "NOT met"} - "${entry.feedback.find((x) => x.id === f.id)?.text}": ${f.reason}`);
    if (!board || s.rounds.length < 2) return;
    const final = s.final!;
    const done = s.status === "stopped";
    // One open card per decision: the previous round's card goes to the archive before this round's is posted.
    if (lastKey) replaceCard(board, lastKey, o.log);
    const key = await postCard({
      board, key: `takeone-${take}-polish-${k}-r${entry.round}`, filer: `takeone-${take}`, recommend: `r${final.round}`,
      title: done ? `Ship round ${final.round} of the ${picked.name} cut? (${final.score.toFixed(1)}/10)` : `Polishing the ${picked.name} cut: round ${entry.round} scored ${c.score.toFixed(1)}/10`,
      tradeoff: `Every round is the picked cut, refined from the judge's gaps and your notes (cumulative, never undone). Judge ${judge.label}, a different model from the builder; target 9/10, at most ${maxRounds} refinements. Leave a note to steer the next round.`,
      options: s.rounds.filter((r) => r.score !== null).slice(-6).map((r) => ({
        value: `r${r.round}`, label: `R${r.round} ${r.score!.toFixed(1)}${r.accepted ? "" : " rejected"}${r.round === final.round ? (done ? " final" : " best") : ""}`,
        film: r.film, posterAt: 1,
        page: {
          badge: `R${r.round}`, badgeLabel: `Round ${r.round}`, title: picked.name, score: r.score, target: 9,
          ...(r.round === final.round ? { pill: done ? "Final cut" : "Best so far" } : {}),
          status: [
            r.round === 0 ? "Round 0: the picked cut" : `Round ${r.round} of ${maxRounds}`,
            r.accepted ? (r.critique!.spread?.inconclusive ? `Inconclusive: judged ${r.critique!.spread.low.toFixed(1)} to ${r.critique!.spread.high.toFixed(1)}, across the target` : r.score! >= 9 ? "At target" : "Below target") : "Rejected: missed feedback or left the picked look",
            ...(r.critique!.spread ? [`Median of ${r.critique!.spread.scores.length} judgings, ${r.critique!.spread.low.toFixed(1)} to ${r.critique!.spread.high.toFixed(1)}`] : []),
          ],
          items: r.critique!.items.map((i) => ({ label: i.label, score: i.score, note: i.note })),
          feedback: r.feedback.map((f) => {
            const check = r.critique!.feedback.find((x) => x.id === f.id);
            return { text: f.text, kept: check ? check.kept : null, reason: check?.reason ?? "" };
          }),
          changes: r.changes,
          cost: `${judgeCost((r.round + 1) * JUDGE_SAMPLES)} so far`,
        },
      })),
    }, o.log);
    lastKey = key;
    keys.push(key);
    save(s);
  };

  let state: PolishState;
  let film: string | null = null;
  let final: PolishRound | undefined;
  try {
    state = await runPolish({
      maxRounds,
      build,
      judge: judgeRoundFor,
      feedbackAt: () => { ingestBoard(); return feedbackAt(runDir); },
      save,
      onRound,
    });
  } finally {
    // Ship the best accepted round even when a later round failed: every render overwrote out/, so it is put back to
    // the round the run ships, or the take is left as picked when no round was accepted.
    final = polishState.final ? polishState.rounds.find((r) => r.round === polishState.final!.round) : undefined;
    if (final) film = ship(o.dir, picked, String(k), final);
    else applyMeta(o.dir, baseMeta);
  }
  const scores = state.rounds.map((r) => r.score === null ? "error" : r.score.toFixed(1)).join(", ");
  o.log(`polish: scores by round ${scores}; stopped: ${state.stop_reason}`);
  o.log(`polish: cost ${judgeCost(judgeCalls)}, ${builderCalls} builder call(s), ${renders} render(s) of the take`);
  const spread = final?.critique?.spread;
  if (spread?.inconclusive) o.log(`polish: INCONCLUSIVE - the final round was judged ${spread.low.toFixed(1)} to ${spread.high.toFixed(1)}, across the ${POLISH_TARGET}/10 target`);
  else if (final && final.score! < 9) o.log(`polish: BELOW TARGET - the best accepted round scored ${final.score!.toFixed(1)}/10 against 9/10`);
  if (final) o.log(`polish: final round ${final.round} (${final.score!.toFixed(1)}/10${final.critique?.spread ? `, judged ${final.critique.spread.low.toFixed(1)} to ${final.critique.spread.high.toFixed(1)}` : ""}) -> ${film}; run ${runDir}`);
  return { state, runDir, film };
}
