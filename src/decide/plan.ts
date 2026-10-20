// analysis/plan.json: each beat's camera choices (shot, idle, follow) as the planner
// made them, in a form the user can edit. Only a value the user sets with "by": "user"
// survives a rerun of make; render applies those user values over decisions.jsonl.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FIELDS = ["shot", "idle", "follow"] as const;
type Field = (typeof FIELDS)[number];
interface Choice { value?: boolean; by: "ai" | "rule" | "user" }
export interface Plan { version: 1; beats: ({ id: string } & Partial<Record<Field, Choice>>)[] }
/** The camera choices a decision may carry; undefined means the rules decide. */
interface BeatChoices { beat: string; shot?: boolean; idle?: boolean; follow?: boolean }

export function readPlan(dir: string): Plan | null {
  const path = join(dir, "analysis/plan.json");
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  let plan: Plan;
  try {
    plan = JSON.parse(raw) as Plan;
  } catch {
    throw new Error("analysis/plan.json: is not valid JSON");
  }
  if (typeof plan !== "object" || plan === null || !Array.isArray(plan.beats)) {
    throw new Error("analysis/plan.json: beats must be a list");
  }
  const ids = new Set<string>();
  for (const beat of plan.beats) {
    if (typeof beat !== "object" || beat === null || typeof beat.id !== "string") {
      throw new Error("analysis/plan.json: every beat needs a string id");
    }
    if (ids.has(beat.id)) throw new Error(`analysis/plan.json: beat id ${beat.id} appears more than once`);
    ids.add(beat.id);
    for (const f of FIELDS) {
      const choice = beat[f];
      if (choice === undefined) continue;
      if (!choice || !["ai", "rule", "user"].includes(choice.by)) {
        throw new Error(`analysis/plan.json: ${beat.id}.${f}.by must be ai, rule or user`);
      }
      if (choice.value !== undefined && typeof choice.value !== "boolean") {
        throw new Error(`analysis/plan.json: ${beat.id}.${f}.value must be true or false`);
      }
    }
  }
  return plan;
}

function assertUserEditsKnown(beats: Plan["beats"], ids: Set<string>): void {
  for (const beat of beats) {
    if (!ids.has(beat.id) && FIELDS.some((f) => beat[f]?.by === "user")) {
      throw new Error(`analysis/plan.json: user edit for ${beat.id} matches no beat`);
    }
  }
}

/** Write the plan from the decisions. A choice the user set by hand is kept. */
export function writePlan(dir: string, decisions: BeatChoices[]): void {
  const prior = readPlan(dir)?.beats ?? [];
  assertUserEditsKnown(prior, new Set(decisions.map((d) => d.beat)));
  const kept = new Map(prior.map((b) => [b.id, b]));
  const beats = decisions.map((d) => {
    const old = kept.get(d.beat);
    const choice = (f: Field): Choice => {
      const previous = old?.[f];
      if (previous?.by === "user") return previous;
      return d[f] === undefined ? { by: "rule" } : { value: d[f], by: "ai" };
    };
    return { id: d.beat, shot: choice("shot"), idle: choice("idle"), follow: choice("follow") };
  });
  writeFileSync(join(dir, "analysis/plan.json"), JSON.stringify({ version: 1, beats }, null, 1) + "\n");
}

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

/** The render's view of a beat, for checking that a user edit can be honoured. */
interface PlanBeat { id: string; kind: string; actions?: unknown[] }
interface PlanCheck { androidFallback?: boolean }

const ACTION_KINDS = new Set(["click", "type", "drag", "shortcut"]);

function hasAction(beat: PlanBeat): boolean {
  return (beat.actions ?? []).some((action) => ACTION_KINDS.has((action as { k?: string })?.k ?? ""));
}

/**
 * Refuse a user plan edit the render cannot honour, instead of rendering a
 * silently different film. Only by:"user" values count. Values that match what
 * the render already does stay valid: shot=false on a scroll beat, follow=false
 * on a click beat and idle=false on a non-idle beat are no-ops, not disputes.
 */
export function validatePlan(plan: Plan | null, beats: PlanBeat[], check: PlanCheck = {}): void {
  const byId = new Map(beats.map((beat) => [beat.id, beat]));
  for (const planBeat of plan?.beats ?? []) {
    const edits = FIELDS.filter((field) => planBeat[field]?.by === "user" && planBeat[field]!.value !== undefined);
    if (edits.length === 0) continue;
    const beat = byId.get(planBeat.id);
    if (!beat) continue; // applyPlan reports a user edit that matches no beat
    const where = `analysis/plan.json: beat ${beat.id} (${beat.kind}):`;
    if (check.androidFallback) {
      throw new PlanError(`${where} ${edits.join(", ")} cannot be honoured - this Android take renders the `
        + `rule-only tap fallback, which builds its beats from the taps and ignores plan.json; remove the user edit`);
    }
    for (const field of edits) {
      if (planBeat[field]!.value !== true) continue; // false matches the render's rule on these beats
      if (field === "shot" && !shotSupported(beat)) {
        throw new PlanError(`${where} shot=true cannot be honoured - the render gives no camera move to `
          + `${noShotReason(beat)}; remove the edit or set shot=false`);
      }
      if (field === "idle" && beat.kind !== "idle") {
        throw new PlanError(`${where} idle=true cannot be honoured - only an idle beat can pull back to the window; `
          + `remove the edit or set idle=false`);
      }
      if (field === "follow" && beat.kind !== "drag" && beat.kind !== "travel") {
        throw new PlanError(`${where} follow=true cannot be honoured - the camera only follows a drag or a pointer-travel `
          + `beat, not this one; remove the edit or set follow=false`);
      }
    }
  }
}

/** Why a shot beat gets no camera move, in the render's own terms. */
function noShotReason(beat: PlanBeat): string {
  if (beat.kind === "scroll") return "a scroll beat";
  if (beat.kind === "idle") return "an idle beat";
  return "a pointer-only travel beat";
}

function shotSupported(beat: PlanBeat): boolean {
  if (beat.kind === "scroll" || beat.kind === "idle") return false;
  return beat.kind !== "travel" || hasAction(beat);
}

/** Decisions with every user-set value applied. A choice without a value keeps the rule. */
export function applyPlan<T extends BeatChoices>(decisions: T[], plan: Plan | null): T[] {
  assertUserEditsKnown(plan?.beats ?? [], new Set(decisions.map((d) => d.beat)));
  const byId = new Map(plan?.beats.map((b) => [b.id, b]) ?? []);
  return decisions.map((d) => {
    const beat = byId.get(d.beat);
    if (!beat) return d;
    const overrides = Object.fromEntries(FIELDS.flatMap((f) => beat[f]?.by === "user" && beat[f]!.value !== undefined ? [[f, beat[f]!.value]] : []));
    return { ...d, ...overrides };
  });
}
