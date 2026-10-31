// One model-call budget per take. Every request to a model is spent here, once, immediately before it is sent: a
// retried request, a chunk re-ask and a prerequisite planning pass are each a request, so each is a unit. Nothing else
// counts calls, so no path can run past the cap by being counted somewhere else.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The ceiling on model requests one take may send over its whole life, sized from a measured run: planning a 400 s take at
 * the planner's densest (30 beats a minute) is 54 requests (4 film, 50 beat; test/make.test.ts), so planning it twice
 * (a `--replan`) is 108, and the rest of the take's life (directions: 1 planner and 3 judge calls, a score loop of up to
 * 4 judge rounds, retries, a motion recipe or gauntlet) is covered by the remaining 42. */
export const MAX_CALLS_PER_TAKE = 150;

/** What a take has cost in requests so far, as `take.json` records it. */
export interface CallSummary {
  cap: number;
  used: number;
  by_workflow: Record<string, number>;
}

export class CallBudgetExceeded extends Error {
  readonly workflow: string;
  readonly used: number;
  readonly cap: number;
  constructor(workflow: string, used: number, cap: number) {
    super(`the ${workflow} workflow hit the cap of ${cap} model calls per take after ${used} calls; plan a shorter take or split the work`);
    this.name = "CallBudgetExceeded";
    this.workflow = workflow;
    this.used = used;
    this.cap = cap;
  }
}

export class CallBudget {
  readonly byWorkflow: Record<string, number> = {};
  used = 0;
  /** Set when a spend was refused: the decider swallows a backend's throw, so the caller rethrows this. */
  tripped: CallBudgetExceeded | undefined;

  /** `dir` is the take whose `take.json` holds the count: a budget opened on a take that has spent calls starts from
   * them, so make, directions, score, the judge and the motion recipes draw down one count however many commands
   * they run in. None for a take that does not exist yet; its first `take.json` write carries `summary()`. */
  readonly dir: string | undefined;
  readonly cap: number;
  constructor(dir?: string, cap = MAX_CALLS_PER_TAKE) {
    this.dir = dir;
    this.cap = cap;
    const file = dir === undefined ? undefined : join(dir, "take.json");
    if (!file || !existsSync(file)) return;
    const saved = (JSON.parse(readFileSync(file, "utf8")) as { calls?: Partial<CallSummary> }).calls;
    if (!saved || typeof saved.used !== "number") return;
    this.used = saved.used;
    Object.assign(this.byWorkflow, saved.by_workflow);
  }

  get remaining(): number {
    return this.cap - this.used;
  }

  summary(): CallSummary {
    return { cap: this.cap, used: this.used, by_workflow: { ...this.byWorkflow } };
  }

  /** Count one request for `workflow`, or throw naming it and the calls made so far. Call this right before sending. */
  spend(workflow: string): void {
    if (this.used >= this.cap) {
      this.tripped ??= new CallBudgetExceeded(workflow, this.used, this.cap);
      throw this.tripped;
    }
    this.used++;
    this.byWorkflow[workflow] = (this.byWorkflow[workflow] ?? 0) + 1;
    this.record();
  }

  /** Write the count onto the take, so what a take cost stays auditable after the run. */
  record(): void {
    const file = this.dir === undefined ? undefined : join(this.dir, "take.json");
    if (!file || !existsSync(file)) return;
    const meta = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...meta, calls: this.summary() }, null, 1) + "\n");
  }
}

/** A fetch that spends one unit before every request it sends, retries included. */
export function meteredFetch(inner: typeof fetch, budget: CallBudget, workflow: string): typeof fetch {
  return ((url, init) => {
    budget.spend(workflow);
    return inner(url, init);
  }) as typeof fetch;
}
