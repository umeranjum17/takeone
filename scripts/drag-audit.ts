#!/usr/bin/env node
// Drag visibility audit of a rendered headless board take: every output frame that shows the drag
// keeps the cursor and the whole dragged card in view, through any trim or cut across the gesture.
// usage: node scripts/drag-audit.ts <rendered-take-dir> [--boxes <text-boxes.json>] [--set key=value]...
// The drag is the take's own button down and up (events.jsonl), never the pipeline's edited beats, so a
// drag an edit drops still counts. The card is the scene's own DOM text boxes (text-boxes.json) that moved
// with the pointer; --boxes names the capture's file when the rendered copy leaves it out, since render
// refuses a portrait crop of a take carrying it on its safe-area gate. Pass the render's own --set pairs.
// A wide export is judged on the camera frame, the crop inside the stage margin, so stricter than the
// film; a crop-to-fill export on the window render shows (sourceViewport through the take's stage).
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { actionCameraMilliseconds } from "../src/beats/clock.ts";
import { resolveCamera } from "../src/cli.ts";
import { editTimeline } from "../src/render/edits.ts";
import { idleSqueezes, purposefulEnd, warp } from "../src/render/pace.ts";
import { sourceViewport, stageGeometry } from "../src/render/stage.ts";
import { contains } from "./check-framing.ts";
import type { Beat, CameraFrame, TakeMeta } from "../src/camera/types.ts";
import type { Event } from "../src/types.ts";

type Box = [number, number, number, number, string];
export interface DragAudit {
  take: string;
  /** Source seconds of the button down and up. */
  drag: [number, number];
  card: string[];
  /** Output frames that show the drag, and how many lose the cursor or any card box. */
  frames: number;
  cursorLost: number;
  cardLost: number;
  /** Output seconds of the first and last frame that show the drag, then the first frames lost. */
  shown: [number, number] | null;
  lost: { t: number; source: number; cursor: boolean; card: boolean }[];
}

export function auditDrag(dir: string, pairs: string[] = [], boxesFile = join(dir, "text-boxes.json")): DragAudit {
  const read = (file: string) => JSON.parse(readFileSync(join(dir, file), "utf8"));
  const meta = read("take.json") as TakeMeta & { stream?: unknown; scale?: number };
  const d = resolveCamera(dir, pairs);
  const beats = read("analysis/beats.json") as Beat[];
  if ("stream" in meta) for (const b of beats) b.actions = b.actions.map(actionCameraMilliseconds);
  // The render's own output clock: its edit clock with cuts or speed, else the idle-squeezed one.
  const start = meta.trim_start ?? 0, end = meta.trim_end ?? purposefulEnd(beats, start,
    meta.duration ?? Math.max(0, ...beats.map((beat) => beat.t1)), d);
  if (meta.speed?.some(s => s.kind === "type_speed")) throw new Error(`${dir}: drag-audit does not model speed type_speed`);
  const clock = meta.cuts?.length || meta.speed?.length ? editTimeline(meta, beats, start, end, d) : undefined;
  const squeezes = idleSqueezes(beats, start, end, d);
  const outTime = clock?.at ?? ((t: number) => warp(t - start, squeezes, d.idle_speed));
  const sourceAt = (t: number) => {
    let lo = start, hi = end;
    for (let k = 0; k < 50; k++) { const mid = (lo + hi) / 2; if (outTime(mid) < t) lo = mid; else hi = mid; }
    return hi;
  };
  const stage = stageGeometry(meta.width, meta.height, d);
  const frames = (read("camera.json") as CameraFrame[])
    .map(f => d.out_h > d.out_w ? sourceViewport(f, meta.width, meta.height, stage, d) : f);
  if (!(Math.abs(outTime(end) - frames.at(-1)!.t) <= 1 / d.fps)) throw new Error(`${dir}: end ${end} s gives `
    + `${outTime(end)} s of output, but camera.json runs ${frames.at(-1)!.t} s`);

  // The drag: the first left press released more than 100 px from where it went down.
  const events = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l) as Event);
  const ptr = events.filter((e): e is Extract<Event, { k: "ptr" }> => e.k === "ptr");
  const pointerAt = (ms: number): [number, number] => {
    let p = ptr[0]!;
    for (const e of ptr) { if (e.t > ms) break; p = e; }
    return [p.x, p.y];
  };
  const btn = events.filter((e): e is Extract<Event, { k: "btn" }> => e.k === "btn");
  const press = btn.findIndex((e, i) => e.down && btn[i + 1] && !btn[i + 1]!.down
    && Math.hypot(...pointerAt(e.t).map((v, k) => v - pointerAt(btn[i + 1]!.t)[k]!) as [number, number]) > 100);
  if (press < 0) throw new Error(`${dir}: no drag in events.jsonl`);
  const [t0, t1] = [btn[press]!.t / 1000, btn[press + 1]!.t / 1000];

  // The card: the labels at the grab that moved with the pointer to the last held frame (the release
  // frame already shows the card re-laid in its column). While held, a label's moved copy is the one
  // nearest the pointer.
  const samples = JSON.parse(readFileSync(boxesFile, "utf8")).samples as { t: number; boxes: Box[] }[];
  const boxesAt = (t: number) => { let s = samples[0]!; for (const x of samples) { if (x.t > t + 1e-9) break; s = x; } return s.boxes; };
  const held = t1 - 1 / 60, [g0, g1] = [pointerAt(t0 * 1000), pointerAt(held * 1000)];
  const card = new Set(boxesAt(t0).filter(b => boxesAt(held).some(c => c[4] === b[4]
    && Math.hypot(c[0] - b[0] - (g1[0] - g0[0]), c[1] - b[1] - (g1[1] - g0[1])) < 100)).map(b => b[4]));
  if (!card.size) throw new Error(`${dir}: no dragged card labels found`);
  const cardAt = (t: number) => {
    const [px, py] = pointerAt(t * 1000), nearest = new Map<string, Box>();
    const dist = (b: Box) => Math.hypot(b[0] + b[2] / 2 - px, b[1] + b[3] / 2 - py);
    for (const b of boxesAt(t)) if (card.has(b[4]) && (!nearest.has(b[4]) || dist(b) < dist(nearest.get(b[4])!))) nearest.set(b[4], b);
    return [...nearest.values()];
  };

  const scale = meta.scale ?? 1;
  const audit: DragAudit = { take: basename(dir), drag: [t0, t1], card: [...card], frames: 0, cursorLost: 0, cardLost: 0, shown: null, lost: [] };
  for (const f of frames) {
    const s = sourceAt(f.t);
    if (s < t0 || s > t1 || !(clock?.contains(s) ?? true)) continue;
    audit.frames++;
    audit.shown = [audit.shown?.[0] ?? f.t, f.t];
    // The painted arrow is 24x32 CSS px from its hotspot; keep a few px of ink margin.
    const [x, y] = pointerAt(s * 1000);
    const cursor = !contains(f, [x - 4 * scale, y - 4 * scale, 28 * scale, 36 * scale]);
    const object = cardAt(s).some(b => !contains(f, b.slice(0, 4) as number[]));
    audit.cursorLost += Number(cursor);
    audit.cardLost += Number(object);
    if ((cursor || object) && audit.lost.length < 5) audit.lost.push({ t: f.t, source: s, cursor, card: object });
  }
  return audit;
}

export function report(a: DragAudit): string {
  const lost = a.lost.map(l => `\n  lost at ${l.t.toFixed(3)} s (source ${l.source.toFixed(3)} s):${l.cursor ? " cursor" : ""}${l.card ? " card" : ""}`).join("");
  return `${a.take}: drag ${a.drag.map(t => t.toFixed(3)).join("-")} s source, card [${a.card.join(" | ")}]; `
    + `${a.frames} frames show it${a.shown ? ` (output ${a.shown.map(t => t.toFixed(3)).join("-")} s)` : ""}; `
    + `cursor out of view in ${a.cursorLost} of ${a.frames} frames, card out of view in ${a.cardLost} of ${a.frames} frames: `
    + `${a.frames && !a.cursorLost && !a.cardLost ? "PASS" : "FAIL"}${lost}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, ...rest] = process.argv.slice(2);
  const pairs: string[] = [];
  let boxes: string | undefined;
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] === "--set" && rest[i + 1]) pairs.push(rest[i + 1]!);
    else if (rest[i] === "--boxes" && rest[i + 1]) boxes = rest[i + 1];
    else throw new Error(`unknown option ${rest[i]}`);
  }
  if (!dir) throw new Error("usage: node scripts/drag-audit.ts <rendered-take-dir> [--boxes <text-boxes.json>] [--set key=value]...");
  const audit = auditDrag(dir, pairs, boxes);
  console.log(report(audit));
  process.exitCode = audit.frames && !audit.cursorLost && !audit.cardLost ? 0 : 1;
}
