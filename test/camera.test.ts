import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { DEFAULTS } from "../src/camera/defaults.ts";
import type { Beat, Decision, Zone } from "../src/camera/types.ts";
import type { Action } from "../src/types.ts";
import { renderTake } from "../src/render/render.ts";
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

test("render infers duration, then make and saved render retain typing, dialog results and trimmed drags", { timeout: 120_000, skip: needsFfmpeg }, async () => {
  const dir = await mkdtemp(join(process.cwd(), "takeone:duration-"));
  try {
    await mkdir(join(dir, "analysis"));
    // mpeg4, not VP9: software VP9 stalls weak CI runners; input codec is
    // incidental here (see buildTake in make.test.ts for the full rationale).
    execFileSync("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=30:d=9",
      "-c:v", "mpeg4", "-q:v", "2", "-f", "matroska",
      "-y", join(dir, "screen.webm"),
    ]);
    const later = { ...beat("later", 0.8, 20), t0: 0.2, t1: 1.8,
      zones: [zone("later", [20, 20, 40, 30])] };
    const earlier = { ...beat("earlier", 0.7, 80), t0: 0.1, t1: 1.2,
      zones: [zone("earlier", [80, 20, 40, 30])] };
    await writeFile(join(dir, "take.json"), JSON.stringify({ id: "duration", width: 320, height: 180 }));
    await writeFile(join(dir, "analysis/beats.json"), JSON.stringify([later, earlier]));
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
      const drags = saved.flatMap(b => b.actions as Action[]).filter(a => a.k === "drag");
      assert.equal(drags.length, 3);
      assert.equal(drags[0]!.t0, 0, "pickup before first video frame is clipped onto the video clock");
      assert.ok(drags.every(d => d.path?.every(p => p.t >= 0)));
      assert.equal(Math.max(...drags.map(d => d.t1)), released ? 7.5 : 8);
      const typing = saved.find(b => b.kind === "type")!;
      assert.ok(typing, "typing survives the real planning pipeline");
      // Saved plans may declare a revealed dialog and an established whole object.
      // Without that explicit footprint the held drag must stay wide.
      const revealTime = typing.t0 + 0.5;
      typing.dialog_results = [{ t: revealTime, bbox: [0, 0, 320, 180] }];
      if (released) drags.find(d => d.t0 === 4)!.whole_object = [20, 70, 40, 40];
      await writeFile(join(dir, "analysis/beats.json"), JSON.stringify(saved));
      cli("render");
      const trace: { t: number; x: number; y: number; w: number; h: number }[] =
        JSON.parse(await readFile(join(dir, "camera.json"), "utf8"));
      const tail = trace.filter(f => f.t >= 5.6 && f.t <= (released ? 7.5 : 7.9));
      assert.ok(tail.length > 100, "check every stationary held-tail frame, not just the arrival");
      assert.ok(tail.every(f => contains(f, released ? [240, 70, 40, 40] : [0, 0, 320, 180])
        && contains(f, [252, 82, 32, 40])), "held object and cursor are never cropped");
      const reveal = trace.filter(f => f.t >= revealTime && f.t <= revealTime + 0.5);
      assert.ok(reveal.length > 0 && reveal.every(f => contains(f, [0, 0, 320, 180])), "dialog result stays visible");
      const decoded = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames",
        "-show_entries", "stream=nb_read_frames", "-of", "default=nw=1:nk=1", output], { encoding: "utf8" });
      assert.equal(Number(decoded.trim()), trace.length, "saved camera and playable output share a clock");
    }
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
  }
});
