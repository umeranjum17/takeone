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
