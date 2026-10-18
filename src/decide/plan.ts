// analysis/plan.json: each beat's camera choices (shot, idle, follow) as the planner
// made them, in a form the user can edit. A value the user sets with "by": "user"
// survives a rerun of make; render applies every stored value over decisions.jsonl.

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
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Plan : null;
}

/** Write the plan from the decisions. A choice the user set by hand is kept. */
export function writePlan(dir: string, decisions: BeatChoices[]): void {
  const kept = new Map((readPlan(dir)?.beats ?? []).map((b) => [b.id, b]));
  const beats = decisions.map((d) => {
    const prior = kept.get(d.beat);
    const choice = (f: Field): Choice => {
      const old = prior?.[f];
      if (old?.by === "user") return old;
      return d[f] === undefined ? { by: "rule" } : { value: d[f], by: "ai" };
    };
    return { id: d.beat, shot: choice("shot"), idle: choice("idle"), follow: choice("follow") };
  });
  writeFileSync(join(dir, "analysis/plan.json"), JSON.stringify({ version: 1, beats }, null, 1) + "\n");
}

/** Decisions with every stored value applied. A choice without a value keeps the rule. */
export function applyPlan<T extends BeatChoices>(decisions: T[], plan: Plan | null): T[] {
  const byId = new Map(plan?.beats.map((b) => [b.id, b]) ?? []);
  return decisions.map((d) => {
    const beat = byId.get(d.beat);
    if (!beat) return d;
    const overrides = Object.fromEntries(FIELDS.flatMap((f) => beat[f]?.value === undefined ? [] : [[f, beat[f]!.value]]));
    return { ...d, ...overrides };
  });
}
