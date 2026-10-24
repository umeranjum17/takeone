import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveTheme } from "../themes.ts";
import { basename, join, resolve } from "node:path";
import type { CameraDefaults } from "../camera/defaults.ts";
import type { Event } from "../types.ts";
import { actionCameraMilliseconds } from "../beats/clock.ts";
import { applyManualZooms, baseWidth, manualZoomLimitWarning, solveCamera, type EdgeCuts } from "../camera/solver.ts";
import { applyDragVisibility } from "../camera/gesture.ts";
import { sweepCuts } from "../camera/sweep.ts";
import type { Beat, CameraFrame, Decision, TakeMeta } from "../camera/types.ts";
import type { FrameRegions } from "../types.ts";
import { blurGraph, keycapAss, keycapBackdropGraph, keycapMaskAss, keycapObstacles, overlayRegions, spotlightAss, spotlightGraph } from "./overlays.ts";
import { motionBlurGraph, shutterPlan } from "./motion-blur.ts";
import { idleSqueezes, purposefulEnd, setptsExpr, warp, warpBeats } from "./pace.ts";
import { cursorAss, pointerSamples } from "./cursor.ts";
import { firstFrameTimeMs, readEvents } from "../perceive/decode.ts";
import { phoneTapShots } from "./phone.ts";
import { edgeCuts, cutCount, holdPath, lastFrameSecond, videoFrames } from "./framing.ts";
import { SAFE_INSET, safeAreaReport, type Rect } from "./safe-area.ts";
import { clipDrags, typingBursts, editBeats, editTimeline, validateEdits, validateZooms } from "./edits.ts";
import { applyPlan, readPlan, validatePlan } from "../decide/plan.ts";
import { withFilmText } from "../decide/film.ts";
import { runFfmpeg } from "./ffmpeg.ts";
import { ensureProxy, previewDefaults, proxySize, scaleBand, scaleBeat, scaleEvent, scaleFrames, scaleMeta, type PreviewSpec } from "./preview.ts";
import {
  bandCamera, bandFrames, bandLayout, bandText, beatClicks, captionAss, captionLayouts, cardFilter, clickAss, insideScreen, measureAss, sourceViewport, stageFrames, stageGeometry, stageImageFilter,
  takeCaptions, type Band, type Caption, type CaptionInk,
} from "./stage.ts";

/** Text-friendly production encoder settings, also exercised by the output gate. */
export function encodingOptions(d: CameraDefaults): string[] {
  return ["-c:v", "libx264", "-crf", String({ draft: 23, standard: 12, master: 12 }[d.quality]),
    "-preset", d.preset, "-pix_fmt", d.quality === "master" ? "yuv444p" : "yuv420p",
    ...(d.quality === "draft" ? [] : ["-tune", "animation"])];
}

/** Event-clock time of the first video frame. */
function videoStartMs(dir: string, meta: TakeMeta): number {
  try {
    return firstFrameTimeMs(join(dir, "frames.tsv"), { offset_ms: meta.offset_ms } as Parameters<typeof firstFrameTimeMs>[1]);
  } catch {
    // frames.tsv missing or malformed: fall back to the saved offset.
    return meta.offset_ms ?? 0;
  }
}

/** Typing bursts from the take's saved key events, on the video clock. */
async function takeTypingBursts(dir: string, meta: TakeMeta): Promise<{ t0: number; t1: number }[]> {
  const eventsPath = join(dir, "events.jsonl");
  if (!existsSync(eventsPath)) return [];
  return typingBursts(await readEvents(eventsPath), videoStartMs(dir, meta));
}

/** Perception's changed regions (analysis/regions.json) on the edit clock, skipping cuts. */
async function takeChanges(dir: string, meta: TakeMeta, start: number, end: number,
  outTime: (t: number) => number, kept: (t: number) => boolean): Promise<{ t: number; bbox: [number, number, number, number] }[]> {
  const path = join(dir, "analysis/regions.json");
  if (!existsSync(path)) return [];
  const origin = videoStartMs(dir, meta);
  const { frames } = JSON.parse(await readFile(path, "utf8")) as { frames: FrameRegions[] };
  return frames.flatMap(f => {
    const t = (f.t - origin) / 1000;
    return f.cut || t < start || t > end || !kept(t) ? [] : f.regions.map(r => ({ t: start + outTime(t), bbox: r.bbox }));
  });
}

/** One no-cut-text edge check per target, from the frames its hold shows: the arrival, the
 * midpoint and the hold end, unioned. The solver runs its whole-element search against this, so
 * every camera path (targets, holds, reveals and the shortcut/search push-ins) rejects any crop
 * whose visible edges cut a word or control, instead of relying on each beat's planner boxes. The
 * predicate is the acceptance check's own: no guard band, one dense text stretch per cut word
 * (see cutCount). `at` maps a solver time to a source second; each hold's mask is reused across
 * its search. Returns undefined with no source. `strict` (an audit) fails where no frame decodes,
 * instead of reading the view as clean. */
export function sourceEdgeCuts(dir: string, meta: TakeMeta, at: (t: number) => number, strict = false): EdgeCuts | undefined {
  const file = join(dir, "screen.webm");
  if (!existsSync(file)) return undefined;
  const { width: W, height: H } = meta;
  const cache = new Map<string, ReturnType<typeof edgeCuts>>();
  // Decoded source seconds, shared across every guard window of this solve.
  // Materialize, the release search and the guard loop re-ask the same seconds
  // under different window keys; each miss below used to re-spawn ffmpeg for them.
  // A frame is W*H bytes against ~5x that per mask, so these stay cached for the solve.
  const decoded = new Map<string, Uint8Array>();
  let warnedDecodes = false;
  // A variable-rate recording writes no frame after its last change: sample its last frame instead.
  const lastSecond = lastFrameSecond(file);
  const frameAt = (time: number): Uint8Array | undefined => {
    const second = Math.max(0, Math.min(at(time), lastSecond - 0.001)).toFixed(3);
    let frame = decoded.get(second);
    if (frame) return frame;
    try {
      const raw = execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-ss", second,
        "-i", file, "-frames:v", "1", "-vf", "format=gray", "-f", "rawvideo", "-"],
        { maxBuffer: W * H + 4096, timeout: 60000 });
      if (raw.length === W * H) decoded.set(second, frame = new Uint8Array(raw));
    } catch { /* a frame that will not decode reads as clean */ }
    return frame;
  };
  return (view, t, until) => {
    const key = `${Math.round(t * 10)}:${Math.round(until * 10)}`;
    let mask = cache.get(key);
    if (!mask) {
      const times = until > t + 1e-6 ? [t, (t + until) / 2, until] : [t];
      const frames: Uint8Array[] = [];
      for (const time of times) {
        const frame = frameAt(time);
        if (frame) frames.push(frame);
      }
      if (!frames.length && strict) throw new Error(`${file}: no source frame decodes at ${times.map(time => at(time).toFixed(3)).join(", ")} s`);
      if (!frames.length && !warnedDecodes) {
        warnedDecodes = true;
        console.warn("source frames would not decode; the camera text guard is off");
      }
      mask = frames.length ? edgeCuts(frames, W, H, 0) : () => 0;
      if (cache.size >= 2) cache.clear();
      cache.set(key, mask);
    }
    return cutCount(mask(view));
  };
}

/** Read the take's durable inputs, write its camera path and render the silent MP4.
 * A preview renders the same camera path from a smaller source, at a smaller export. */
export async function renderTake(dir: string, camera?: CameraDefaults, preview?: PreviewSpec): Promise<{ out: string; seconds: number }> {
  let meta = JSON.parse(await readFile(join(dir, "take.json"), "utf8")) as TakeMeta;
  let d: CameraDefaults = camera ?? resolveTheme(meta.theme);
  const phone = meta.device !== undefined && meta.height > meta.width;
  if (phone) d = { ...d, corner_radius: 36, stage_margin: Math.max(0.16, d.stage_margin) };
  validateZooms(meta.zooms, meta.width, meta.height);
  validateEdits(meta);
  const beats = JSON.parse(await readFile(join(dir, "analysis/beats.json"), "utf8")) as Beat[];
  // The planner stores seconds; the existing FOLLOW solver consumes action timestamps in ms.
  if ("stream" in meta) for (const beat of beats) beat.actions = beat.actions.map(actionCameraMilliseconds);
  const decisionLines = await readFile(join(dir, "analysis/decisions.jsonl"), "utf8");
  // plan.json holds the camera choices the user may have edited; they win over decisions.jsonl.
  // Refuse an edit this take cannot honour before any camera path is built.
  const plan = readPlan(dir);
  validatePlan(plan, beats, { androidFallback: meta.device === "android" && meta.planner?.mode === "fallback" });
  const decisions = applyPlan(decisionLines.split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line) as Decision), plan);

  const trimStart = meta.trim_start ?? 0;
  const wide = d.out_w > d.out_h;
  // Wide motion and crop-to-fill motion (a portrait, 4:5 or square cut from a wider
  // desktop screen) are qualified. Phone and other exports keep the centred rest framing.
  const moving = wide || (!phone && d.out_w / d.out_h < meta.width / meta.height);
  const cameraWarning = moving ? manualZoomLimitWarning(meta, d)
    : meta.zooms?.length ? "take.json: camera motion is disabled for this export shape; use wide output, or a narrower shape cut from a wider screen, for zooms" : undefined;
  if (cameraWarning) console.warn(cameraWarning);
  const trimEnd = meta.trim_end ?? purposefulEnd(beats, trimStart,
    meta.duration ?? Math.max(0, ...beats.map((beat) => beat.t1)), d);
  // Everything after this point runs on the output clock, with idle gaps squeezed.
  const squeezes = idleSqueezes(beats, trimStart, trimEnd, d);
  const wantsTypeSpeed = Boolean(meta.speed?.some(s => s.kind === "type_speed"));
  const typing = wantsTypeSpeed ? await takeTypingBursts(dir, meta) : [];
  if (wantsTypeSpeed && typing.length === 0) {
    console.warn("take.json: speed type_speed found no typing events; it has no effect");
  }
  const clock = meta.cuts?.length || meta.speed?.length ? editTimeline(meta, beats, trimStart, trimEnd, d, typing) : undefined;
  const outTime = clock?.at ?? ((t: number) => warp(t - trimStart, squeezes, d.idle_speed));
  const duration = outTime(trimEnd);
  const shownBeats = clipDrags(beats, clock?.spans.filter(s => s.rate > 0) ?? [{ t0: trimStart, t1: trimEnd }]);
  let outBeats = clock ? editBeats(shownBeats, clock, trimStart) : warpBeats(shownBeats, trimStart, squeezes, d.idle_speed);
  const byId = new Map(outBeats.map(b => [b.id, b]));
  const outDecisions = clock ? decisions.flatMap(decision => {
    const beat = byId.get(decision.beat);
    if (!beat || beat.camera_suppressed) return [];
    const kept = (name: string | undefined) => beat.zones.some(z => z.name === name);
    const A = kept(decision.A) ? decision.A : beat.zones[0]!.name;
    const B = kept(decision.B) ? decision.B : A;
    return [{ ...decision, A, B }];
  }) : decisions;
  const tapShots = meta.device === "android" && meta.planner?.mode === "fallback"
    ? phoneTapShots(outBeats, meta.width, meta.height) : null;
  const shown = withFilmText(meta);
  const captions = takeCaptions(clock ? { ...shown, captions: shown.captions?.filter(c => clock.contains(c.t)) } : shown, outTime, duration);
  // Every take with text gets the band, a phone in its handset too: text never covers the app.
  const banded = captions.length > 0;
  // The card the camera frames into, the text band and the measured caption ink. The layout
  // belongs to the render space, so a preview lays its own card out at preview scale.
  const layout = async (m: TakeMeta, dd: CameraDefaults, bandOverride?: Band | null) => {
    let text = banded ? bandText(captions, [], dd) : dd;
    let ink = await measureCaptions(dir, captions, text);
    const fitted = banded ? bandText(captions, ink, text) : text;
    if (fitted !== text) ink = await measureCaptions(dir, captions, fitted);
    const band = bandOverride ?? (banded ? bandLayout(m.width, m.height, fitted, captions, ink) : null);
    return { text: fitted, captionInk: ink, band, stage: band?.stage ?? stageGeometry(m.width, m.height, dd) };
  };
  const solveLayout = await layout(meta, d);
  // A band card of the screen's own shape (a phone in a 16:9 film) is framed at that shape.
  const cam = solveLayout.band ? bandCamera(solveLayout.band, meta.width, meta.height, d) : d;
  // The band card shows only screen: a view padded past it (a square's whole-screen rest, a phone's
  // held margin) is fitted back inside. A desktop take at the export's own shape needs no fitting.
  const fit = banded && (phone || Math.abs(meta.width / meta.height - d.out_w / d.out_h) > 0.01)
    ? (f: CameraFrame) => insideScreen(f, meta.width, meta.height, cam.out_w / cam.out_h) : undefined;
  // Output time -> source second, so the guard builds its ink mask from the frame shown.
  const sourceAt = (t: number) => {
    let lo = trimStart, hi = trimEnd;
    for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (outTime(mid) < t) lo = mid; else hi = mid; }
    return hi;
  };
  // The one no-cut-text guard: a single edge check over the take's own source frames, shared by
  // every camera path, so no target, hold, reveal or push-in can park a crop edge in a word.
  const cuts = moving ? sourceEdgeCuts(dir, meta, (t) => sourceAt(t - trimStart)) : undefined;
  // A handset's controls span its narrow screen. Keep that entire width while pushing in and
  // following the tapped row; the guard judges this re-framed view, not the raw solver crop.
  const phoneReframe = (f: CameraFrame): CameraFrame => {
    const w = Math.max(f.w, meta.width * cam.hold_pad);
    const h = w * cam.out_h / cam.out_w;
    const cy = f.y + f.h / 2;
    const y = h >= meta.height ? (meta.height - h) / 2
      : Math.max(0, Math.min(meta.height - h, cy - h / 2));
    return { t: f.t, x: (meta.width - w) / 2, y, w, h };
  };
  const project = (frame: CameraFrame) => sourceViewport(frame, meta.width, meta.height, solveLayout.stage, d);
  const changes = moving ? await takeChanges(dir, meta, trimStart, trimEnd, outTime, clock?.contains ?? (() => true)) : [];
  const solved = solveCamera(tapShots?.beats ?? outBeats, tapShots?.decisions ?? outDecisions, { ...meta, trim_end: trimStart + duration },
    { ...cam, min_shot: d.min_shot * d.pace, dwell: d.dwell * d.pace, dwell_k2: d.dwell_k2 * d.pace },
    banded ? fit && (phone ? (frame) => fit(phoneReframe(frame)) : fit) : phone ? (frame) => project(phoneReframe(frame)) : project, cuts, changes);
  const solvedFrames = phone ? solved.map(phoneReframe) : solved;
  const held = wide && d.camera_path === "hold" && !phone ? holdPath(solvedFrames, outBeats, outDecisions,
    { band: solveLayout.band, stage: solveLayout.stage, width: meta.width, height: meta.height, d: cam, minShot: d.min_shot * d.pace },
    videoFrames(join(dir, "screen.webm"), meta.width, meta.height, sourceAt)) : undefined;
  if (held) await writeFile(join(dir, "camera-holds.json"), JSON.stringify(held.holds, null, 2));
  // Manual spans are source-video seconds; use the same edit clock as footage.
  // Applying them after holdPath prevents its automatic composition from erasing
  // the director's explicit framing. Drag visibility remains the final safety gate.
  const zooms = (meta.zooms ?? []).flatMap(z => {
    const spans = clock?.spans.filter(s => s.rate > 0) ?? [{ t0: trimStart, t1: trimEnd }];
    return spans.flatMap(s => {
      const a = Math.max(trimStart, s.t0, z.t0), b = Math.min(trimEnd, s.t1, z.t1);
      return b > a ? [{ ...z, t0: trimStart + outTime(a), t1: trimStart + outTime(b) }] : [];
    });
  });
  // Exports without qualified motion retain the centred rest framing; neither
  // automatic/held paths nor manual spans can move it.
  const restW = baseWidth(meta.width, meta.height, cam), restH = restW * cam.out_h / cam.out_w;
  const directed = moving ? applyManualZooms(held?.frames ?? solvedFrames, { ...meta, zooms }, cam, outBeats, changes)
    : solvedFrames.map(f => ({ t: f.t, x: (meta.width - restW) / 2, y: (meta.height - restH) / 2, w: restW, h: restH }));
  let frames = moving && zooms.length ? applyDragVisibility(directed, outBeats, meta.width, meta.height, trimStart, cam) : directed;
  if (fit) frames = frames.map(fit);
  // The same guard judges the moving frames of the final path, whichever stage made them: none may
  // crawl a crop edge through a word, so a move crosses text only at a sweep. A frame is judged on
  // the source frame its 0.1 s mask window starts at, so re-checking a retimed move decodes nothing
  // new, and each move's decodes are dropped once it is done.
  if (wide && !phone && cuts) frames = sweepCuts(frames, () => {
    const moveCuts = sourceEdgeCuts(dir, meta, (t) => sourceAt(t - trimStart))!;
    return (f) => { const at = Math.round((trimStart + f.t) * 10) / 10; return moveCuts(banded ? f : project(f), at, at) > 0; };
  }, cam);
  await writeFile(join(dir, "camera.json"), JSON.stringify(frames));
  // A preview renders the same camera path from a smaller source: the source-space inputs
  // and the camera frames scale with the proxy, the export-space constants with the
  // preview's size. The solve above ran at full resolution, so the preview frames the film
  // exactly like the full render does, at the same timestamps.
  let source = join(dir, "screen.webm");
  let workDir = dir;
  let scaledEvents: Event[] | undefined;
  if (preview) {
    const proxy = proxySize(meta.width, meta.height);
    source = await ensureProxy(dir, meta.width, meta.height, proxy.w, proxy.h);
    const scale = proxy.w / meta.width;
    meta = scaleMeta(meta, scale, proxy.w, proxy.h);
    d = previewDefaults(d, preview.out_w, preview.out_h, preview.fps);
    outBeats = outBeats.map(beat => scaleBeat(beat, scale));
    frames = scaleFrames(frames, scale);
    const eventsPath = join(dir, "events.jsonl");
    if (existsSync(eventsPath)) scaledEvents = (await readEvents(eventsPath)).map(event => scaleEvent(event, scale));
    workDir = join(dir, "preview");
    await mkdir(workDir, { recursive: true });
  }
  const renderLayout = preview
    ? await layout(meta, d, solveLayout.band ? scaleBand(solveLayout.band, preview.out_w / solveLayout.band.stage.w) : null)
    : solveLayout;
  const { text, captionInk, band, stage } = renderLayout;
  const blurs = overlayRegions(meta, "blur", outTime, trimStart, trimEnd);
  const spotlights = overlayRegions(meta, "spotlight", outTime, trimStart, trimEnd);
  const commandFile = join(workDir, "camera.cmd");
  // With a band the camera frames the screen alone, into the fixed card.
  const stageCamera = band ? bandFrames(frames, band, d) : stageFrames(frames, meta.width, meta.height, stage, d);
  // The source region each frame paints: the band crops screen.webm to its frame, the stage
  // crops the card at the screen's origin inside it. Text outside this is not shown at all.
  const drawn: Rect[] = band ? frames.map(f => [f.x, f.y, f.x + f.w, f.y + f.h])
    : stageCamera.map(f => [f.x - stage.screenX, f.y - stage.screenY, f.x + f.w - stage.screenX, f.y + f.h - stage.screenY]);
  const view = band ? { ...d, out_w: stage.baseW, out_h: stage.baseH } : d;
  // A take that carries its text boxes renders only when every shown box sits in the safe area.
  const safe = safeAreaReport(dir, stageCamera, drawn, band ? { x: 0, y: 0 } : { x: stage.screenX, y: stage.screenY },
    { w: d.out_w, h: d.out_h, fps: d.fps }, sourceAt,
    (band ? captionLayouts(captions, captionInk, text, band) : []).map(({ cx, cy, w, h, rise }, i) => (
      { t: captions[i]!.t0, t1: captions[i]!.t1, label: captions[i]!.text, box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2 + rise] })));
  if (safe) {
    await writeFile(join(workDir, "safe-area.json"), JSON.stringify(safe, null, 1));
    const [first] = safe.failures;
    if (first) throw new Error(`safe area: ${safe.failures.length} text box placements cross the ${SAFE_INSET * 100}% inset `
      + `[${safe.safe.map(Math.round).join(",")}] of the ${d.out_w}x${d.out_h} output; first "${first.label}" at output frame ${first.frame} `
      + `(${first.t_out}s, source ${first.t_src}s): output box [${first.output.join(",")}]; report ${join(workDir, "safe-area.json")}`);
  }
  const [cameraFrames, cameraW, cameraH] = band ? [frames, meta.width, meta.height] : [stageCamera, stage.w, stage.h];
  const shutter = shutterPlan(cameraFrames, cameraW, cameraH, view);
  await writeFile(join(workDir, "motion-blur.json"), JSON.stringify(shutter.metrics, null, 2));

  // A cursor-free take gets a drawn vector cursor from its recorded pointer
  // track, projected through the camera and rasterised at output resolution.
  const cursorFile = join(workDir, "cursor.ass");
  const clicks = beatClicks(outBeats);
  let cursorOverlay = "";
  if (meta.cursor_free === true) {
    // Old cursor-free takes may lack a track. Keep the footage usable, but say
    // why there is no drawn cursor. Event-file read errors still surface.
    const eventsPath = join(dir, "events.jsonl");
    const events = scaledEvents ?? (existsSync(eventsPath) ? await readEvents(eventsPath) : []);
    const startMs = videoStartMs(dir, meta);
    const drawn = cursorAss({
      events, videoStartMs: startMs,
      trimStart, trimEnd, outTime, clicks, frames: stageCamera, d, duration,
      originX: band ? 0 : stage.screenX, originY: band ? 0 : stage.screenY,
      card: { x: stage.screenX, y: stage.screenY, w: band ? stage.baseW : meta.width,
        h: band ? stage.baseH : meta.height, radius: d.corner_radius / stage.restScale, fixed: Boolean(band) },
    });
    if (hasDialogue(drawn)) {
      await writeFile(cursorFile, drawn);
      cursorOverlay = `,ass=${filterPath(cursorFile)}:fontsdir=${filterPath(FONTS_DIR)}`;
    } else if (pointerSamples(events, startMs).length === 0) {
      console.warn("No usable pointer samples in this cursor-free take; rendering without a drawn cursor.");
    }
  }

  const outputDir = join(dir, "out");
  await mkdir(outputDir, { recursive: true });
  const id = meta.id ?? basename(dir);
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) || id === "..") {
    throw new Error(`invalid take id: ${id}`);
  }
  const output = join(outputDir, preview ? `${id}-preview.mp4` : `${id}.mp4`);

  // Render intermediates live next to camera.cmd so a failed render can be rerun by hand.
  const stageFile = join(workDir, "stage.png");
  const holesFile = join(workDir, "stage-holes.png");
  await runFfmpeg(["-y", "-v", "error", ...(d.bg_style === "image" ? ["-i", resolveBackgroundImage(dir, d.background_image)] : []), "-filter_complex", stageImageFilter(band ? stage.baseW : meta.width, band ? stage.baseH : meta.height, stage, d, phone),
    "-map", "[stage]", "-frames:v", "1", "-update", "1", stageFile,
    "-map", "[holes]", "-frames:v", "1", "-update", "1", holesFile]);
  const clicksFile = join(workDir, "clicks.ass");
  const clicksAss = clickAss(clicks, meta.width, meta.height, trimStart,
    band ? { ...stage, restScale: stage.baseW / meta.width } : stage, view,
    { frames: cameraFrames, stage: band ? { ...stage, screenX: 0, screenY: 0 } : stage, shutter });
  await writeFile(clicksFile, clicksAss);
  const captionsFile = join(workDir, "captions.ass");
  const captionsAss = band ? captionAss(captions, captionInk, text, band) : "";
  await writeFile(captionsFile, captionsAss);

  const keysFile = join(workDir, "keycaps.ass");
  const keyObstacles = keycapObstacles(outBeats, outDecisions, stageCamera,
    band ? { ...stage, screenX: 0, screenY: 0 } : stage,
    trimStart, captions, captionInk, text, band, [...spotlights, ...blurs]);
  const keys = keycapAss(outBeats, trimStart, duration, d, keyObstacles);
  const keyMaskFile = join(workDir, "keycaps-mask.ass");
  await writeFile(keyMaskFile, keycapMaskAss(outBeats, trimStart, duration, d, keyObstacles));
  await writeFile(keysFile, keys);
  const spotlightFile = join(workDir, "spotlight.ass");
  const spotlight = spotlightAss(spotlights, meta.width, meta.height, view, { frames: cameraFrames, stage: band ? { ...stage, screenX: 0, screenY: 0 } : stage, shutter });
  await writeFile(spotlightFile, spotlight);
  const keysOverlay = hasDialogue(keys) ? `,ass=${filterPath(keysFile)}:fontsdir=${filterPath(FONTS_DIR)}` : "";

  const fade = Math.min(d.fade_s, duration / 4);
  const background = `0x${d.background_to.slice(1)}`;
  // Planar YUV composition; blur patches briefly use RGB. Stills are decoded once.
  // An .ass with no Dialogue lines renders nothing, so skip its overlay:
  // stock ffmpeg builds without libass (e.g. Homebrew) have no ass filter.
  const pixelFormat = d.quality === "master" ? "yuv444p" : "yuv420p";
  const clicksOverlay = hasDialogue(clicksAss) ? `,ass=${filterPath(clicksFile)}:fontsdir=${filterPath(FONTS_DIR)}` : "";
  const captionsOverlay = hasDialogue(captionsAss) ? `,ass=${filterPath(captionsFile)}:fontsdir=${filterPath(FONTS_DIR)}` : "";
  const graph = (start: number) => {
    const camera = motionBlurGraph(cameraFrames, shutter, cameraW, cameraH, view, start);
    // A segment skips composing the frames before its own; the camera's resampler
    // repeats the first one back to zero, so its sample indices stay the same.
    const from = start ? `,trim=start=${((start - 0.5) / d.fps).toFixed(9)}` : "";
    const still = `loop=-1:1:0,trim=end=${duration}${from.replace(",trim=", ":")}`;
    return [
    `[0:v]${clock?.filter ?? `setpts='${setptsExpr(squeezes, d.idle_speed)}'`},fps=${d.fps}${from}${clicksOverlay},scale=in_color_matrix=auto:out_color_matrix=bt601,format=${pixelFormat}[region0]`,
    ...(blurs.length ? [blurGraph(blurs, pixelFormat)] : []),
    ...(spotlights.length ? [
      `[region${blurs.length}]null[spotlightInput]`,
      spotlightGraph(spotlights, meta.width, meta.height, duration, d, filterPath(spotlightFile))
        .replace(/\[screen\]$/, band ? "[raw]" : "[screen]"),
    ] : [`[region${blurs.length}]null${band ? "[raw]" : "[screen]"}`]),
    ...(band ? [
      `${camera.replace(/^\[c4\]/, "[raw]")};[camera]null[screen]`,
      cardFilter(stage.baseW, stage.baseH, stage, d, still),
      `[c4]trim=end=${duration}[composed]`,
    ] : [
      cardFilter(meta.width, meta.height, stage, d, still),
      `${camera};[camera]trim=end=${duration}[composed]`,
    ]),
    ...(hasDialogue(keys) ? [
      `[composed]null[keycapInput]`,
      keycapBackdropGraph(duration, d, filterPath(keyMaskFile)),
    ] : []),
    `${hasDialogue(keys) ? "[keycapOutput]" : "[composed]"}null${cursorOverlay}${captionsOverlay}${keysOverlay}`
      // Fading toward a flat colour also fades the stage grain, so dark gradients band in
      // 8-bit. The dither has to stay above one 8-bit level (c0s=6 measures 0.73 luma levels
      // and anything under c0s=4 rounds away at 8-bit) and at full strength for the whole
      // fade: the darkest, lowest-contrast frames are the first ones in and the last ones out,
      // so easing the grain in with the fade is what left those frames banded. One amplitude
      // for every theme - this is an 8-bit quantisation problem, not a gradient-depth one.
      // The grain runs unconditionally, not gated to the fade windows: switching it on in one
      // frame left a CAMBI onset transient (4.73 on a visibly clean mono fade-out onset frame)
      // while every other fade frame scored <= 0.184.
      + (fade > 0 ? `,fade=t=in:st=0:d=${fade}:color=${background},fade=t=out:st=${duration - fade}:d=${fade}:color=${background}`
        + `,noise=c0s=10:c0f=u:c0_seed=7` : "")
      + `,scale=in_color_matrix=bt601:out_color_matrix=bt709:out_range=tv,format=${pixelFormat},setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709`
      + (start ? ",setpts=PTS-STARTPTS" : ""),
  ].join(";"); };

  await writeFile(commandFile, graph(0));

  const threads = renderThreads();
  const ffmpegMajor = Number(execFileSync("ffmpeg", ["-version"], { encoding: "utf8" })
    .match(/ffmpeg version (?:n)?(\d+)/)?.[1] ?? 0);
  // ffmpeg 7 introduced file-valued options; older releases use the script flag.
  const graphOption = ffmpegMajor >= 7 ? "-/filter_complex" : "-filter_complex_script";
  const pass = (graphFile: string, frames: string[], out: string, signal?: AbortSignal) => runFfmpeg([
    "-y", "-ss", String(trimStart), "-to", String(trimEnd),
    "-i", source,
    "-framerate", String(d.fps), "-i", stageFile,
    "-framerate", String(d.fps), "-i", holesFile,
    // Slice threads keep the stage filters from starving the encoder.
    // The encoder joins the cap only when TAKEONE_RENDER_THREADS sets one; unset keeps ffmpeg's own default.
    ...(process.env.TAKEONE_RENDER_THREADS === undefined ? [] : ["-threads", threads]),
    "-filter_threads", threads, "-filter_complex_threads", threads,
    graphOption, graphFile,
    ...(clock ? ["-t", String(duration)] : []), ...frames,
    "-r", String(d.fps), "-an", ...encodingOptions(d),
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
    "-movflags", "+faststart", out,
  ], signal);

  // Keep camera.cmd on failure for straightforward diagnosis and re-rendering.
  const starts = segmentStarts(shutter.counts, renderSegments(shutter.counts.length, d.fps));
  if (starts.length === 1) {
    await writeFile(join(workDir, "render.log"), await pass(commandFile, [], output));
    return { out: output, seconds: duration };
  }
  // One ffmpeg filter graph runs on one thread apart from slice work, and the
  // per-sample v360 remap rebuilds dominate it. Time segments render in parallel
  // and join by stream copy. Every filter after the warp is clocked by time and
  // the grain pattern is static, so each segment's frames match the single pass.
  const parts = starts.map((_, k) => join(workDir, `render-part${k}.mp4`));
  // One failed segment must not leave its siblings encoding for hours: aborting
  // kills every remaining ffmpeg, and the concat join honours the same signal.
  const cancel = new AbortController();
  const logs = await Promise.all(starts.map(async (start, k) => {
    const graphFile = join(dir, `camera-part${k}.cmd`);
    await writeFile(graphFile, graph(start));
    const end = starts[k + 1];
    return pass(graphFile, end === undefined ? [] : ["-frames:v", String(end - start)], parts[k]!, cancel.signal);
  })).catch(err => { cancel.abort(); throw err; });
  const list = join(workDir, "render-parts.txt");
  // Exact durations: the parts' own mp4 durations are rounded and would shift every later frame.
  await writeFile(list, parts.map((part, k) => `file '${part.replace(/'/g, "'\\''")}'\n`
    + `duration ${(((starts[k + 1] ?? shutter.counts.length) - starts[k]!) / d.fps).toFixed(6)}\n`).join(""));
  logs.push(await runFfmpeg(["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", output], cancel.signal));
  await writeFile(join(workDir, "render.log"), [`render segments start at frames ${starts.join(", ")}`, ...logs].join("\n"));
  await Promise.all([list, ...parts, ...parts.map((_, k) => join(dir, `camera-part${k}.cmd`))].map(file => rm(file, { force: true })));
  return { out: output, seconds: duration };
}

/** ffmpeg thread count for every render and export: TAKEONE_RENDER_THREADS when set, else at most eight or the available cores. */
export function renderThreads(): string {
  const fixed = process.env.TAKEONE_RENDER_THREADS;
  if (fixed !== undefined) {
    if (!/^[1-9]\d*$/.test(fixed)) throw new Error(`TAKEONE_RENDER_THREADS must be a positive integer, got "${fixed}"`);
    return fixed;
  }
  return String(Math.min(8, availableParallelism()));
}

/** Parallel render segments: TAKEONE_RENDER_SEGMENTS when set, else one per four
 * cores (a single render keeps about four busy) and per 5 GiB of available
 * memory, at most four, averaging at least two seconds each. */
let memorySegments: number | undefined;
function renderSegments(frames: number, fps: number): number {
  const fixed = process.env.TAKEONE_RENDER_SEGMENTS;
  if (fixed !== undefined && !/^[1-9]\d*$/.test(fixed)) throw new Error(`TAKEONE_RENDER_SEGMENTS must be a positive integer, got "${fixed}"`);
  // ponytail: flat 5 GiB per segment (a 9:16 single pass peaked near it); scale by stage size if it holds back smaller films.
  memorySegments ??= Math.floor(process.availableMemory() / 2 ** 30 / 5);
  const wanted = fixed ? Number(fixed) : Math.min(4, Math.floor(availableParallelism() / 4), memorySegments);
  return Math.max(1, Math.min(wanted, Math.floor(frames / (2 * fps))));
}

/** First output frame of each segment, splitting the warp work evenly. A
 * blurred frame costs one warp and about two remap rebuilds per sample; a
 * still frame costs about one warp. */
function segmentStarts(counts: number[], segments: number): number[] {
  const costs = counts.map(count => count > 1 ? 6 * count : 1);
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  const starts = [0];
  let sum = 0;
  costs.forEach((cost, i) => {
    if (i > starts.at(-1)! && sum >= total * starts.length / segments && starts.length < segments) starts.push(i);
    sum += cost;
  });
  return starts;
}

/** True when rendered .ass text carries at least one Dialogue event. */
function hasDialogue(assText: string): boolean {
  return assText.split("\n").some((line) => line.startsWith("Dialogue:"));
}

/** Escape a path for an option value inside an ffmpeg filter graph. */
function filterPath(path: string): string {
  const escapedOption = path.replace(/[\\:']/g, "\\$&");
  return escapedOption.replace(/[\\',;\[\]]/g, "\\$&");
}

/** Libass ink bounds: captions use complete single lines; titles use wrapping. */
export async function measureCaptions(dir: string, captions: Caption[], d: CameraDefaults): Promise<CaptionInk[]> {
  if (captions.length === 0) return [];
  const file = join(dir, "measure.ass");
  const widths = captions.map(() => ({ w: 0, h: 0 }));
  const titles = captions.flatMap((c, i) => c.title ? [i] : []);
  const groups = [titles, ...captions.flatMap((c, i) => c.title ? [] : [[i]])].filter(g => g.length);
  for (const indices of groups) {
    const first = captions[indices[0]!]!;
    const fullWidth = Array.from(first.text).length * d.caption_size * 4;
    const scale = !first.title ? Math.max(0.01, Math.min(1, Math.floor(32000 / Math.max(1, fullWidth) * 100) / 100)) : 1;
    const measurement = !first.title ? { ...d,
      out_w: Math.ceil((d.out_w + fullWidth * scale) / 2) * 2,
      out_h: Math.ceil(d.caption_size * 4 / 2) * 2,
    } : d;
    await writeFile(file, measureAss(indices.map(i => captions[i]!), measurement, scale * 100));
    const log = await runFfmpeg(["-hide_banner", "-f", "lavfi", "-i", `color=black:s=${measurement.out_w}x${measurement.out_h}:r=1:d=${indices.length}`,
      "-vf", `ass=${filterPath(file)}:fontsdir=${filterPath(FONTS_DIR)},format=gray,cropdetect=limit=0:round=2:reset=1:skip=0`, "-f", "null", "-"]);
    for (const match of log.matchAll(/x1:(-?\d+) x2:(-?\d+) y1:(-?\d+) y2:(-?\d+).*? t:(\d+(?:\.\d+)?)/g)) {
      const index = indices[Math.round(Number(match[5]))];
      if (index !== undefined) widths[index] = { w: Math.max(0, Number(match[2]) - Number(match[1]) + 1 + (scale < 1 ? 2 : 0)) / scale,
        h: Math.max(0, Number(match[4]) - Number(match[3]) + 1) };
    }
  }
  return widths;
}

/** Bundled static OFL fonts; same directory in source and compiled builds. */
export const FONTS_DIR = fileURLToPath(new URL("../../resources/fonts/", import.meta.url));

function resolveBackgroundImage(dir: string, path: string): string {
  if (!path) throw new Error("bg_style=image requires background_image");
  // ffmpeg input protocol parsing must not turn a local path into a URL.
  return resolve(dir, path);
}
