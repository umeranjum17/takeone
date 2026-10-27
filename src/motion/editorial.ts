// The editorial launch-film recipe: one real screen and a pitch in, the approved editorial structure out.
// The model writes every word and picks every beat's UI (the swapped headline, the phone's opening view and
// tap, the chip stack, the payoff); this module only measures the screen and lays those choices on the
// 120 BPM grid. No engine means no film: there is no local stand-in for the model's choices.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { MemoryCache, type Answer } from "@byokit/decide";
import { KeystoreError } from "@byokit/secrets";
import { SecretStoreUnavailable } from "../secrets.ts";
import { screenLines } from "../decide/ocr.ts";
import { redactText } from "../decide/redact.ts";
import { askChunk, PlannerUnavailable, resolvePlanner } from "../decide/planner.ts";
import { imageSize } from "./ingest.ts";
import { minSceneDuration } from "./storyboard.ts";
import type { Crop, Rect, Scene } from "./types.ts";

export interface EditorialArgs { inputs: string[]; pitch?: string; logo?: string; url?: string; cta?: string; audio?: string; workers?: number }

interface Line { id: string; text: string; box: Rect }

/** What the model must return, beside its yes: every field is checked before a frame is planned. */
const FIELDS = ["logo", "lead", "swaps", "phone_line", "phone_open", "tap", "toast", "chips_line", "chips", "payoff", "cta"] as const;

const ASK = "Plan an editorial launch film for this product from its pitch and the text lines read off one real screen. "
  + "Answer yes and give every field: "
  + "logo: the product name as its wordmark (at most 24 characters); "
  + "lead: the first words of a two-line serif hook (2 to 6 words, no final word); "
  + "swaps: 2 or 3 endings of one or two words that finish the hook in turn, each struck out for the next, the last one the true promise (each at most 14 characters, may end in a full stop); "
  + "phone_line: 2 to 5 words set beside the product shown on a phone; "
  + "phone_open: the id of the line the phone opens on, near the top of what the product does; "
  + "tap: the id of a button, row or control the viewer sees pressed on the phone, below or near phone_open; "
  + "toast: the 2 to 4 word confirmation that springs in after the tap; "
  + "chips_line: 2 to 5 words set beside a stack of the product's own features; "
  + "chips: 4 to 7 line ids, in play order, whose words are the product's features, states or items and read whole on their own, like a label, button, status or item title (never a line marked wraps or any other part of a wrapped sentence, not navigation chrome, not times); "
  + "payoff: the closing line, 2 to 6 words; "
  + "cta: the call to action on the end card, 1 to 3 words. "
  + "Write plain words from the pitch; never invent a feature the pitch or the screen does not show.";

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Mirrors phone-story in editorial.js: the whole phone's screen width at 1080p, and the lens that lifts the tapped row
 *  out at reading size (its text this share of the frame's short side, no wider than this share of a 16:9 frame). */
export const PHONE_SCREEN_W = 1080 * 0.86 * 0.47 * 0.92;
export const LENS_TEXT = 0.04;
export const LENS_W = 0.44;
const grid = (s: number) => Math.ceil(s * 2 - 1e-9) / 2; // every cut on the 0.5 s beat of 120 BPM

/** The text lines worth offering: readable size, real words, at most 60 from the top. */
export function candidateLines(lines: { text: string; box: number[] }[], height: number): Line[] {
  return lines.filter(l => l.box[3]! >= height * 0.006 && l.box[3]! <= height * 0.08 && /[A-Za-z]{3}/.test(l.text))
    .slice(0, 60).map((l, i) => ({ id: `L${i + 1}`, text: l.text, box: l.box as Rect }));
}

function text(a: Record<string, unknown>, k: string, lo: number, hi: number, chars = 60): string {
  const v = a[k];
  if (typeof v !== "string" || !v.trim() || v.length > chars || words(v) < lo || words(v) > hi) {
    throw new Error(`editorial planner: ${k} must be ${lo}-${hi} words in at most ${chars} characters, got ${JSON.stringify(v)}; rerun to ask again`);
  }
  return v.trim();
}

function line(a: Record<string, unknown>, k: string, lines: Line[]): Line {
  const hit = lines.find(l => l.id === a[k]);
  if (!hit) throw new Error(`editorial planner: ${k} names no offered line (${JSON.stringify(a[k])}); rerun to ask again`);
  return hit;
}

/** Room above and below a line before its neighbours: its own background, never more than half the gap to the next line. */
function margins(l: Line, lines: Line[]): [number, number] {
  const [x, y, w, h] = l.box;
  const beside = lines.filter(n => n !== l && n.box[0] < x + w && n.box[0] + n.box[2] > x);
  return [Math.min(h * 0.55, ...beside.filter(n => n.box[1] + n.box[3] <= y).map(n => (y - n.box[1] - n.box[3]) / 2)),
    Math.min(h * 0.55, ...beside.filter(n => n.box[1] >= y + h).map(n => (n.box[1] - y - h) / 2))];
}

/** A crop of the screen clamped to it, in device px. */
function clamp(x: number, y: number, w: number, h: number, W: number, H: number): Rect {
  w = Math.min(w, W); h = Math.min(h, H);
  return [Math.round(Math.max(0, Math.min(x, W - w))), Math.round(Math.max(0, Math.min(y, H - h))), Math.round(w), Math.round(h)];
}

/** The screen in 8-bit grey, one byte per device px, for trimming chips to plain background. */
export interface Grey { w: number; px: Uint8Array }
export function screenGrey(file: string, size: { width: number; height: number }): Grey {
  return { w: size.width, px: new Uint8Array(execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-i", file, "-vf", "format=gray", "-f", "rawvideo", "-"],
    { maxBuffer: size.width * size.height + 1024, timeout: 60000 })) };
}

/** Pull each padded edge of a chip in to the first row or column of plain background, so no sliver of an
 *  unread neighbour (white-on-dark text OCR misses, a panel's border or rounded corner) rides along. Rows-first and
 *  columns-first can disagree; the larger clean chip wins. Edges never pass the line's own box. */
function trim(rect: Rect, box: Rect, g: Grey): Rect {
  const [bl, bt, br, bb] = [box[0], box[1], box[0] + box[2] - 1, box[1] + box[3] - 1];
  // The line's background is the commonest grey inside its own box (text is the minority of a line's pixels).
  const hist = new Array<number>(256).fill(0);
  for (let j = bt; j <= bb; j++) for (let i = bl; i <= br; i++) hist[g.px[j * g.w + i]!]!++;
  const bg = hist.indexOf(Math.max(...hist));
  const quiet = (x0: number, y0: number, x1: number, y1: number) => {
    for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) if (Math.abs(g.px[j * g.w + i]! - bg) > 16) return false;
    return true;
  };
  const pull = (colsFirst: boolean): Rect => {
    let [l, t, r, b] = [rect[0], rect[1], rect[0] + rect[2] - 1, rect[1] + rect[3] - 1];
    const rows = () => { while (t < bt && !quiet(l, t, r, t)) t++; while (b > bb && !quiet(l, b, r, b)) b--; };
    const cols = () => { while (l < bl && !quiet(l, t, l, b)) l++; while (r > br && !quiet(r, t, r, b)) r--; };
    if (colsFirst) { cols(); rows(); cols(); } else { rows(); cols(); rows(); }
    return [l, t, r - l + 1, b - t + 1];
  };
  const a = pull(false), c = pull(true);
  return a[2] * a[3] >= c[2] * c[3] ? a : c;
}

/** A long line whose sentence runs on into the line just below it, in the same column at the same size. */
function wraps(l: Line, lines: Line[], W: number): boolean {
  const [x, y, w, h] = l.box;
  return w > W * 0.35 && lines.some(n => n.box[1] > y + h * 0.5 && n.box[1] - y - h < h * 0.8 && Math.abs(n.box[0] - x) < h * 1.5 && Math.abs(n.box[3] - h) < h * 0.25);
}

/** The storyboard for checked answers. Pure: the same answers on the same screen give the same film. */
export function editorialStoryboard(a: EditorialArgs, id: string, size: { width: number; height: number }, lines: Line[], answer: Record<string, unknown>, grey?: Grey): unknown {
  const swaps = answer["swaps"];
  if (!Array.isArray(swaps) || swaps.length < 2 || swaps.length > 3 || swaps.some(s => typeof s !== "string" || !s.trim() || s.length > 14 || words(s) > 2)) {
    throw new Error(`editorial planner: swaps must be 2 or 3 endings of one or two words, got ${JSON.stringify(swaps)}; rerun to ask again`);
  }
  const chipIds = answer["chips"];
  if (!Array.isArray(chipIds) || chipIds.length < 4 || chipIds.length > 7 || new Set(chipIds).size !== chipIds.length) {
    throw new Error(`editorial planner: chips must be 4 to 7 distinct line ids, got ${JSON.stringify(chipIds)}; rerun to ask again`);
  }
  const { width: W, height: H } = size;
  const crops: Record<string, Crop> = {};
  // Chips are the screen's own pixels: each line with a margin of its own background around it, never more
  // than half the gap to the line above or below, so no neighbour's ascenders or descenders ride along.
  const chips = chipIds.map((cid, i) => {
    const l = line({ c: cid }, "c", lines), [x, y, w, h] = l.box, [above, below] = margins(l, lines);
    const rect = clamp(x - h * 0.8, y - above, w + h * 1.6, h + above + below, W, H);
    crops[`chip${i + 1}`] = { screen: "S1", rect: grey ? trim(rect, l.box, grey) : rect, exact: true };
    return `chip${i + 1}`;
  });
  // The phone shows a phone-shaped window around the tap, wide enough that its text lands near 30 px at 1080p
  // (never magnified past 1.6x), opening a little above phone_open and tall enough to pan down to the tap.
  const open = line(answer, "phone_open", lines), tap = line(answer, "tap", lines);
  const textH = Math.min(open.box[3], tap.box[3]);
  const scale = Math.min(1.6, Math.max(0.6, 30 / textH)), pw = PHONE_SCREEN_W;
  const cw = Math.max(pw / scale, tap.box[2] + textH * 2);
  const top = Math.min(open.box[1], tap.box[1]) - textH * 3;
  const ch = Math.max(cw * 2.6, tap.box[1] + tap.box[3] - top + textH * 6);
  // A portrait screen is already a phone's: it fills the phone at its own width and pans down to the tap.
  crops["phone"] = { screen: "S1", rect: H >= W ? [0, 0, W, H] : clamp(tap.box[0] + tap.box[2] / 2 - cw / 2, top, cw, ch, W, H) };
  // The lens: the tapped line, with the lines beside it on its row when they still fit at reading size.
  const lensW = (w: number) => (w + tap.box[3] * 1.6) * (LENS_TEXT * 1080) / tap.box[3];
  const gap = (n: Line) => Math.max(n.box[0] - tap.box[0] - tap.box[2], tap.box[0] - n.box[0] - n.box[2]);
  const row = lines.filter(n => n === tap || (Math.abs(n.box[1] + n.box[3] / 2 - (tap.box[1] + tap.box[3] / 2)) < tap.box[3] * 0.5
    && Math.abs(n.box[3] - tap.box[3]) < tap.box[3] * 0.3 && gap(n) < tap.box[3] * 2));
  const x0 = Math.min(...row.map(n => n.box[0])), x1 = Math.max(...row.map(n => n.box[0] + n.box[2]));
  const [lx, lw] = lensW(x1 - x0) <= LENS_W * 1920 ? [x0, x1 - x0] : [tap.box[0], tap.box[2]];
  if (lensW(lw) > LENS_W * 1920) {
    throw new Error(`editorial planner: tap names a line too long to read in the phone's lens (${JSON.stringify(tap.text)}); name a shorter button, row or control; rerun to ask again`);
  }
  const [above, below] = margins(tap, lines);
  const lensRect = clamp(lx - tap.box[3] * 0.8, tap.box[1] - above, lw + tap.box[3] * 1.6, tap.box[3] + above + below, W, H);
  crops["lens"] = { screen: "S1", rect: grey ? trim(lensRect, [lx, tap.box[1], lw, tap.box[3]], grey) : lensRect, exact: true };

  const logo = a.logo ?? text(answer, "logo", 1, 4, 24);
  const fit = (s: Scene, floor: number): Scene => ({ ...s, d: grid(Math.max(floor, minSceneDuration(s))) });
  const scenes: Scene[] = [
    fit({ pattern: "word-swap", d: 0, title: text(answer, "lead", 2, 6), swaps: swaps.map(s => s.trim()), cut: true }, 3),
    fit({ pattern: "phone-story", d: 0, title: text(answer, "phone_line", 2, 5), screen: "phone", tap: tap.box, lens: "lens", text: text(answer, "toast", 2, 4, 32), invert: true, cut: true }, 5),
    fit({ pattern: "chip-stack", d: 0, title: text(answer, "chips_line", 2, 5), chips, cut: true }, 1.5 + 0.5 * chips.length),
  ];
  // Canon: the three beats again at once, each tile on its own clock, the way the reference recaps.
  const at = (i: number) => scenes.slice(0, i).reduce((n, s) => n + s.d, 0);
  scenes.push({ pattern: "canon", d: 4, offsets: [at(0) + 0.5, at(1) + 0.5, at(2) + 1, at(1) + 2.5], cut: true });
  scenes.push(fit({ pattern: "statement", d: 0, title: text(answer, "payoff", 2, 6), invert: true, cut: true }, 2.5));
  scenes.push(fit({ pattern: "end-card", d: 0, logo, cta: a.cta ?? text(answer, "cta", 1, 3, 24), ...(a.url ? { url: a.url } : {}), cut: true }, 3.5));
  return {
    version: 1, id,
    output: { ...(a.workers !== undefined ? { workers: a.workers } : {}) },
    theme: { name: "editorial", overrides: {} },
    tempo: { bpm: 120, phase_s: 0, snap: "beat" },
    source: { kind: "image", files: [resolve(a.inputs[0]!)] },
    screens: Object.create(null), regions: [], crops,
    ...(a.audio ? { audio: { file: resolve(a.audio), volume: 0.6 } } : {}),
    layout: { kind: "single" }, scenes,
    planner: { by: "ai", abstained: [] },
  };
}

/** No signed-in engine: the recipe stops with the sign-in line rather than film a stand-in plan. */
const noEngine = (reason: string) => new PlannerUnavailable("signed-in account or stored key", reason, { credentialMissing: true });

/** Read the screen, ask the signed-in engine once, and plan the film. Stops when no engine can answer. */
export async function planEditorial(a: EditorialArgs, id: string, log: (line: string) => void): Promise<unknown> {
  if (a.inputs.length !== 1 || !/\.(png|jpe?g|webp)$/i.test(a.inputs[0]!)) throw new Error("--recipe editorial takes exactly one screenshot (png, jpg or webp)");
  if (!a.pitch?.trim()) throw new Error("--recipe editorial needs --pitch \"what the product does, in a few lines\"");
  let planner;
  try { planner = await resolvePlanner(); } catch (e) {
    // An unreadable secret store means no stored key: discovery found no sign-in either.
    if (e instanceof SecretStoreUnavailable || (e instanceof KeystoreError && ["unavailable", "unsupported"].includes(e.code))) throw noEngine("no sign-in found and the secret store cannot be read");
    throw e;
  }
  if (!planner.active) throw noEngine(planner.refusal ?? `${planner.label} is not signed in`);
  const file = resolve(a.inputs[0]!), size = imageSize(file);
  const lines = candidateLines(await screenLines(file), size.height);
  if (lines.length < 6) throw new Error(`editorial: read only ${lines.length} text lines off ${a.inputs[0]}; the recipe needs a screen with real UI text`);
  log(`motion: editorial recipe planned by ${planner.label} from ${lines.length} redacted screen lines`);
  // Only redacted words leave the machine, the same rule as make's screen text; the screenshot never does.
  const state = {
    pitch: a.pitch.trim(), ...(a.logo ? { product: a.logo } : {}),
    screen: { width: size.width, height: size.height },
    lines: lines.map(l => ({ id: l.id, box: l.box, words: redactText(l.text), ...(wraps(l, lines, size.width) ? { wraps: true } : {}) })),
  };
  const grey = screenGrey(file, size);
  // A broken field is asked again once, with the model's own answer and what it broke; a second miss stops.
  for (let retry: Record<string, unknown> | undefined, attempt = 0; ; attempt++) {
    const outcome = await askChunk(retry ? { ...state, retry } : state, { film: { kind: "yesno", question: ASK, answerFields: [...FIELDS] } }, planner, new MemoryCache(),
      { timeoutMs: 180_000, keepAnswers: true });
    const answer: Answer | undefined = outcome.answers?.["film"];
    if (!answer || answer.abstained || answer.answer !== true) {
      throw new Error(`editorial planner gave no plan (${outcome.failure ?? answer?.reason ?? "no answer"}); rerun to ask again`);
    }
    try {
      return editorialStoryboard(a, id, size, lines, answer as unknown as Record<string, unknown>, grey);
    } catch (e) {
      if (attempt > 0 || !(e instanceof Error) || !e.message.startsWith("editorial planner:")) throw e;
      log(`motion: ${e.message.replace(/; rerun to ask again$/, "")}; asking again`);
      retry = { previous_answer: answer, problem: e.message.replace(/^editorial planner: |; rerun to ask again$/g, "") };
    }
  }
}
