// The motion gauntlet: render a motion film, have a fresh-context critic score each scene against a written
// reference, repair what scored under the bar by bounded edits to storyboard.json, render again, and keep a
// durable ledger of every round. The critic sees only scene facts, never the planner's
// conversation; every repair is one beat-grid step on one scene and is checked by the storyboard validator.
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryCache, type Question } from "@byokit/decide";
import { CallBudget } from "../decide/budget.ts";
import { askChunk, type ResolvedPlanner } from "../decide/planner.ts";
import { runFfmpeg } from "../render/ffmpeg.ts";
import { JudgeUnavailable, LEVELS, answerScore } from "../score/judge.ts";
import { renderMotion } from "./motion.ts";
import { minSceneDuration, validateStoryboard } from "./storyboard.ts";
import type { MotionEngine, Scene, Storyboard } from "./types.ts";

export const DEFAULT_BAR = 8;
export const DEFAULT_GAUNTLET_ROUNDS = 2;
export const MAX_GAUNTLET_ROUNDS = 5;
export function validateMaxRounds(maxRounds: number): void {
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_GAUNTLET_ROUNDS) throw new Error(`--max-rounds expects an integer 1-${MAX_GAUNTLET_ROUNDS}`);
}
/** A scene may grow by at most this many beat-grid steps over the film's first plan, so repairs cannot run away. */
export const MAX_GROWTH_STEPS = 2;
const GAIN_EPSILON = 0.2;
const CRITIC_TIMEOUT_MS = 180000;

/** The written reference: what a finished editorial launch film scene is held to. */
export const REFERENCE = {
  read: "Every word the scene sets stays on screen long enough to read comfortably, about three words a second after it appears.",
} as const;
type Criterion = keyof typeof REFERENCE;

export interface Finding { id: string; scene: number; pattern: string; criterion: Criterion; score: number; note: string }
export interface Repair { scene: number; change: string }

/** The beat-grid step a scene's length moves by: one beat of the film's tempo, else half a second. */
const step = (sb: Storyboard): number => (sb.tempo ? 60 / sb.tempo.bpm / (sb.tempo.snap === "half" ? 2 : 1) : 0.5);
const settledAt = (s: Scene): number => s.at! + s.d * 0.7;

function questionsFor(sb: Storyboard): Record<string, Question> {
  const out: Record<string, Question> = {};
  sb.scenes.forEach((s, i) => {
    const facts = `Scene ${i + 1} of ${sb.scenes.length}, ${s.pattern}, ${s.d.toFixed(2)} s long, with a minimum reading duration of ${minSceneDuration(s).toFixed(2)} s.`;
    out[`s${i + 1}-read`] = { kind: "score", levels: LEVELS, floor: 0, instructions: `${REFERENCE.read}\n${facts}` };
  });
  return out;
}

async function stills(film: string, sb: Storyboard, dir: string, round: number): Promise<void> {
  mkdirSync(dir, { recursive: true });
  for (const [i, s] of sb.scenes.entries()) {
    const png = join(dir, `round-${round}-scene-${i + 1}.png`);
    await runFfmpeg(["-v", "error", "-y", "-threads", "2", "-ss", settledAt(s).toFixed(3), "-i", film, "-frames:v", "1", "-vf", "scale=1280:-2", "-filter_threads", "2", png]);
  }
}

/** Settled stills are kept for the person reading the ledger; the critic receives scene facts only. */
export async function critique(planner: ResolvedPlanner, sb: Storyboard, film: string, dir: string, round: number, budget: CallBudget): Promise<{ findings: Finding[] }> {
  await stills(film, sb, dir, round);
  const questions = questionsFor(sb);
  const state = {
    task: "You are a fresh critic of one finished launch film. Score each scene against the written reference. Be strict: 10 is the reference bar, and a scene that merely works is a 7.",
    scale: "Each item is an integer from 0 (absent or broken) to 10 (at the reference bar).",
    film: { seconds: sb.scenes.reduce((t, s) => Math.max(t, s.at! + s.d), 0), scenes: sb.scenes.length },
  };
  const outcome = await askChunk(state, questions, planner, new MemoryCache(), { timeoutMs: CRITIC_TIMEOUT_MS, keepAnswers: true, budget, workflow: "motion critic" });
  if (!outcome.answers) throw new JudgeUnavailable(outcome.failure ?? "the critic returned no answers");
  const findings = Object.keys(questions).map((id) => {
    const [, n, criterion] = /^s(\d+)-(\w+)$/.exec(id)!;
    const scene = Number(n), s = sb.scenes[scene - 1]!, c = criterion as Criterion;
    return { id, scene, pattern: s.pattern, criterion: c, score: answerScore(id, outcome.answers![id]), note: REFERENCE[c] };
  });
  return { findings };
}

/** Film time `t` after scenes before it have grown or shrunk: a time inside a scene keeps its place in that scene. */
function remap(t: number, before: Scene[], shifts: number[]): number {
  let i = -1;
  before.forEach((s, j) => { if (s.at! <= t + 1e-9) i = j; });
  return i < 0 ? t : t + (shifts[i] ?? 0);
}

/** Bounded reading-time repairs: each one beat-grid step on one scene. `first` is the film's first plan: no scene grows past it by more than
 *  MAX_GROWTH_STEPS. A repair the validator refuses is skipped. Only a single-timeline film is repaired. */
export function repairStoryboard(sb: Storyboard, first: Storyboard, findings: Finding[]): { storyboard: Storyboard; repairs: Repair[] } {
  const repairs: Repair[] = [];
  if (sb.layout.kind !== "single") return { storyboard: sb, repairs };
  const low = (n: number) => findings.some((f) => f.scene === n && f.criterion === "read" && f.score < DEFAULT_BAR);
  const grid = step(sb);
  let storyboard = sb;
  storyboard.scenes.forEach((s, i) => {
    const n = i + 1, firstD = first.scenes[i]?.d ?? s.d;
    if (!low(n) || s.d + grid > firstD + MAX_GROWTH_STEPS * grid + 1e-9) return;
    const shifts = storyboard.scenes.map((_, j) => j > i ? grid : 0);
    const scenes = storyboard.scenes.map((scene, j) => {
      const moved: Scene = { ...scene, ...(j === i ? { d: scene.d + grid } : {}), ...(scene.at === undefined ? {} : { at: scene.at + shifts[j]! }) };
      if (scene.offsets) moved.offsets = scene.offsets.map((t) => remap(t, storyboard.scenes, shifts));
      return moved;
    });
    try {
      storyboard = validateStoryboard({ ...storyboard, scenes });
    } catch { return; }
    repairs.push({ scene: n, change: `held ${grid} s longer to read (${s.d.toFixed(2)} to ${(s.d + grid).toFixed(2)} s)` });
  });
  return { storyboard, repairs };
}

export interface GauntletOptions {
  dir: string;
  planner: ResolvedPlanner;
  maxRounds?: number;
  log?: (line: string) => void;
}

export interface GauntletResult { stop: "bar-met" | "no-gain" | "no-repair" | "max-rounds"; best: number; reached: boolean; ledger: string; film: string }

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const mean = (fs: Finding[]) => fs.reduce((t, f) => t + f.score, 0) / (fs.length || 1);

/** The film for the saved storyboard: the one already rendered when render.json matches it, else a fresh render. */
async function filmFor(dir: string, sb: Storyboard, raw: string): Promise<{ film: string; seconds: number }> {
  try {
    const m = JSON.parse(readFileSync(join(dir, "render.json"), "utf8")) as { storyboard_sha256: string; out: string; frames: number; fps: number };
    if (m.storyboard_sha256 === sha(raw) && existsSync(join(dir, m.out))) return { film: join(dir, m.out), seconds: m.frames / m.fps };
  } catch { /* no manifest yet */ }
  const engine = (() => { try { return (JSON.parse(readFileSync(join(dir, "render.json"), "utf8")) as { engine?: MotionEngine }).engine; } catch { return undefined; } })();
  const { out, manifest } = await renderMotion(dir, { engine });
  return { film: out, seconds: manifest.frames / manifest.fps };
}

export async function runGauntlet(o: GauntletOptions): Promise<GauntletResult> {
  const log = o.log ?? ((line: string) => console.log(line));
  const budget = new CallBudget(o.dir);
  const bar = DEFAULT_BAR, maxRounds = o.maxRounds ?? DEFAULT_GAUNTLET_ROUNDS;
  validateMaxRounds(maxRounds);
  if (!o.planner.active) throw new JudgeUnavailable(`unavailable - ${o.planner.label} cannot serve: ${o.planner.refusal ?? "no sign-in"}. Sign in with \`claude\`, or save another route in judge.json`);
  const storyboardFile = join(o.dir, "storyboard.json"), ledger = join(o.dir, "gauntlet.jsonl"), keep = join(o.dir, "out", "gauntlet");
  mkdirSync(keep, { recursive: true });
  const priorRuns = existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { run: number }).run) : [];
  const run = Math.max(0, ...priorRuns) + 1;
  const runKeep = join(keep, `run-${run}`);
  mkdirSync(runKeep, { recursive: true });
  const row = (r: object) => appendFileSync(ledger, JSON.stringify({ run, at: new Date().toISOString(), ...r }) + "\n");
  let raw = readFileSync(storyboardFile, "utf8");
  let sb = validateStoryboard(JSON.parse(raw));
  const first = sb;
  const rounds: { n: number; score: number; film: string; storyboard: string; manifest: string; findings: Finding[] }[] = [];
  let stop: GauntletResult["stop"] = "max-rounds";
  let finalized = false;
  const finalize = (best: typeof rounds[number], finalStop: GauntletResult["stop"] | "failed", error?: unknown) => {
    copyFileSync(best.storyboard, storyboardFile);
    copyFileSync(best.manifest, join(o.dir, "render.json"));
    const manifest = JSON.parse(readFileSync(best.manifest, "utf8")) as { out: string };
    const film = join(o.dir, manifest.out);
    copyFileSync(best.film, film);
    const reached = best.findings.every((f) => f.score >= bar);
    const remaining = best.findings.filter((f) => f.score < bar).map((f) => `scene ${f.scene} ${f.pattern} ${f.criterion}: ${f.score}/10`);
    row({ type: "final", stop: finalStop, bar, bestRound: best.n, bestScore: +best.score.toFixed(2), reached, rounds: rounds.length, modelCalls: rounds.length, cap: maxRounds, remaining,
      ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }) });
    return { reached, film, remaining };
  };

  try {
    for (let n = 1; n <= maxRounds; n++) {
      const { film, seconds } = await filmFor(o.dir, sb, raw);
      const copy = join(runKeep, `round-${n}.mp4`);
      copyFileSync(film, copy);
      copyFileSync(storyboardFile, join(runKeep, `round-${n}.storyboard.json`));
      copyFileSync(join(o.dir, "render.json"), join(runKeep, `round-${n}.render.json`));
      const { findings } = await critique(o.planner, sb, film, runKeep, n, budget);
      const score = mean(findings);
      const failing = findings.filter((f) => f.score < bar);
      rounds.push({ n, score, film: copy, storyboard: join(runKeep, `round-${n}.storyboard.json`), manifest: join(runKeep, `round-${n}.render.json`), findings });
      const previous = rounds.at(-2);
      let repairs: Repair[] = [];
      let next: Storyboard | undefined;
      if (!failing.length) stop = "bar-met";
      else if (previous && score - previous.score < GAIN_EPSILON) stop = "no-gain";
      else if (n === maxRounds) stop = "max-rounds";
      else {
        const r = repairStoryboard(sb, first, findings);
        repairs = r.repairs;
        if (!repairs.length) stop = "no-repair"; else next = r.storyboard;
      }
      row({ type: "round", round: n, film: `out/gauntlet/run-${run}/round-${n}.mp4`, filmSha256: sha(readFileSync(copy)), storyboardSha256: sha(raw), seconds: +seconds.toFixed(2),
        judge: o.planner.label, sawStills: false, calls: 1, score: +score.toFixed(2), findings, repairs });
      log(`gauntlet: round ${n} ${score.toFixed(1)}/10, ${failing.length} of ${findings.length} checks under ${bar}`);
      for (const f of failing) log(`gauntlet:   scene ${f.scene} ${f.pattern} ${f.criterion} ${f.score}/10`);
      if (!next) break;
      for (const r of repairs) log(`gauntlet: round ${n + 1} will change scene ${r.scene}: ${r.change}`);
      raw = JSON.stringify(next, null, 2) + "\n";
      writeFileSync(storyboardFile, raw);
      sb = next;
    }
    const best = rounds.reduce((top, r) => (r.score > top.score ? r : top));
    const result = finalize(best, stop);
    finalized = true;
    log(result.reached ? `gauntlet: bar ${bar} met in round ${best.n} (${best.score.toFixed(1)}/10)` : `gauntlet: BELOW BAR - best round ${best.n} ${best.score.toFixed(1)}/10; ${result.remaining.length} check(s) still under ${bar}`);
    log(`gauntlet: ledger ${ledger}`);
    return { stop, best: best.score, reached: result.reached, ledger, film: result.film };
  } catch (error) {
    if (rounds.length && !finalized) finalize(rounds.reduce((top, r) => r.score > top.score ? r : top), "failed", error);
    throw error;
  }
}
