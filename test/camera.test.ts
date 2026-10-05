import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { DEFAULTS } from "../src/camera/defaults.ts";
import { solveCamera } from "../src/camera/solver.ts";
import type { Beat, Decision, Zone } from "../src/camera/types.ts";
import type { Action } from "../src/types.ts";
import { renderTake } from "../src/render/render.ts";
import { idleSqueezes, warp, warpBeats } from "../src/render/pace.ts";
import { sourceViewport, stageGeometry } from "../src/render/stage.ts";
import { contains } from "../scripts/check-framing.ts";
import { hasFfmpeg } from "./helpers.ts";

// Only tests pass a fast preset and tiny output: shipped output stays
// 1920x1080 slow (see DEFAULTS). Small frames keep CI software encodes fast;
// ripple and fade add per-frame stage work, so tests turn them off (both are
// already no-ops at 0 in the render path, and the shipped defaults are untouched).
const FAST = { ...DEFAULTS, preset: "veryfast", out_w: 320, out_h: 180, ripple_ms: 0, fade_s: 0 };

// The render journeys below shell out to system ffmpeg/ffprobe, so they skip
// explicitly where those binaries are absent instead of failing with ENOENT.
// CI installs ffmpeg (see .github/workflows/ci.yml) so coverage stays real there.
const needsFfmpeg = hasFfmpeg() ? undefined : "requires system ffmpeg and ffprobe on PATH";

const zone = (name: string, bbox: [number, number, number, number]): Zone => ({
  name,
  type: "act",
  bbox,
});

function beat(id: string, anchor: number, x: number, kind: Beat["kind"] = "click"): Beat {
  return {
    id,
    t0: anchor - 0.5,
    t1: anchor + 1,
    anchor_t: anchor,
    actions: [],
    zones: [zone(id, [x, 900, 180, 120])],
    kind,
  };
}

function decision(b: Beat, importance: 0 | 1 | 2 = 1): Decision {
  return {
    beat: b.id,
    A: b.zones[0]!.name,
    L: 3,
    p: 0,
    K: importance,
    conf: 1,
    decided_by: "test",
  };
}

test("render CLI rejects unknown and malformed override arguments", () => {
  for (const args of [["--sset", "fps=24"], ["--set", "fps=24=30"], ["--set", "fps=24", "extra"]]) {
    const result = spawnSync(process.execPath,
      ["--experimental-strip-types", "src/cli.ts", "render", ".", ...args],
      { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown option|invalid --set/);
  }
});

// One consumer journey: inferred duration, then the real make -> saved render path over
// typing, a revealed dialog result and drags trimmed at the video boundary, released and not.
test("render without trim_end uses the latest beat end", { timeout: 120_000, skip: needsFfmpeg }, async () => {
  const dir = await mkdtemp(join(process.cwd(), "takeone:duration-"));
  try {
    await mkdir(join(dir, "analysis"));
    // mpeg4, not VP9: software VP9 stalls weak CI runners; input codec is
    // incidental here (see buildTake in make.test.ts for the full rationale).
    execFileSync("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=30:d=13",
      "-c:v", "mpeg4", "-q:v", "2", "-f", "matroska",
      "-y", join(dir, "screen.webm"),
    ]);
    const later = { ...beat("later", 0.8, 20), t0: 0.2, t1: 1.8,
      zones: [zone("later", [20, 20, 40, 30])] };
    const earlier = { ...beat("earlier", 0.7, 80), t0: 0.1, t1: 1.2,
      zones: [zone("earlier", [80, 20, 40, 30])] };
    // A click at 10.0 s whose card lands at 10.9 s, after the beat's last
    // pointer travel: the outro must still cover the outcome it shows.
    const toast = { ...beat("toast", 10, 20), t0: 9.6, t1: 10.9,
      zones: [{ ...zone("toast", [20, 20, 40, 30]), type: "res" as const, t_change: 10.9 }] };
    const beats = [later, earlier, toast];
    await writeFile(join(dir, "take.json"), JSON.stringify({ id: "duration", width: 320, height: 180 }));
    await writeFile(join(dir, "analysis/beats.json"), JSON.stringify(beats.slice(0, 2)));
    await writeFile(join(dir, "analysis/decisions.jsonl"),
      [decision(later), decision(earlier)].map((d) => JSON.stringify(d)).join("\n") + "\n");
    const cli = (command: string, ...args: string[]) => execFileSync(process.execPath,
      ["bin/takeone.mjs", command, dir,
        ...["preset=veryfast", "out_w=320", "out_h=180", "ripple_ms=0", "fade_s=0", "max_upscale=1.5"]
          .flatMap(value => ["--set", value]), ...args],
      { encoding: "utf8", env: { ...process.env, TAKEONE_DIR: dir, TAKEONE_STATE_DIR: join(dir, "state") } });
    cli("render");
    const output = join(dir, "out/duration.mp4");
    const frames = JSON.parse(await readFile(join(dir, "camera.json"), "utf8"));
    assert.equal(frames.at(-1).t, 1.8);
    const count = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=nb_frames", "-of", "default=noprint_wrappers=1:nokey=1", output],
    { encoding: "utf8" });
    assert.equal(Number(count.trim()), Math.round(1.8 * DEFAULTS.fps));
    // Square pixels must survive per-frame crop-size changes (ffmpeg 6.1
    // stalls on per-frame SAR changes; see setsar=1 each side of scale).
    const sar = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=sample_aspect_ratio", "-of", "default=noprint_wrappers=1:nokey=1", output],
    { encoding: "utf8" });
    assert.equal(sar.trim(), "1:1");

    // One consumer journey replaces the isolated event/clock/solver checks:
    // a drag crossing the first video frame, typing, and overlapping buttons
    // with a stationary held tail, both released and unreleased at trim end.
    await writeFile(join(dir, "frames.tsv"), Array.from({ length: 270 }, (_, i) =>
      `${i * 3000}\t${Math.round((1000 + i * 1000 / 30) * 1e6)}`).join("\n") + "\n");
    const history = [
      { k: "win", t: 0, cls: "board", title: "Demo board", rect: [0, 0, 320, 180] },
      { k: "ptr", t: 900, x: 40, y: 90 }, { k: "btn", t: 900, b: "left", down: true },
      { k: "ptr", t: 1500, x: 120, y: 90 }, { k: "btn", t: 2000, b: "left", down: false },
      { k: "key", t: 3000, cls: "char", down: true }, { k: "key", t: 3100, cls: "char", down: true },
      { k: "ptr", t: 5000, x: 40, y: 90 }, { k: "btn", t: 5000, b: "left", down: true },
      { k: "ptr", t: 6000, x: 260, y: 90 },
      { k: "ptr", t: 6500, x: 200, y: 90 }, { k: "btn", t: 6500, b: "right", down: true },
      { k: "ptr", t: 6550, x: 260, y: 90 }, { k: "btn", t: 6600, b: "right", down: false },
    ];
    for (const released of [false, true]) {
      await writeFile(join(dir, "take.json"), JSON.stringify({ id: "duration",
        stream: { w: 320, h: 180 }, scale: 1, offset_ms: 0, pointer: "mapped",
        trim: { start: 1000, end: 9000 } }));
      await writeFile(join(dir, "events.jsonl"), [...history,
        ...(released ? [{ k: "btn", t: 8500, b: "left", down: false }] : [])]
        .map(event => JSON.stringify(event)).join("\n") + "\n");
      cli("make", "--no-jev");
      const saved: Beat[] = JSON.parse(await readFile(join(dir, "analysis/beats.json"), "utf8"));
      const actions = saved.flatMap(b => b.actions as Action[]);
      const drags = actions.filter(a => a.k === "drag");
      assert.deepEqual(drags.map(d => d.t0), [1, 5, 6.5], "three real drags, longer one first");
      assert.ok(drags.every(d => d.path?.every(p => p.t >= 1)), "no negative history reaches the camera");
      assert.equal(Math.max(...drags.map(d => d.t1)), released ? 8.5 : 9,
        "an unreleased drag holds to the last visible second");
      const typing = actions.find(a => a.k === "type");
      assert.ok(typing, "typing survives the real planning pipeline");
      // Saved plans may declare a revealed dialog and an established whole object.
      // Without that explicit footprint the held drag must stay wide.
      const revealTime = typing!.t0 + 0.5;
      saved.find(b => (b.actions as Action[]).includes(typing!))!.dialog_results =
        [{ t: revealTime, bbox: [0, 0, 320, 180] }];
      if (released) drags.find(d => d.t0 === 5)!.whole_object = [30, 70, 40, 40];
      await writeFile(join(dir, "analysis/beats.json"), JSON.stringify(saved));
      cli("render");
      const trace: { t: number; x: number; y: number; w: number; h: number }[] =
        JSON.parse(await readFile(join(dir, "camera.json"), "utf8"));
      const tail = trace.filter(f => f.t >= 6.8 && f.t <= (released ? 8.4 : 9));
      assert.ok(tail.length > 30, "check every stationary held-tail frame, not just the arrival");
      assert.ok(tail.every(f => contains(f, [252, 82, 32, 40])), "the held cursor is never cropped");
      assert.ok(tail.every(f => contains(f, released ? [30, 70, 40, 40] : [0, 0, 320, 180])),
        "an established whole object frames the drag; without one the shot stays wide");
      const reveal = trace.filter(f => f.t >= revealTime && f.t <= revealTime + 0.5);
      assert.ok(reveal.length > 0 && reveal.every(f => contains(f, [0, 0, 320, 180])), "dialog result stays visible");
      const decoded = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames",
        "-show_entries", "stream=nb_read_frames", "-of", "default=nw=1:nk=1", output], { encoding: "utf8" });
      // The saved trace and the playable file run on one clock; the encoder may
      // drop or hold the single boundary frame, so allow that one frame only.
      assert.ok(Math.abs(Number(decoded.trim()) - trace.length) <= 1,
        "saved camera and playable output share a clock");
    }
    // With the recording length known, the export runs to the result's outro
    // (10.9 + 1.6) rather than stopping on the beat's last action (10.4).
    await writeFile(join(dir, "take.json"), JSON.stringify({ id: "duration", width: 320, height: 180, duration: 13 }));
    await writeFile(join(dir, "analysis/beats.json"), JSON.stringify([toast]));
    await writeFile(join(dir, "analysis/decisions.jsonl"), `${JSON.stringify(decision(toast))}\n`);
    await renderTake(dir, FAST);
    // On the output clock: the idle stretch before the result is squeezed.
    const end = 10.9 + DEFAULTS.outro_s;
    const squeezes = idleSqueezes([toast], 0, end, FAST);
    const last = JSON.parse(await readFile(join(dir, "camera.json"), "utf8"));
    assert.equal(last.length, Math.round(warp(end, squeezes, FAST.idle_speed) * DEFAULTS.fps));
    // outro_s=0 drops the closing hold and the padding, not the trimming: the
    // export ends on the result instead of running the recording's dead tail.
    const bare = { ...FAST, outro_s: 0 };
    await renderTake(dir, bare);
    const trimmed = idleSqueezes([toast], 0, 10.9, bare);
    const bareLast = JSON.parse(await readFile(join(dir, "camera.json"), "utf8")).at(-1);
    assert.ok(Math.abs(bareLast.t - warp(10.9, trimmed, bare.idle_speed)) <= 1 / DEFAULTS.fps,
      `outro_s=0 exported to ${bareLast.t}s, not the result at ${warp(10.9, trimmed, bare.idle_speed)}s`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("synthetic source renders silent H.264 at the configured size and 60fps", {
  timeout: 120_000, skip: needsFfmpeg,
}, async () => {
  const dir = await mkdtemp(join(process.cwd(), "takeone:render-"));
  try {
    await mkdir(join(dir, "analysis"));
    // Tiny fixtures: a 4K source stalled a weak CI runner past the test
    // timeout (software scale + x264). Resolution is incidental here - only
    // the rendered MP4 codec, size and frame count are asserted - and the
    // shipped 1920x1080 default is untouched (see DEFAULTS). Matroska muxer
    // because stock webm allows only VP8/VP9/AV1; the pipeline probes
    // content, so the .webm name is cosmetic.
    execFileSync("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=30:d=2",
      "-c:v", "mpeg4", "-q:v", "2", "-f", "matroska",
      "-y", join(dir, "screen.webm"),
    ]);
    await writeFile(join(dir, "take.json"), JSON.stringify({
      id: "fixture", width: 320, height: 180, trim_start: 0, trim_end: 2,
      captions: [{ t: 0.35, d: 1, text: "Select a card" }],
    }));
    const fixtureBeat = beat("fixture", 0.6, 2600);
    // Small-frame zone: the default helper zone sits in 4K coordinates and
    // would fail input validation before the take-id check below runs.
    fixtureBeat.zones = [zone("fixture", [20, 20, 40, 30])];
    await writeFile(join(dir, "analysis/beats.json"), JSON.stringify([fixtureBeat]));
    await writeFile(join(dir, "analysis/decisions.jsonl"), `${JSON.stringify(decision(fixtureBeat))}\n`);

    await writeFile(join(dir, "take.json"), JSON.stringify({
      id: "../../other", width: 320, height: 180, trim_start: 0, trim_end: 2,
    }));
    await assert.rejects(renderTake(dir), /invalid take id/);
    await writeFile(join(dir, "take.json"), JSON.stringify({
      id: "fixture", width: 320, height: 180, trim_start: 0, trim_end: 2,
      captions: [{ t: 0.35, d: 1, text: "Select a card" }],
    }));
    const output = (await renderTake(dir, FAST)).out;
    const probe = JSON.parse(execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries",
      "stream=width,height,nb_frames,codec_name,r_frame_rate,color_range,color_space,color_transfer,color_primaries", "-of", "json", output,
    ], { encoding: "utf8" })).streams[0];
    assert.deepEqual(probe, { codec_name: "h264", width: 320, height: 180, color_range: "tv",
      color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", r_frame_rate: "60/1", nb_frames: "120" });
    for (const quality of ["draft", "standard", "master"] as const) {
      await renderTake(dir, { ...FAST, quality });
      const first = await readFile(output);
      await renderTake(dir, { ...FAST, quality });
      assert.deepEqual(await readFile(output), first, `${quality} must encode byte-identically`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("master blur preserves full-resolution chroma through production rendering", { skip: needsFfmpeg }, async () => {
  const dir = await mkdtemp(join(process.cwd(), "takeone-chroma-"));
  try {
    const width = 160, height = 90, plane = width * height;
    const source = Buffer.alloc(plane * 3, 128);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      source[plane + y * width + x] = x % 2 ? 176 : 80;
    }
    const input = join(dir, "source.yuv");
    await writeFile(input, source);
    execFileSync("ffmpeg", ["-y", "-v", "error", "-stream_loop", "-1", "-f", "rawvideo",
      "-pix_fmt", "yuv444p", "-s", "160x90", "-r", "10", "-i", input,
      "-t", "0.6", "-c:v", "ffv1", "-f", "matroska", join(dir, "screen.webm")]);
    await mkdir(join(dir, "analysis"));
    await writeFile(join(dir, "analysis/beats.json"), "[]");
    await writeFile(join(dir, "analysis/decisions.jsonl"), "");
    await writeFile(join(dir, "take.json"), JSON.stringify({ id: "chroma", width, height,
      trim_end: 0.6, blur: [{ t: 0.2, d: 0.2, rect: [10, 10, 30, 20] }] }));
    const { out } = await renderTake(dir, { ...FAST, quality: "master", out_w: width, out_h: height,
      fps: 10, stage_margin: 0, corner_radius: 0, motion_blur: 0 });
    const format = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=pix_fmt", "-of", "default=nw=1:nk=1", out], { encoding: "utf8" });
    assert.equal(format.trim(), "yuv444p");
    const pixels = execFileSync("ffmpeg", ["-v", "error", "-i", out,
      "-pix_fmt", "yuv444p", "-f", "rawvideo", "-"], { maxBuffer: 1_000_000 });
    assert.equal(pixels.length, 6 * plane * 3);
    const contrast = (frame: number, x: number, y: number) => {
      const at = frame * plane * 3 + plane + y * width + x;
      return Math.abs(pixels[at]! - pixels[at + 1]!);
    };
    for (let frame = 0; frame < 6; frame++) {
      assert.ok(contrast(frame, 80, 45) > 60, `outside blur frame ${frame}`);
      if (frame === 2 || frame === 3) assert.ok(contrast(frame, 20, 20) < 10, `active blur frame ${frame}`);
      else assert.ok(contrast(frame, 20, 20) > 60, `inactive blur frame ${frame}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });

// J2 whole-element framing on every emitted frame: while the camera prepares
// the incoming selected header, the revealed Tidewater result must stay whole
// through the hold, the header must be whole from the first prepared frame,
// and the hold must not park wide to fake either guarantee. Mirrors render.ts
// exactly (idleSqueezes -> warpBeats -> paced solveCamera with the stage
// projection); camera.json is these solved frames, so every emitted frame of
// the default idle-squeezed render path is checked, plus the unwarped path.
test("a prepared incoming header never cuts the preceding whole result through the render pipeline", () => {
  const result: Zone["bbox"] = [496, 292, 3056, 1800];
  const headerRow: Zone["bbox"] = [0, 0, 3840, 268];
  const close: Beat = { id: "close", kind: "click", t0: 12.4, t1: 28.7, anchor_t: 12.4,
    actions: [], zones: [{ name: "all", type: "all", bbox: [0, 0, 3840, 2160] }],
    dialog_results: [{ t: 13.6, bbox: result }] };
  const header: Beat = { id: "header", kind: "click", t0: 35.03333333333333, t1: 40,
    anchor_t: 35.03333333333333, actions: [], zones: [{ name: "header", type: "act",
      bbox: [0, 0, 3840, 136], boxes: [[0, 0, 3840, 136], [24, 172, 372, 96]] }] };
  const beats = [close, header];
  const decisions: Decision[] = [
    { beat: "close", A: "all", L: 0, p: 0, K: 1, conf: 1, decided_by: "test" },
    { beat: "header", A: "header", L: 1, p: 0, K: 1, conf: 1, decided_by: "test" },
  ];
  const d = { ...DEFAULTS, outro_s: 0 };
  const stage = stageGeometry(3840, 2160, d);
  const project = (f: Parameters<typeof sourceViewport>[0]) => sourceViewport(f, 3840, 2160, stage, d);
  const deadline = 34.266666666666666;
  // Unwarped (idle_speed 1): the result stays whole through the hold, the
  // header is whole from the preparation deadline, and the hold stays readable.
  // Containment is checked on the projected stage view (what the render shows
  // and what the preparation widens into); the readability bound uses the raw
  // solved widths that camera.json records.
  const raw = solveCamera(beats, decisions, { width: 3840, height: 2160, trim_end: 40 }, d, project);
  const frames = raw.map(project);
  for (const f of frames.filter(f => f.t >= 15 && f.t <= deadline)) {
    assert.ok(contains(f, result), `preceding result cut at ${f.t}`);
  }
  for (const f of frames.filter(f => f.t >= deadline)) {
    assert.ok(contains(f, headerRow), `incoming header cut at ${f.t}`);
  }
  assert.ok(raw.filter(f => f.t >= 33 && f.t < 33.5).every(f => f.w < 3600),
    "hold the readable result instead of parking wide");
  // Default render path: the idle squeeze warps this same take; the invariant
  // must survive on the emitted output-time frames (what camera.json holds).
  const squeezes = idleSqueezes(beats, 0, 40, d);
  const duration = warp(40, squeezes, d.idle_speed);
  const solved = solveCamera(warpBeats(beats, 0, squeezes, d.idle_speed), decisions,
    { width: 3840, height: 2160, trim_end: duration },
    { ...d, min_shot: d.min_shot * d.pace, dwell: d.dwell * d.pace, dwell_k2: d.dwell_k2 * d.pace }, project);
  const outDeadline = warp(deadline, squeezes, d.idle_speed);
  const outFrames = solved.map(project);
  const held = outFrames.filter(f => f.t >= warp(13.6, squeezes, d.idle_speed) && f.t <= outDeadline);
  assert.ok(held.length > 30, "check every held frame, not just the arrival");
  assert.ok(held.every(f => contains(f, result)), "the preceding result stays whole through the squeezed hold");
  assert.ok(solved.filter(f => f.t >= warp(13.6, squeezes, d.idle_speed) && f.t <= outDeadline).every(f => f.w < 3700),
    "the squeezed hold stays readable instead of parking wide");
  assert.ok(outFrames.filter(f => f.t >= outDeadline).every(f => contains(f, headerRow)),
    "the incoming header is whole from the first prepared frame");
});

test("the default establishing hold keeps the whole stage, the outro brings it back", () => {
  const early = { ...beat("early", 0.3, 2600), t0: 0 };
  const held = solveCamera([early], [decision(early)],
    { width: 3840, height: 2160, trim_start: 0, trim_end: 8 });
  for (const f of held.filter(f => f.t <= DEFAULTS.establish_s)) assert.equal(f.w, 3840);
  assert.ok(held[Math.round(3.2 * DEFAULTS.fps)]!.w < 3000);
  for (const f of held.filter(f => f.t >= 8 - DEFAULTS.outro_s)) assert.equal(f.w, 3840);
});
