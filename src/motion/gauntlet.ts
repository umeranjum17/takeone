// The motion gauntlet: render a motion film, have a fresh-context critic score each scene against a written
// reference, repair what scored under the bar by bounded edits to storyboard.json, render again, and keep a
// durable ledger of every round. The critic sees only scene facts, never the planner's
// conversation; every repair is one beat-grid step on one scene and is checked by the storyboard validator.
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryCache, type ImageInput, type Question } from "@byokit/decide";
import { askChunk, type ResolvedPlanner } from "../decide/planner.ts";
import { runFfmpeg } from "../render/ffmpeg.ts";
import { JudgeUnavailable, LEVELS, answerScore } from "../score/judge.ts";
import { renderMotion } from "./motion.ts";
import { minSceneDuration, sceneTexts, validateStoryboard } from "./storyboard.ts";
import type { MotionEngine, Scene, Storyboard } from "./types.ts";

export const DEFAULT_BAR = 8;
export const DEFAULT_GAUNTLET_ROUNDS = 2;
export const MAX_GAUNTLET_ROUNDS = 5;
/** A scene may grow by at most this many beat-grid steps over the film's first plan, so repairs cannot run away. */
export const MAX_GROWTH_STEPS = 2;
const GAIN_EPSILON = 0.2;
const CRITIC_TIMEOUT_MS = 180000;

/** The written reference: what a finished editorial launch film scene is held to. */
export const REFERENCE = {
  read: "Every word the scene sets stays on screen long enough to read comfortably, about three words a second after it appears, and no word is cut, clipped or crowded against the frame edge.",
  drag: "The scene earns its length: nothing sits idle once its words have landed, and it cuts on the beat as soon as its point is made.",
  size: "The product screen is shown large enough that its labels read at 1080p, not as a small window inside a frame.",
} as const;
type Criterion = keyof typeof REFERENCE;

export interface Finding { id: string; scene: number; pattern: string; criterion: Criterion; score: number; note: string }
export interface Repair { scene: number; change: string }

/** The beat-grid step a scene's length moves by: one beat of the film's tempo, else half a second. */
const step = (sb: Storyboard): number => (sb.tempo ? 60 / sb.tempo.bpm / (sb.tempo.snap === "half" ? 2 : 1) : 0.5);
const shownDevice = (s: Scene): boolean => (s.pattern === "hero-reveal" || s.pattern === "zoom-tour") && (s.device ?? "browser") !== "none";
const settledAt = (s: Scene): number => s.at! + s.d * 0.7;

function questionsFor(sb: Storyboard): Record<string, Question> {
  const out: Record<string, Question> = {};
  sb.scenes.forEach((s, i) => {
    const text = sceneTexts(s).join(" / ") || "(no words)";
    const facts = `Scene ${i + 1} of ${sb.scenes.length}, ${s.pattern}, ${s.d.toFixed(2)} s long (its words need at least ${minSceneDuration(s).toFixed(2)} s). Words: ${text}.`;
    const criteria: Criterion[] = shownDevice(s) ? ["read", "drag", "size"] : ["read", "drag"];
    for (const c of criteria) {
      out[`s${i + 1}-${c}`] = { kind: "score", levels: LEVELS, floor: 0, instructions: `${REFERENCE[c]}\n${facts}` };
    }
  });
  return out;
}

async function stills(film: string, sb: Storyboard, dir: string, round: number): Promise<ImageInput[]> {
  mkdirSync(dir, { recursive: true });
  const out: ImageInput[] = [];
  for (const [i, s] of sb.scenes.entries()) {
    const png = join(dir, `round-${round}-scene-${i + 1}.png`);
    await runFfmpeg(["-v", "error", "-y", "-threads", "2", "-ss", settledAt(s).toFixed(3), "-i", film, "-frames:v", "1", "-vf", "scale=1280:-2", "-filter_threads", "2", png]);
    out.push({ id: `scene-${i + 1}`, mime: "image/png", bytes: new Uint8Array(readFileSync(png)) });
  }
  return out;
}

/** Settled stills are kept for the person reading the ledger; the critic receives scene facts only. */
export async function critique(planner: ResolvedPlanner, sb: Storyboard, film: string, dir: string, round: number): Promise<{ findings: Finding[] }> {
  await stills(film, sb, dir, round);
  const questions = questionsFor(sb);
  const state = {
    task: "You are a fresh critic of one finished launch film. Score each scene against the written reference. Be strict: 10 is the reference bar, and a scene that merely works is a 7.",
    scale: "Each item is an integer from 0 (absent or broken) to 10 (at the reference bar).",
    film: { seconds: sb.scenes.reduce((t, s) => Math.max(t, s.at! + s.d), 0), scenes: sb.scenes.length },
  };
  const outcome = await askChunk(state, questions, planner, new MemoryCache(), { timeoutMs: CRITIC_TIMEOUT_MS, keepAnswers: true });
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

/** Bounded repairs for the findings under the bar, each one beat-grid step on one scene (and the device frame
 *  dropped from a screen shown too small). `first` is the film's first plan: no scene grows past it by more than
 *  MAX_GROWTH_STEPS. A repair the validator refuses is skipped. Only a single-timeline film is repaired. */
export function repairStoryboard(sb: Storyboard, first: Storyboard, findings: Finding[]): { storyboard: Storyboard; repairs: Repair[] } {
  const repairs: Repair[] = [];
  if (sb.layout.kind !== "single") return { storyboard: sb, repairs };
  const low = (n: number, c: Criterion) => findings.some((f) => f.scene === n && f.criterion === c && f.score < DEFAULT_BAR);
  const scenes = sb.scenes.map((s) => ({ ...s }));
  const grid = step(sb);
  const delta = scenes.map(() => 0);
  scenes.forEach((s, i) => {
    const n = i + 1, firstD = first.scenes[i]?.d ?? s.d;
    if (low(n, "read") && !low(n, "drag")) {
      if (s.d + grid <= firstD + MAX_GROWTH_STEPS * grid + 1e-9) { delta[i] = grid; repairs.push({ scene: n, change: `held ${grid} s longer to read (${s.d.toFixed(2)} to ${(s.d + grid).toFixed(2)} s)` }); }
    } else if (low(n, "drag") && !low(n, "read")) {
      if (s.d - grid >= minSceneDuration(s) - 1e-9 && s.d - grid >= 1) { delta[i] = -grid; repairs.push({ scene: n, change: `cut ${grid} s shorter (${s.d.toFixed(2)} to ${(s.d - grid).toFixed(2)} s)` }); }
    }
    if (low(n, "size") && shownDevice(s)) { s.device = "none"; repairs.push({ scene: n, change: "dropped the device frame so the screen fills more of the frame" }); }
  });
  const shifts = delta.map((_, i) => delta.slice(0, i).reduce((a, b) => a + b, 0)); // growth before scene i
  const out = scenes.map((s, i) => {
    const moved: Scene = { ...s, d: s.d + delta[i]!, ...(s.at === undefined ? {} : { at: s.at + shifts[i]! }) };
    if (s.offsets) moved.offsets = s.offsets.map((t) => remap(t, sb.scenes, shifts));
    return moved;
  });
  try {
    return { storyboard: validateStoryboard({ ...sb, scenes: out }), repairs };
  } catch {
    return { storyboard: sb, repairs: [] };
  }
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
  const bar = DEFAULT_BAR, maxRounds = o.maxRounds ?? DEFAULT_GAUNTLET_ROUNDS;
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_GAUNTLET_ROUNDS) throw new Error(`--max-rounds expects an integer 1-${MAX_GAUNTLET_ROUNDS}`);
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

  for (let n = 1; n <= maxRounds; n++) {
    const { film, seconds } = await filmFor(o.dir, sb, raw);
    const copy = join(runKeep, `round-${n}.mp4`);
    copyFileSync(film, copy);
    copyFileSync(storyboardFile, join(runKeep, `round-${n}.storyboard.json`));
    copyFileSync(join(o.dir, "render.json"), join(runKeep, `round-${n}.render.json`));
    const { findings } = await critique(o.planner, sb, film, runKeep, n);
    const score = mean(findings);
    const failing = findings.filter((f) => f.score < bar);
    rounds.push({ n, score, film: copy, storyboard: join(runKeep, `round-${n}.storyboard.json`), manifest: join(runKeep, `round-${n}.render.json`), findings });
    log(`gauntlet: round ${n} ${score.toFixed(1)}/10, ${failing.length} of ${findings.length} checks under ${bar}`);
    for (const f of failing) log(`gauntlet:   scene ${f.scene} ${f.pattern} ${f.criterion} ${f.score}/10`);
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
    if (!next) break;
    for (const r of repairs) log(`gauntlet: round ${n + 1} will change scene ${r.scene}: ${r.change}`);
    raw = JSON.stringify(next, null, 2) + "\n";
    writeFileSync(storyboardFile, raw);
    sb = next;
  }

  const best = rounds.reduce((top, r) => (r.score > top.score ? r : top));
  // The film kept is the best round's: put its storyboard, render manifest and film back where `takeone render` reads them.
  copyFileSync(best.storyboard, storyboardFile);
  copyFileSync(best.manifest, join(o.dir, "render.json"));
  copyFileSync(best.film, join(o.dir, (JSON.parse(readFileSync(best.manifest, "utf8")) as { out: string }).out));
  const reached = best.findings.every((f) => f.score >= bar);
  const remaining = best.findings.filter((f) => f.score < bar).map((f) => `scene ${f.scene} ${f.pattern} ${f.criterion}: ${f.score}/10`);
  row({ type: "final", stop, bar, bestRound: best.n, bestScore: +best.score.toFixed(2), reached, rounds: rounds.length, modelCalls: rounds.length, cap: maxRounds, remaining });
  log(reached ? `gauntlet: bar ${bar} met in round ${best.n} (${best.score.toFixed(1)}/10)` : `gauntlet: BELOW BAR - best round ${best.n} ${best.score.toFixed(1)}/10; ${remaining.length} check(s) still under ${bar}`);
  log(`gauntlet: ledger ${ledger}`);
  const manifest = JSON.parse(readFileSync(join(o.dir, "render.json"), "utf8")) as { out: string };
  return { stop, best: best.score, reached, ledger, film: join(o.dir, manifest.out) };
}
