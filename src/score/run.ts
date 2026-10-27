import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CameraDefaults } from "../camera/defaults.ts";
import { resolveTheme } from "../themes.ts";
import type { TakeMeta } from "../camera/types.ts";
import { makeTake, type MakeOptions, type MakeResult } from "../make.ts";
import { renderTake } from "../render/render.ts";
import { PlannerFileCache, resolveJudge, type ResolvedPlanner } from "../decide/planner.ts";
import { JudgeUnavailable, judgeRound } from "./judge.ts";
import { improveRound } from "./improve.ts";
import { runScoreLoop, type LoopResult } from "./loop.ts";
import { clearOverlays, compareFrames, frameHashes, measureFilm } from "./measure.ts";

export interface ScoreRunOptions {
  dir: string;
  make: MakeOptions;
  target: number;
  maxRounds: number;
  configDir?: string;
  log: (line: string) => void;
  warn: (line: string) => void;
  resolveFilmCamera: (dir: string, setPairs: string[], theme?: string) => CameraDefaults;
}

export interface ScoreRunResult {
  result: LoopResult;
  film: string;
  scoreFile: string;
  judge: string;
  builder: string;
  judgeUnavailable: boolean;
}

function readMeta(dir: string): TakeMeta {
  return JSON.parse(readFileSync(join(dir, "take.json"), "utf8")) as TakeMeta;
}

function writeMeta(dir: string, meta: TakeMeta): void {
  writeFileSync(join(dir, "take.json"), JSON.stringify(meta, null, 1) + "\n");
}

function builderLabel(meta: TakeMeta): string {
  const planner = meta.planner as { backend?: string | null; model?: string | null } | undefined;
  return [planner?.backend, planner?.model].filter(Boolean).join(" ") || "configured planner";
}

async function determinismRound(dir: string, film: string, camera: CameraDefaults, log: (line: string) => void) {
  const outDir = join(dir, "out");
  const first = join(outDir, "score", `${basename(film, ".mp4")}-first.mp4`);
  mkdirSync(join(outDir, "score"), { recursive: true });
  copyFileSync(film, first);
  clearOverlays(dir);
  const again = await renderTake(dir, camera);
  const det = compareFrames(frameHashes(first), frameHashes(again.out));
  log(`score: determinism ${det.identical}/${det.frames} decoded frames identical on a second render (tolerance ${(det.tolerance * 100).toFixed(1)}%)`);
  return det;
}

function relative(dir: string, path: string): string {
  const prefix = dir.endsWith("/") ? dir : `${dir}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

export async function makeWithScore(o: ScoreRunOptions): Promise<ScoreRunResult> {
  const judgePlanner: ResolvedPlanner = await resolveJudge({
    ...(o.configDir === undefined ? {} : { configDir: o.configDir }),
  });
  if (!judgePlanner.active) {
    throw new JudgeUnavailable(`unavailable - ${judgePlanner.label} cannot serve: ${judgePlanner.refusal ?? "no sign-in"}. Sign in with \`claude\`, or save another route in judge.json`);
  }
  const cache = new PlannerFileCache(join(o.dir, "analysis", "score-cache.jsonl"), o.warn);
  let camera = o.make.camera ?? resolveTheme(readMeta(o.dir).theme);
  let det = { frames: 0, identical: 0, tolerance: 0.995 };
  let made: MakeResult | undefined;
  let builder = "configured planner";
  const limitations: string[] = [];

  const result = await runScoreLoop({
    target: o.target,
    maxRounds: o.maxRounds,
    log: o.log,
    build: async (round) => {
      if (round === 1) {
        clearOverlays(o.dir);
        made = await makeTake(o.dir, { ...o.make, camera, log: o.log, warn: o.warn });
        if (!made.out) throw new Error("make produced no film");
        camera = o.resolveFilmCamera(o.dir, o.make.set ?? [], o.make.theme);
        builder = builderLabel(readMeta(o.dir));
        det = await determinismRound(o.dir, made.out, camera, o.log);
      } else {
        clearOverlays(o.dir);
        const rendered = await renderTake(o.dir, camera);
        made = { ...made!, out: rendered.out, seconds: rendered.seconds };
      }
      const film = made!.out!;
      const keep = join(o.dir, "out", "score", `round-${round}.mp4`);
      mkdirSync(join(o.dir, "out", "score"), { recursive: true });
      copyFileSync(film, keep);
      return { film: keep, determinism: det };
    },
    measure: async (film, round, determinism, baseline) => {
      const facts = await measureFilm(film, round, determinism, {
        dir: o.dir,
        camera,
        frameDir: join(o.dir, "out", "score"),
        ...(baseline === undefined ? {} : { baseline }),
      });
      return facts;
    },
    judge: (facts) => judgeRound(judgePlanner, facts, { cache, log: o.log }),
    improve: (card, facts) => {
      const meta = readMeta(o.dir);
      return improveRound(card, facts, {
        dir: o.dir,
        camera,
        meta,
        writeMeta: () => writeMeta(o.dir, meta),
        singlePass: () => { process.env.TAKEONE_RENDER_SEGMENTS = "1"; },
        limitations,
      });
    },
  });

  const best = result.best;
  const film = best?.film ?? made?.out;
  if (!film) throw new Error("the score loop produced no film");
  const finalFilm = join(o.dir, "out", `${readMeta(o.dir).id ?? basename(o.dir)}.mp4`);
  if (film !== finalFilm) copyFileSync(film, finalFilm);
  const scoreFile = join(o.dir, "out", "score.json");
  const summary = {
    target: result.target,
    maxRounds: result.maxRounds,
    reached: result.reached,
    belowTarget: result.belowTarget,
    stop: result.stop,
    bestRound: best?.round ?? null,
    bestScore: best?.score ?? null,
    film: relative(o.dir, finalFilm),
    judge: judgePlanner.label,
    builder,
    modelCalls: { perRound: 1, total: result.calls, cap: result.maxRounds },
    determinism: { frames: det.frames, identical: det.identical, tolerance: det.tolerance },
    remaining: result.remaining,
    limitations: [...new Set(limitations)],
    ...(result.judgeError === undefined ? {} : { judgeError: result.judgeError }),
    rounds: result.rounds.map((round) => ({
      round: round.round,
      score: round.score,
      items: round.items,
      actions: round.actions,
      film: relative(o.dir, round.film),
      frames: round.measured.frames.map((frame) => ({ ...frame, path: relative(o.dir, frame.path) })),
      measured: { ...round.measured, film: relative(o.dir, round.measured.film), frames: undefined },
      model: round.model,
      calls: round.calls,
    })),
  };
  writeFileSync(scoreFile, JSON.stringify(summary, null, 1) + "\n");
  o.log(`score: judge ${judgePlanner.label}; builder ${builder}`);
  for (const limitation of [...new Set(limitations)]) o.log(`score: limitation - ${limitation}`);
  o.log(`score: ${result.calls} judge call(s) total, 1 per judged round, cap ${result.maxRounds}`);
  if (result.belowTarget) {
    o.log(`score: BELOW TARGET - best ${best ? best.score.toFixed(1) : "unjudged"}/10 against ${result.target}/10`);
    for (const defect of result.remaining) o.log(`score: remaining - ${defect}`);
  } else {
    o.log(`score: target reached - ${best!.score.toFixed(1)}/10 against ${result.target}/10 in round ${best!.round}`);
  }
  o.log(`score: film ${relative(o.dir, finalFilm)}; report ${relative(o.dir, scoreFile)}`);
  return {
    result, film: finalFilm, scoreFile, judge: judgePlanner.label, builder,
    judgeUnavailable: result.stop === "judge-unavailable",
  };
}

