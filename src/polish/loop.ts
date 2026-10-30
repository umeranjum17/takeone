// The polish loop: an independent judge scores the picked cut and a builder refines that same cut round by round.
// It follows first-draft's `polish` (src/polish.mjs, first-draft PR 105): round 0 is the picked cut itself, the
// owner's feedback is cumulative and read again before every round, a round that changes the picked direction or
// misses any feedback is rejected and the next round builds on the last accepted one, and the run stops at the
// target (9/10), at the round cap, or after two rounds without a better accepted score. One difference: a page
// ships its latest accepted round, a film ships its best-scored accepted round (the latest one on a tie).

export const POLISH_TARGET = 9;
export const DEFAULT_POLISH_ROUNDS = 5;
export const MAX_POLISH_ROUNDS = 5;

export type PolishStop = "target_reached" | "no_improvement_two_rounds" | "round_cap" | "no_change_left" | "error";

export interface Feedback {
  id: string;
  at: string;
  text: string;
  /** Where it came from: typed with --feedback or polish-feedback, or a note left on the sign-off board. */
  source: "cli" | "board";
}

export interface FeedbackCheck {
  id: string;
  kept: boolean;
  reason: string;
}

export interface Critique {
  score: number;
  items: { id: string; label: string; score: number; note: string }[];
  /** Actionable gaps: what the next round works on. */
  gaps: string[];
  /** The picked theme and camera motion are still the ones the owner picked. */
  directionKept: boolean;
  feedback: FeedbackCheck[];
  judge: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface Candidate {
  film: string;
  /** The settings this round rendered with, so an accepted round can be the next seed and the final film. */
  set: string[];
  meta: Record<string, unknown>;
  /** What the builder changed from the seed, in plain words. */
  changes: string[];
}

export interface PolishRound {
  round: number;
  film: string;
  score: number | null;
  accepted: boolean;
  feedback: Feedback[];
  /** Feedback arrived while this round was judged, so it was not checked against it. */
  feedback_pending: boolean;
  set: string[];
  meta: Record<string, unknown>;
  changes: string[];
  critique?: Critique;
  error?: string;
}

export interface PolishState {
  version: 1;
  target: number;
  max_rounds: number;
  status: "running" | "stopped" | "failed";
  stop_reason?: PolishStop;
  error?: string;
  rounds: PolishRound[];
  /** The film the run ships: its best-scored accepted round. */
  final: { round: number; film: string; score: number } | null;
  pending?: { round: number; film: string; feedback: Feedback[] };
}

export interface PolishHooks {
  maxRounds: number;
  /** Round 0 renders the picked cut as it is; later rounds refine the seed. Null when no build input is left to change. */
  build: (round: number, seed: Candidate | null, gaps: string[], feedback: Feedback[]) => Promise<Candidate | null>;
  judge: (candidate: Candidate, round: number, feedback: Feedback[]) => Promise<Critique>;
  /** All feedback so far, oldest first; read again after judging to see whether any arrived meanwhile. */
  feedbackAt: () => Feedback[];
  save: (state: PolishState) => void;
  onRound?: (entry: PolishRound, state: PolishState) => Promise<void> | void;
}

export function roundCap(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > MAX_POLISH_ROUNDS) throw new Error(`--max-rounds must be an integer from 1 to ${MAX_POLISH_ROUNDS}`);
  return n;
}

const same = (a: Feedback[], b: Feedback[]) => JSON.stringify(a.map((f) => f.id)) === JSON.stringify(b.map((f) => f.id));

export async function runPolish(h: PolishHooks): Promise<PolishState> {
  const maxRounds = roundCap(h.maxRounds);
  const state: PolishState = { version: 1, target: POLISH_TARGET, max_rounds: maxRounds, status: "running", rounds: [], final: null };
  h.save(state);
  let seed: Candidate | null = null;
  let gaps: string[] = [];
  let seedGaps: string[] = [];
  let stalled = 0;
  let previous: number | null = null;
  let latest: number | null = null;
  try {
    for (let round = 0; round <= maxRounds; round++) {
      const given = h.feedbackAt();
      const made = await h.build(round, seed, gaps, given);
      if (!made) {
        state.status = "stopped";
        state.stop_reason = "no_change_left";
        h.save(state);
        break;
      }
      state.pending = { round, film: made.film, feedback: given };
      h.save(state);
      const critique = await h.judge(made, round, given);
      const pending = !same(given, h.feedbackAt());
      const kept = critique.directionKept && critique.feedback.every((f) => f.kept);
      const accepted = round === 0 || kept;
      const entry: PolishRound = {
        round, film: made.film, score: critique.score, accepted, feedback: given, feedback_pending: pending,
        set: made.set, meta: made.meta, changes: made.changes, critique,
      };
      state.rounds.push(entry);
      delete state.pending;
      if (accepted) {
        seed = made;
        seedGaps = critique.gaps;
        latest = critique.score;
        if (!state.final || critique.score >= state.final.score) state.final = { round, film: made.film, score: critique.score };
      }
      if (round > 0) stalled = latest! > previous! ? 0 : stalled + 1;
      previous = latest;
      gaps = [
        ...new Set([...seedGaps, ...critique.gaps]),
        ...(critique.directionKept ? [] : ["The round changed the picked direction (its theme or camera motion). Return to the picked look."]),
        ...critique.feedback.filter((f) => !f.kept).map((f) => `Owner feedback not met: ${given.find((g) => g.id === f.id)?.text}. ${f.reason}`),
      ];
      const meets = accepted && !pending && kept && critique.score >= POLISH_TARGET;
      if (meets || stalled >= 2 || round === maxRounds) {
        state.status = "stopped";
        state.stop_reason = meets ? "target_reached" : stalled >= 2 ? "no_improvement_two_rounds" : "round_cap";
      }
      h.save(state);
      await h.onRound?.(entry, state);
      if (state.status === "stopped") break;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (state.pending) {
      state.rounds.push({ ...state.pending, score: null, accepted: false, feedback_pending: false, set: [], meta: {}, changes: [], error: message });
      delete state.pending;
    }
    state.status = "failed";
    state.stop_reason = "error";
    state.error = message;
    h.save(state);
    throw Object.assign(e instanceof Error ? e : new Error(message), { run: state });
  }
  return state;
}
