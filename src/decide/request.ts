// Jev request building, token estimation and the 1,200-token per-request cap.
// Pure functions over plain data: no Node imports.

import type { Beat, Decision } from "../types.ts";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
export const PRICE_PER_MTOK = 0.042;
export const REQUEST_TOKEN_CAP = 1200;
export const CHARS_PER_TOKEN = 3.5;

export interface RequestCtx {
  /** optional demo topic from --about */
  about?: string;
  /** description of the shot the viewer is looking at when the beat starts */
  currentShot: string;
  /** the next beat, for what_happened lookahead */
  nextBeat?: Beat;
}

export interface JevRequest {
  model: string;
  state: {
    demo_topic?: string;
    current_shot: string;
    beat: { length: string; what_happened: string; next_beat: string };
    zones: Record<string, { shows: string; size: string; where: string; activity: string; text?: string }>;
  };
  questions: Record<string, unknown>;
}

export function estimateTokens(body: string): number {
  return Math.ceil(body.length / CHARS_PER_TOKEN);
}

/** Words describing what happened in a beat, from its actions and zones. Digit-free. */
export function whatHappened(beat: Beat): string {
  const parts: string[] = [];
  for (const a of beat.actions.slice(0, 3)) {
    switch (a.k) {
      case "click":
        parts.push(a.double ? "The user double-clicked a control" : "The user clicked a control");
        break;
      case "type":
        parts.push("The user typed text");
        break;
      case "drag":
        parts.push("The user dragged a control");
        break;
      case "scroll":
        parts.push("The user scrolled the view");
        break;
      case "shortcut":
        parts.push(`The user pressed the ${a.combo} shortcut`);
        break;
      case "dwell":
        parts.push("The user pointed at a control");
        break;
      case "travel":
        parts.push("The user moved the pointer across the screen");
        break;
      case "focus":
        parts.push("A different window came into focus");
        break;
      case "cut":
        parts.push("The screen changed at once");
        break;
    }
  }
  if (parts.length === 0) parts.push("Nothing happened; the screen was idle");
  let s = parts.join(", then ") + ".";
  const res = beat.zones.find((z) => z.kind === "res");
  if (res) {
    const adj = res.desc.size.split(",")[0]!; // "medium", "small", ...
    s += ` Then a ${adj} region appeared ${res.desc.where === "center" ? "in the center" : `at the ${res.desc.where}`}.`;
  }
  return s;
}

function truncateZonesToCap(state: JevRequest["state"], askKeyMoment: boolean): string {
  let body = JSON.stringify({ model: JEV_MODEL, state, questions: defaultQuestions(state, askKeyMoment) });
  // drop optional text fields first, then shorten them word by word, until under the cap
  for (const z of Object.values(state.zones)) {
    if (z.text) {
      const words = z.text.split(" ");
      while (words.length > 0 && estimateTokens(body) > REQUEST_TOKEN_CAP) {
        words.pop();
        z.text = words.join(" ");
        body = JSON.stringify({ model: JEV_MODEL, state, questions: defaultQuestions(state, askKeyMoment) });
      }
      if (estimateTokens(body) > REQUEST_TOKEN_CAP) {
        delete z.text;
        body = JSON.stringify({ model: JEV_MODEL, state, questions: defaultQuestions(state, askKeyMoment) });
      }
    }
  }
  return body;
}

function defaultQuestions(state: JevRequest["state"], askKeyMoment: boolean): Record<string, unknown> {
  const zoneNames = Object.fromEntries(Object.keys(state.zones).map((n) => [n, null]));
  const q: Record<string, unknown> = {
    focus_start: {
      type: "choice",
      instructions:
        "At the START of `beat`, which zone should the viewer be looking at to see the action the user takes? Pick the zone where the user's action happens.",
      criteria: zoneNames,
    },
    focus_end: {
      type: "choice",
      instructions:
        "At the END of `beat`, which zone should the viewer be looking at to understand the result of the action? Pick the zone that shows what changed because of the action; pick the same zone as the action if nothing else changed.",
      criteria: zoneNames,
    },
    tightness: {
      type: "score",
      instructions:
        "How closely should the camera frame the zone the viewer should look at, so a viewer on a laptop screen can follow this beat?",
      criteria: [
        "Show the entire screen; the beat is about the overall layout or a big change",
        "Show the surrounding window or area; the context matters as much as the detail",
        "Frame the zone with some room around it; the detail matters and the surroundings help",
        "Frame the zone tightly; small text or a small control is the whole point",
      ],
    },
    new_subject: {
      type: "noul",
      instructions:
        "The viewer's attention must move to a different part of the screen than `current_shot` shows during this beat.",
      criteria: {
        true: "What matters in this beat is outside or much smaller than the current shot",
        false: "What matters in this beat is already comfortably visible in the current shot",
      },
    },
  };
  if (askKeyMoment) {
    q["key_moment"] = {
      type: "score",
      instructions: "How important is this beat to the story of `demo_topic`?",
      criteria: [
        "Routine: navigation or setup a viewer can skim",
        "Useful: a normal step of the workflow",
        "Key moment: the payoff or the step the demo exists to show",
      ],
    };
  }
  return q;
}

/** Build the exact request body for one beat (compact JSON), capped at 1,200 estimated tokens. */
export function buildRequest(beat: Beat, ctx: RequestCtx, askKeyMoment: boolean): { body: string; tokens: number } {
  const zones: JevRequest["state"]["zones"] = {};
  for (const z of beat.zones) {
    zones[z.name] = {
      shows: z.desc.shows,
      size: z.desc.size,
      where: z.desc.where,
      activity: z.desc.activity,
      ...(z.desc.text ? { text: z.desc.text } : {}),
    };
  }
  const state: JevRequest["state"] = {
    ...(ctx.about ? { demo_topic: ctx.about } : {}),
    current_shot: ctx.currentShot,
    beat: {
      length: `${((beat.t1 - beat.t0) / 1000).toFixed(1)} seconds`,
      what_happened: whatHappened(beat),
      next_beat: ctx.nextBeat ? whatHappened(ctx.nextBeat) : "The take ends after this beat.",
    },
    zones,
  };
  const body = truncateZonesToCap(state, askKeyMoment);
  const tokens = estimateTokens(body);
  if (tokens > REQUEST_TOKEN_CAP) throw new Error(`request exceeds ${REQUEST_TOKEN_CAP} estimated tokens`);
  return { body, tokens };
}

/** Pre-flight estimate across all beats. Returns null when within budget. */
export function planTokens(
  beats: Beat[],
  ctxs: RequestCtx[],
  askKeyMoment: boolean,
): { tokens: number; usd: number } {
  let tokens = 0;
  for (let i = 0; i < beats.length; i++) {
    tokens += buildRequest(beats[i]!, ctxs[i]!, askKeyMoment).tokens;
  }
  return { tokens, usd: (tokens * PRICE_PER_MTOK) / 1e6 };
}

export type { Decision };
