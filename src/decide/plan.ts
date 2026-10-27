// analysis/plan.json: each beat's camera choices (shot, idle, follow) as the planner
// made them, in a form the user can edit. Only a value the user sets with "by": "user"
// survives a rerun of make; render applies those user values over decisions.jsonl.
//
// Every beat carries a stable key next to its position: a hash of what the beat
// shows, not where it sits (see beats/key.ts). A user edit belongs to that key,
// so a re-cut that re-segments the take keeps the edit on the beat the user
// edited. An edit whose beat is gone from the take is dropped and reported, and
// an edit whose key no longer matches the beat it names is refused, never
// applied to a different beat.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

const FIELDS = ["shot", "idle", "follow"] as const;
type Field = (typeof FIELDS)[number];
interface Choice { value?: boolean; by: "ai" | "rule" | "user" }
/** One beat in the plan: where it sits now, what it is, and the camera choices. */
export interface PlanBeat { id: string; key: string; shot?: Choice; idle?: Choice; follow?: Choice }
export interface Plan { version: 2; beats: PlanBeat[]; dropped?: PlanBeat[] }
/** The camera choices a decision may carry; undefined means the rules decide. */
interface BeatChoices { beat: string; shot?: boolean; idle?: boolean; follow?: boolean }
/** The beats a plan is written for: the position and the stable key. */
interface BeatKey { id: string; key?: string }

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
  if (plan.version !== 2) {
    throw new Error(`analysis/plan.json: plan version ${String(plan.version)} is not supported; `
      + "this takeone writes version 2 - delete the file and run takeone make to rebuild it");
  }
  const keys = new Set<string>();
  // The dropped edits keep the place they were made at, so their ids may
  // repeat a live beat's id; their keys may not.
  for (const [section, beats] of [["beats", plan.beats], ["dropped", plan.dropped ?? []]] as const) {
    const sectionIds = new Set<string>();
    for (const beat of beats) {
      if (typeof beat !== "object" || beat === null || typeof beat.id !== "string") {
        throw new Error("analysis/plan.json: every beat needs a string id");
      }
      if (typeof beat.key !== "string" || beat.key === "") {
        throw new Error(`analysis/plan.json: beat ${beat.id} needs a key`);
      }
      if (sectionIds.has(beat.id)) throw new Error(`analysis/plan.json: beat id ${beat.id} appears more than once`);
      if (keys.has(beat.key)) throw new Error(`analysis/plan.json: beat key ${beat.key} appears more than once`);
      sectionIds.add(beat.id);
      keys.add(beat.key);
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

/** The fields of a beat the user set by hand. */
function userFields(beat: PlanBeat): Field[] {
  return FIELDS.filter((f) => beat[f]?.by === "user");
}

/** What a rerun did with the user's edits, for make to report. */
export interface PlanWrite {
  /** The plan as written. */
  beats: PlanBeat[];
  /** Edits whose beat the cut removed. */
  dropped: PlanBeat[];
  /** Edits the cut moved to another place in the film: the beat the user edited, and the beat it is on now. */
  moved: { from: string; to: string; key: string }[];
}

/**
 * Write the plan from the decisions. A choice the user set by hand is kept, and
 * it follows its beat: the prior plan is matched by the beat's stable key, so a
 * re-cut that moves the beat keeps the edit on it. An edit whose beat is no
 * longer in the take is dropped, and reported to the caller so the user sees it.
 */
export function writePlan(dir: string, decisions: BeatChoices[], beats: BeatKey[]): PlanWrite {
  const prior = readPlan(dir);
  const keys = new Map(beats.map((b) => [b.id, b.key ?? ""]));
  // The user's edits, by the beat they belong to. A dropped edit keeps its
  // place in this map: a beat that comes back in a later cut takes its edit.
  const edits = new Map<string, PlanBeat>();
  for (const beat of [...(prior?.beats ?? []), ...(prior?.dropped ?? [])]) {
    if (userFields(beat).length > 0) edits.set(beat.key, beat);
  }
  const kept = new Set<string>();
  const moved: PlanWrite["moved"] = [];
  const out: PlanBeat[] = decisions.map((d) => {
    const key = keys.get(d.beat) ?? "";
    const old = edits.get(key);
    if (old) {
      kept.add(key);
      if (old.id !== d.beat) moved.push({ from: old.id, to: d.beat, key });
    }
    const choice = (f: Field): Choice => {
      const previous = old?.[f];
      if (previous?.by === "user") return previous;
      return d[f] === undefined ? { by: "rule" } : { value: d[f], by: "ai" };
    };
    return { id: d.beat, key, shot: choice("shot"), idle: choice("idle"), follow: choice("follow") };
  });
  const dropped: PlanBeat[] = [];
  for (const [key, beat] of edits) {
    if (kept.has(key)) continue;
    const entry: PlanBeat = { id: beat.id, key };
    for (const f of FIELDS) if (beat[f] !== undefined) entry[f] = beat[f];
    dropped.push(entry);
  }
  writeFileSync(join(dir, "analysis/plan.json"), JSON.stringify({ version: 2, beats: out, dropped }, null, 1) + "\n");
  return { beats: out, dropped, moved };
}

/** The render's view of a beat, for checking that a user edit can be honoured. */
interface PlanBeatView { id: string; kind: string; key?: string; actions?: unknown[] }

const ACTION_KINDS = new Set(["click", "type", "drag", "shortcut"]);

function hasAction(beat: PlanBeatView): boolean {
  return (beat.actions ?? []).some((action) => ACTION_KINDS.has((action as { k?: string })?.k ?? ""));
}

/**
 * Refuse a user plan edit the render cannot honour, instead of rendering a
 * silently different film. Only by:"user" values count. Values that match what
 * the render already does stay valid: shot=false on a scroll beat, follow=false
 * on a click beat and idle=false on a non-idle beat are no-ops, not disputes.
 */
export function validatePlan(plan: Plan | null, beats: PlanBeatView[]): void {
  const byId = new Map(beats.map((beat) => [beat.id, beat]));
  for (const planBeat of plan?.beats ?? []) {
    const edits = FIELDS.filter((field) => planBeat[field]?.by === "user" && planBeat[field]!.value !== undefined);
    if (edits.length === 0) continue;
    const beat = byId.get(planBeat.id);
    if (!beat) continue; // applyPlan reports a user edit that matches no beat
    const where = `analysis/plan.json: beat ${beat.id} (${beat.kind}):`;
    // The edit belongs to the beat it was made on. A take that was re-cut and
    // re-segmented gives the same place in the film a different beat, so the
    // edit is refused here instead of landing on that beat.
    if (beat.key === undefined) {
      throw new PlanError(`analysis/plan.json: beat ${beat.id} has no key in analysis/beats.json; `
        + "run takeone make again to rebuild the plan against this take");
    }
    if (beat.key !== planBeat.key) {
      throw new PlanError(`${where} the edit was made for a different beat `
        + `(key ${planBeat.key}, but ${beat.id} is now ${beat.key}) - the take was re-cut; `
        + `set the key to ${beat.key} to apply the edit to this beat, or remove the edit`);
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
function noShotReason(beat: PlanBeatView): string {
  if (beat.kind === "scroll") return "a scroll beat";
  if (beat.kind === "idle") return "an idle beat";
  return "a pointer-only travel beat";
}

function shotSupported(beat: PlanBeatView): boolean {
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
