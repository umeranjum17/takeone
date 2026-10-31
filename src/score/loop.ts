import { CallBudgetExceeded } from "../decide/budget.ts";
import type { MeasuredFacts, ScoreCard } from "./rubric.ts";

export type StopReason = "target" | "no-gain" | "max-rounds" | "no-improvement" | "judge-unavailable";

export interface Determinism {
  frames: number;
  identical: number;
  tolerance: number;
}

export interface BuildOutput {
  film: string;
  determinism: Determinism;
}

export interface BaselineMeasure {
  facts: MeasuredFacts;
  score: number;
}

export interface RoundRecord {
  round: number;
  score: number;
  items: ScoreCard["items"];
  actions: string[];
  film: string;
  measured: MeasuredFacts;
  model: string;
  calls: number;
}

export interface LoopHooks {
  target?: number;
  maxRounds?: number;
  build: (round: number) => Promise<BuildOutput>;
  measure: (
    film: string,
    round: number,
    determinism: Determinism,
    baseline: BaselineMeasure | undefined,
  ) => Promise<MeasuredFacts>;
  judge: (measured: MeasuredFacts) => Promise<ScoreCard>;
  improve: (card: ScoreCard, measured: MeasuredFacts, round: number) => Promise<string[]>;
  log?: (line: string) => void;
}

export interface LoopResult {
  target: number;
  maxRounds: number;
  rounds: RoundRecord[];
  best: RoundRecord | null;
  reached: boolean;
  belowTarget: boolean;
  stop: StopReason;
  calls: number;
  judgeError?: string;
  remaining: string[];
}

export const DEFAULT_TARGET_SCORE = 9;
export const DEFAULT_MAX_ROUNDS = 4;
export const GAIN_EPSILON = 0.2;

const logLine = (hooks: LoopHooks, line: string) => (hooks.log ?? ((s) => console.log(s)))(line);

export async function runScoreLoop(hooks: LoopHooks): Promise<LoopResult> {
  const target = hooks.target ?? DEFAULT_TARGET_SCORE;
  const maxRounds = hooks.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const rounds: RoundRecord[] = [];
  let stop: StopReason = "max-rounds";
  let calls = 0;
  let judgeError: string | undefined;

  for (let round = 1; round <= maxRounds; round++) {
    const built = await hooks.build(round);
    const first = rounds[0];
    const baseline = first === undefined ? undefined : { facts: first.measured, score: first.score };
    const measured = await hooks.measure(built.film, round, built.determinism, baseline);
    let card: ScoreCard;
    try {
      card = await hooks.judge(measured);
    } catch (e) {
      // A spent budget ends the run; it is not a judge that could not answer.
      if (e instanceof CallBudgetExceeded) throw e;
      judgeError = e instanceof Error ? e.message : String(e);
      stop = "judge-unavailable";
      logLine(hooks, `score: judge unavailable in round ${round}: ${judgeError}`);
      break;
    }
    calls += card.calls;
    const previous = rounds.at(-1);
    let actions: string[] = [];
    const record: RoundRecord = {
      round, score: card.score, items: card.items, actions, film: built.film,
      measured, model: card.model, calls: card.calls,
    };
    rounds.push(record);
    logLine(hooks, `score: round ${round} ${card.score.toFixed(1)}/10 (${card.items.map((i) => `${i.id} ${i.score}`).join(", ")})`);

    if (card.score >= target) { stop = "target"; break; }
    if (previous && card.score - previous.score < GAIN_EPSILON) { stop = "no-gain"; break; }
    if (round === maxRounds) { stop = "max-rounds"; break; }
    actions = await hooks.improve(card, measured, round);
    record.actions = actions;
    if (actions.length === 0) {
      stop = "no-improvement";
      logLine(hooks, `score: stop after round ${round} - no gain left: no remaining build-input change measurably changes the film`);
      break;
    }
    for (const action of actions) logLine(hooks, `score: round ${round + 1} will ${action}`);
  }

  const best = rounds.reduce<RoundRecord | null>((top, r) => (top === null || r.score > top.score ? r : top), null);
  const reached = best !== null && best.score >= target;
  const remaining = best === null
    ? ["the judge did not score any round"]
    : best.items.filter((item) => item.score < target).map((item) => `${item.label}: ${item.score}/10 - ${item.note}`);
  return {
    target, maxRounds, rounds, best, reached, belowTarget: !reached, stop, calls,
    ...(judgeError === undefined ? {} : { judgeError }),
    remaining,
  };
}
