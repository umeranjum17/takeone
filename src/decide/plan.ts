// analysis/plan.json: the approved AI plan as the planner made it, in a form the
// user can edit: each beat's camera choices (shot, idle, follow, focus, tightness,
// key moment) and the film's look (theme, pace, opening, camera style, ending,
// title). Only a value the user sets with "by": "user" survives a rerun of make;
// render applies those user values over decisions.jsonl and the film. A field
// this takeone does not plan (merge, per-beat speed, captions) is refused on read,
// never ignored.
//
// Every beat carries a stable key next to its position: a hash of what the beat
// shows, not where it sits (see beats/key.ts). A user edit belongs to that key,
// so a re-cut that re-segments the take keeps the edit on the beat the user
// edited. An edit whose beat is gone from the take is dropped and reported, and
// an edit whose key no longer matches the beat it names is refused, never
// applied to a different beat.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { THEMES } from "../themes.ts";
import { TITLE_MAX, type FilmDecision } from "./film.ts";

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

type Kind = "boolean" | "zone" | "level";
/** The per-beat choices: how each is typed, the decision key it sets, and its top level. */
const BEAT_SPEC = {
  shot: { kind: "boolean", to: "shot" },
  idle: { kind: "boolean", to: "idle" },
  follow: { kind: "boolean", to: "follow" },
  focus_start: { kind: "zone", to: "A" },
  focus_end: { kind: "zone", to: "B" },
  tightness: { kind: "level", to: "L", max: 3 },
  key_moment: { kind: "level", to: "K", max: 2 },
} as const satisfies Record<string, { kind: Kind; to: string; max?: number }>;
export type Field = keyof typeof BEAT_SPEC;
export const FIELDS = Object.keys(BEAT_SPEC) as Field[];
type Value = boolean | string | number;
interface Choice { value?: Value; by: "ai" | "rule" | "user"; why?: string }
/** One beat in the plan: where it sits now, what it is, and the camera choices. */
export type PlanBeat = { id: string; key: string } & { [F in Field]?: Choice };
/** The film choices, each saved under the FilmDecision field it sets. */
const FILM_SPEC = {
  theme: { kind: "theme", to: "theme", asked: "theme" },
  pace: { kind: "number", to: "pace", asked: "pace" },
  opening: { kind: "seconds", to: "establish_s", asked: "opening" },
  camera_style: { kind: "style", to: "camera_path", asked: "camera_style" },
  ending: { kind: "beat", to: "end_beat", asked: "ending" },
  title: { kind: "title", to: "title", asked: "titled" },
} as const;
type FilmField = keyof typeof FILM_SPEC;
const FILM_FIELDS = Object.keys(FILM_SPEC) as FilmField[];
export type PlanFilm = { [F in FilmField]?: Choice };
export interface Plan { version: 2; beats: PlanBeat[]; film?: PlanFilm; dropped?: PlanBeat[] }
/** The choices a decision may carry; undefined means the rules decide. */
type BeatChoices = { beat: string } & { [K in (typeof BEAT_SPEC)[Field]["to"]]?: unknown };
/** The beats a plan is written for: the position and the stable key. */
interface BeatKey { id: string; key?: string }

/** Why a value is wrong for its field, or null. */
function valueError(kind: string, value: unknown, max?: number): string | null {
  if (kind === "boolean") return typeof value === "boolean" ? null : "must be true or false";
  if (kind === "zone") return typeof value === "string" && value !== "" ? null : "must be a zone name";
  if (kind === "level") return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max! ? null : `must be a whole number from 0 to ${max}`;
  if (kind === "number") return typeof value === "number" && value >= 0.25 && value <= 4 ? null : "must be a number from 0.25 to 4";
  if (kind === "seconds") return typeof value === "number" && value >= 0 && value <= 10 ? null : "must be a number of seconds from 0 to 10";
  if (kind === "theme") return typeof value === "string" && value in THEMES ? null : `must be one of ${Object.keys(THEMES).join(", ")}`;
  if (kind === "style") return value === "hold" || value === "solver" ? null : 'must be "hold" or "solver"';
  if (kind === "title") return typeof value === "string" && value !== "" && value.length <= TITLE_MAX ? null : `must be 1 to ${TITLE_MAX} characters`;
  return typeof value === "string" && value !== "" ? null : "must be a beat key";
}

function checkChoice(where: string, choice: unknown, kind: string, max?: number): void {
  const c = choice as Choice | null;
  if (!c || !["ai", "rule", "user"].includes(c.by)) throw new Error(`analysis/plan.json: ${where}.by must be ai, rule or user`);
  const extra = Object.keys(c).filter((k) => !["value", "by", "why"].includes(k));
  if (extra.length > 0) throw new Error(`analysis/plan.json: ${where} has unsupported field ${extra[0]}; a choice holds value, by and why`);
  if (c.why !== undefined && typeof c.why !== "string") throw new Error(`analysis/plan.json: ${where}.why must be text`);
  const bad = c.value === undefined ? null : valueError(kind, c.value, max);
  if (bad) throw new Error(`analysis/plan.json: ${where}.value ${bad}`);
}

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
  const extraTop = Object.keys(plan).filter((k) => !["version", "beats", "film", "dropped"].includes(k));
  if (extraTop.length > 0 && plan.version === 2) throw new Error(`analysis/plan.json: unsupported field ${extraTop[0]}; a plan holds version, beats, film and dropped`);
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
      const unsupported = Object.keys(beat).find((k) => k !== "id" && k !== "key" && !(k in BEAT_SPEC));
      if (unsupported) {
        throw new Error(`analysis/plan.json: beat ${beat.id} has unsupported field ${unsupported}; this takeone plans `
          + `${FIELDS.join(", ")} - remove it`);
      }
      for (const f of FIELDS) {
        if (beat[f] !== undefined) checkChoice(`${beat.id}.${f}`, beat[f], BEAT_SPEC[f].kind, (BEAT_SPEC[f] as { max?: number }).max);
      }
    }
  }
  for (const f of Object.keys(plan.film ?? {})) {
    if (!(f in FILM_SPEC)) throw new Error(`analysis/plan.json: film has unsupported field ${f}; this takeone plans ${FILM_FIELDS.join(", ")} - remove it`);
    checkChoice(`film.${f}`, plan.film![f as FilmField], FILM_SPEC[f as FilmField].kind);
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
export function writePlan(dir: string, decisions: (BeatChoices & { decided_by?: string })[], beats: BeatKey[], film?: FilmDecision): PlanWrite {
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
      const value = d[BEAT_SPEC[f].to] as Value | undefined;
      if (value === undefined) return { by: "rule" };
      // The on/off choices exist only where the planner answered; the rest are
      // filled by the rules whenever a take has no planner answer.
      return BEAT_SPEC[f].kind === "boolean" || d.decided_by === "ai" ? { value, by: "ai" } : { value, by: "rule", why: "no planner answer; the rules decided" };
    };
    return { id: d.beat, key, ...Object.fromEntries(FIELDS.map((f) => [f, choice(f)])) };
  });
  const dropped: PlanBeat[] = [];
  for (const [key, beat] of edits) {
    if (kept.has(key)) continue;
    const entry: PlanBeat = { id: beat.id, key };
    for (const f of FIELDS) if (beat[f] !== undefined) entry[f] = beat[f];
    dropped.push(entry);
  }
  // The film's look: a user edit is kept, the rest is what make decided.
  const filmOut: PlanFilm = {};
  for (const f of FILM_FIELDS) {
    const previous = prior?.film?.[f];
    const { to, asked } = FILM_SPEC[f];
    const value = film?.[to];
    if (previous?.by === "user") filmOut[f] = previous;
    else if (value === undefined) filmOut[f] = { by: "rule" };
    else filmOut[f] = { value: f === "ending" ? keys.get(String(value)) : value, by: film?.by[asked] === "ai" ? "ai" : "rule" };
  }
  writeFileSync(join(dir, "analysis/plan.json"), JSON.stringify({ version: 2, beats: out, film: filmOut, dropped }, null, 1) + "\n");
  return { beats: out, dropped, moved };
}

/** The render's view of a beat, for checking that a user edit can be honoured. */
interface PlanBeatView { id: string; kind: string; key?: string; actions?: unknown[]; zones?: { name: string }[] }

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
      const value = planBeat[field]!.value;
      if (BEAT_SPEC[field].kind === "boolean") {
        if (value !== true) continue; // false matches the render's rule on these beats
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
        continue;
      }
      // Focus, tightness and key moment steer the beat's camera move; with none, they change nothing.
      if (!shotSupported(beat) || planBeat.shot?.by === "user" && planBeat.shot.value === false) {
        throw new PlanError(`${where} ${field} cannot be honoured - this beat gets no camera move `
          + `(${planBeat.shot?.by === "user" && planBeat.shot.value === false ? "shot is set to false" : noShotReason(beat)}); remove the edit`);
      }
      const names = (beat.zones ?? []).map((z) => z.name);
      if (BEAT_SPEC[field].kind === "zone" && !names.includes(value as string)) {
        throw new PlanError(`${where} ${field}=${String(value)} is not a zone of this beat (${names.join(", ")}); `
          + `pick one of those or remove the edit`);
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
    const overrides = Object.fromEntries(FIELDS.flatMap((f) => beat[f]?.by === "user" && beat[f]!.value !== undefined ? [[BEAT_SPEC[f].to, beat[f]!.value]] : []));
    return { ...d, ...overrides };
  });
}

/** What a film edit may not collide with: a choice the user already made another way. */
export interface FilmContext {
  /** The beats of the take; an ending names one by its key. */
  beats?: BeatKey[];
  /** The theme is the user's own (--theme or take.json). */
  ownTheme?: boolean;
  /** Camera keys the user pinned with --set. */
  pinned?: string[];
  /** take.json carries its own title. */
  ownTitle?: boolean;
  /** The take is trimmed by the user, which fixes where the film ends. */
  ownEnd?: boolean;
}

/**
 * The film with the user's plan.json edits applied over the planner's. An edit
 * that another explicit choice (--theme, --set, a title or trim in take.json)
 * would override is refused, never dropped quietly.
 */
export function withUserFilm(film: FilmDecision | undefined, plan: Plan | null, ctx: FilmContext = {}): FilmDecision {
  const out: FilmDecision = { ...film, by: { ...film?.by } };
  const clash = (field: FilmField, other: string) => new PlanError(`analysis/plan.json: film.${field} cannot be honoured - ${other}; remove one of them`);
  for (const f of FILM_FIELDS) {
    const choice = plan?.film?.[f];
    if (choice?.by !== "user" || choice.value === undefined) continue;
    const { to, asked } = FILM_SPEC[f];
    if (f === "theme" && ctx.ownTheme) throw clash(f, "the take already has a theme from --theme or take.json");
    if (f === "title" && ctx.ownTitle) throw clash(f, "take.json has its own title");
    if (f === "ending" && ctx.ownEnd) throw clash(f, "take.json trims the take, which fixes where the film ends");
    if (ctx.pinned?.includes(to)) throw clash(f, `--set ${to} is also given`);
    let value = choice.value;
    if (f === "ending") {
      const beat = ctx.beats?.find((b) => b.key === value);
      if (ctx.beats && !beat) throw new PlanError(`analysis/plan.json: film.ending ${String(value)} is the key of no beat in this take; `
        + `use the key of the beat the film should end on (${ctx.beats.map((b) => `${b.id}=${b.key}`).join(", ")})`);
      if (!beat) continue;
      value = beat.id;
    }
    (out as unknown as Record<string, unknown>)[to] = value;
    out.by[asked] = "user";
  }
  return out;
}
