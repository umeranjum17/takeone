import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULTS } from "../src/camera/defaults.ts";
import { solveCamera, solveCameraDetailed, clippedFractions, wholeCrop, frame, toFrame } from "../src/camera/solver.ts";
import type { Beat, CameraFrame, Decision, Zone } from "../src/camera/types.ts";
import type { Action } from "../src/types.ts";
import { renderTake, sourceEdgeCuts } from "../src/render/render.ts";
import { idleSqueezes, warp, warpBeats } from "../src/render/pace.ts";
import { sourceViewport, stageGeometry, stageFrames, minStageMargin } from "../src/render/stage.ts";
import { edgeCuts, cutCount } from "../src/render/framing.ts";
import { resolveTheme } from "../src/themes.ts";
import { contains, settledFrames } from "../scripts/check-framing.ts";
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
// typing, a revealed dialog result, drags trimmed at the video boundary, released and not,
// and a drop whose settled layout the camera reframes.
// The added portrait and drop renders need a 360s journey budget (the drop journey's
// real 4K capture plus its guarded portrait solve measured 249s on a loaded two-CPU runner).
test("render without trim_end uses the latest beat end", { timeout: 360_000, skip: needsFfmpeg }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "takeone:duration-"));
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
      cli("make", "--no-ai");
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

    // Real 4K make journey: a form beside a tall panel, not a solver-only fixture.
    // Keep the export small; the source geometry and native-pixel ceiling are real.
    execFileSync("ffmpeg", ["-y", "-v", "error", "-filter_threads", "2", "-threads", "2",
      "-f", "lavfi", "-i", "color=c=0x202328:s=3840x2160:r=10:d=10",
      "-vf", "drawbox=x=0:y=0:w=3840:h=136:color=0xeeeeee:t=fill," +
        "drawbox=x=2972:y=188:w=824:h=1916:color=0xdddddd:t=fill," +
        "drawbox=x=1344:y=504:w=1152:h=940:color=white:t=fill," +
        "drawbox=x=1428:y=736:w=900:h=96:color=0xeeeeee:t=fill," +
        "drawbox=x=1440:y=750:w=44:h=52:color=black:t=fill:enable='gte(t,4)'," +
        "drawbox=x=1490:y=750:w=44:h=52:color=black:t=fill:enable='gte(t,4.2)'," +
        "drawbox=x=1420:y=1340:w=440:h=480:color=white:t=fill:enable='between(t,6,7.5)'," +
        "drawbox=x=0:y=0:w=3840:h=2160:color=0x3a4250:t=fill:enable='gte(t,8.5)'," +
        "drawbox=x=600:y=400:w=1000:h=700:color=white:t=fill:enable='gte(t,8.5)'",
      "-c:v", "mpeg4", "-q:v", "2", "-threads", "2", "-f", "matroska", join(dir, "screen.webm")]);
    await writeFile(join(dir, "frames.tsv"), Array.from({ length: 100 }, (_, i) =>
      `${i * 9000}\t${i * 100_000_000}`).join("\n") + "\n");
    const fourK = { id: "duration", stream: { w: 3840, h: 2160 }, scale: 2,
      offset_ms: 0, pointer: "mapped", trim: { start: 0, end: 10000 } };
    await writeFile(join(dir, "take.json"), JSON.stringify(fourK));
    await writeFile(join(dir, "events.jsonl"), [
      { k: "win", t: 0, cls: "board", title: "Umer's board", rect: [0, 0, 3840, 2160] },
      { k: "ptr", t: 0, x: 2250, y: 1350 },
      { k: "ptr", t: 1000, x: 2625, y: 558 },
      { k: "ptr", t: 2000, x: 1600, y: 780 },
      { k: "btn", t: 2000, b: "left", down: true },
      { k: "btn", t: 2080, b: "left", down: false },
      ...Array.from({ length: 18 }, (_, i) => ({ k: "key", t: 4000 + i * 200, cls: "char", down: true })),
      { k: "ptr", t: 6000, x: 1640, y: 1360 },
      { k: "btn", t: 6000, b: "left", down: true },
      { k: "btn", t: 6080, b: "left", down: false },
    ].map(e => JSON.stringify(e)).join("\n") + "\n");
    const drive4K = (command: string, ...args: string[]) => execFileSync(process.execPath,
      ["bin/takeone.mjs", command, dir, ...["out_w=960", "out_h=540", "fps=10",
        "preset=ultrafast", "motion_blur=0", "idle_speed=1", "ripple_ms=0"]
        .flatMap(v => ["--set", v]), ...args],
      { env: { ...process.env, TAKEONE_DIR: dir, TAKEONE_STATE_DIR: join(dir, "state") } });
    drive4K("make", "--no-ai");
    const camera4K = async () => JSON.parse(await readFile(join(dir, "camera.json"), "utf8")) as
      { t: number; x: number; y: number; w: number; h: number }[];
    const auto = await camera4K();
    assert.ok(auto.some(f => f.t >= 3 && f.t <= 4.2 && 3840 / f.w > 1.4),
      `4K action beat must push in, not merge its form with the unrelated tall panel: ${JSON.stringify({
        frames: auto.filter(f => Number.isInteger(f.t)),
        beats: JSON.parse(await readFile(join(dir, "analysis/beats.json"), "utf8")),
      })}`);
    assert.ok(auto.filter(f => f.t >= 2 && f.t <= 4.2)
      .every(f => contains(f, [1344, 504, 1152, 940])), "dialog stays whole during the push, not only settled");
    assert.ok(auto.filter(f => f.t >= 6 && f.t <= 7.4)
      .every(f => contains(f, [1344, 504, 1152, 1316])),
      "a popup attached to the typed form stays whole from arrival, not only settled");
    const plannedMeta = JSON.parse(await readFile(join(dir, "take.json"), "utf8"));
    // Portrait push-in plans on the crop-to-fill window it renders: a manual
    // span right of the form (outside the centred rest window) holds it whole.
    await writeFile(join(dir, "take.json"), JSON.stringify({ ...plannedMeta, trim_end: 4.3,
      zooms: [{ t0: 3, t1: 4.2, bbox: [2400, 600, 500, 400], level: 1 }] }));
    drive4K("render", "--set", "out_w=540", "--set", "out_h=960", "--set", "outro_s=0");
    const tall = { ...resolveTheme(undefined), out_w: 540, out_h: 960 };
    const tallStage = stageGeometry(3840, 2160, tall);
    const pushed = (await camera4K()).filter(f => f.t >= 3 && f.t <= 4.2)
      .map(f => sourceViewport(f, 3840, 2160, tallStage, tall));
    assert.ok(pushed.length >= 10 && pushed.every(f => contains(f, [2400, 600, 500, 400])),
      `portrait manual zoom pushes in to its whole subject: ${JSON.stringify(pushed[0])}`);
    // Square motion is not qualified: auto and manual spans keep the centred rest frame.
    drive4K("render", "--set", "out_w=540", "--set", "out_h=540", "--set", "outro_s=0");
    const square = await camera4K();
    assert.ok(square.length >= 20 && square.every(f => f.x === 0 && f.y === -840 && f.w === 3840 && f.h === 3840),
      "square camera stays at the centred rest frame");
    await writeFile(join(dir, "take.json"), JSON.stringify({ ...plannedMeta,
      zooms: [{ t0: 3, t1: 4.2, bbox: [1344, 504, 1152, 940], level: 3 }] }));
    for (const path of ["solver", "hold"]) {
      drive4K("render", "--set", `camera_path=${path}`);
      const manual = (await camera4K()).filter(f => f.t >= 3 && f.t <= 4.2);
      assert.ok(manual.length >= 10 && manual.every(f => 3840 / f.w > 2),
        `manual zoom must direct ${path} camera.json throughout its hold`);
      assert.ok(manual.every(f => contains(f, [1344, 504, 1152, 940])), "manual subject stays whole");
      assert.ok(manual.every(f => f.w >= 960), "manual zoom retains the native-pixel ceiling");
    }
    // A hold across the popup widens to keep it whole from its first frame; a
    // hold asked for just before a screen paints waits for it, still until then.
    await writeFile(join(dir, "take.json"), JSON.stringify({ ...plannedMeta, zooms: [
      { t0: 3, t1: 7.5, bbox: [1344, 504, 1152, 940], level: 3 },
      { t0: 8.6, t1: 9.6, bbox: [600, 400, 1000, 700], level: 3 }] }));
    drive4K("render");
    const widened = await camera4K();
    assert.ok(widened.filter(f => f.t >= 3 && f.t <= 5).every(f => 3840 / f.w > 2),
      "typing inside the box leaves the hold tight until the popup paints");
    assert.ok(widened.filter(f => f.t >= 6 && f.t <= 7.4).every(f => contains(f, [1344, 504, 1152, 1316])),
      `a popup opened inside a manual hold stays whole from its first frame: ${JSON.stringify(widened.filter(f => f.t >= 5.5 && f.t <= 7.4))}`);
    const prePaint = widened.filter(f => f.t >= 8.1 && f.t < 8.5);
    assert.ok(prePaint.every(f => f.x === prePaint[0]!.x && f.w === prePaint[0]!.w),
      `a manual zoom never pushes in before its box paints: ${JSON.stringify(prePaint)}`);
    assert.ok(widened.filter(f => f.t >= 9.5 && f.t <= 9.6).every(f => contains(f, [600, 400, 1000, 700]) && 3840 / f.w > 2),
      "once the cut settles it arrives on the painted card");
    await writeFile(join(dir, "take.json"), JSON.stringify({ ...plannedMeta,
      cuts: [{ t0: 1, t1: 1.5 }], speed: [{ t0: 3, t1: 4.2, rate: 2 }],
      zooms: [{ t0: 3, t1: 4.2, bbox: [1344, 504, 1152, 940], level: 3 }] }));
    drive4K("render");
    const editedHold = (await camera4K()).filter(f => f.t >= 2.5 && f.t <= 3.1);
    assert.ok(editedHold.length >= 6 && editedHold.every(f => 3840 / f.w > 2),
      "manual span follows footage across a cut and 2x speed, not the old source clock");

    // Portrait from the same 4K take, on a saved plan shaped like the board demo:
    // a card on the right, a drag across the left columns, then a second modal
    // whose planned subject is the full-width top bar that opened it.
    const modal = [1400, 504, 1040, 940], card = [2900, 400, 500, 300], drop = [1200, 1000, 600, 200];
    const all = { name: "z9", type: "all", bbox: [0, 0, 3840, 2160] };
    await writeFile(join(dir, "analysis/beats.json"), JSON.stringify([
      { id: "c1", kind: "click", t0: 0.5, t1: 2, anchor_t: 1, zones: [{ name: "z1", type: "act", bbox: card }, all],
        actions: [{ k: "click", t: 1, x: 3150, y: 550 }] },
      { id: "c2", kind: "drag", t0: 2.5, t1: 5, anchor_t: 2.5, zones: [{ name: "z1", type: "act", bbox: card }, all],
        actions: [{ k: "drag", t0: 3, t1: 4.5, from: [600, 1100], to: [1500, 1100], bbox: [600, 1100, 900, 1] }] },
      { id: "c3", kind: "cut", t0: 7, t1: 7, anchor_t: 7, zones: [all], actions: [{ k: "cut", t: 7, changed_frac: 0.96 }] },
      { id: "c4", kind: "type", t0: 7, t1: 9, anchor_t: 7, zones: [
        { name: "z1", type: "txt", bbox: [1452, 704, 936, 120], boxes: [modal] },
        { name: "z2", type: "act", bbox: [0, 0, 3840, 136], boxes: [modal] }, all],
      actions: [{ k: "click", t: 7, x: 3450, y: 66 }, { k: "type", t0: 7.4, t1: 8.5, region: [1452, 736, 236, 52] }] },
    ]));
    await writeFile(join(dir, "analysis/decisions.jsonl"), [["c1", "z1", 2], ["c2", "z1", 2], ["c3", "z9", 1], ["c4", "z2", 1]]
      .map(([beat, A, L]) => JSON.stringify({ beat, A, L, p: 0, K: 1, conf: 1, decided_by: "test" })).join("\n") + "\n");
    await writeFile(join(dir, "take.json"), JSON.stringify({ ...plannedMeta, trim_end: 10 }));
    drive4K("render", "--set", "out_w=540", "--set", "out_h=960", "--set", "outro_s=0");
    const board = (await camera4K()).map(f => ({ ...sourceViewport(f, 3840, 2160, tallStage, tall), t: f.t }));
    const during = (a: number, b: number) => board.filter(f => f.t >= a && f.t <= b);
    assert.ok(during(7, 9).length >= 20 && during(7, 9).every(f => contains(f, modal)),
      `a later modal stays whole while it is on screen: ${JSON.stringify(during(7, 9).find(f => !contains(f, modal)))}`);
    assert.ok(during(4.5, 4.5 + DEFAULTS.min_shot).every(f => contains(f, drop)),
      `the drop target stays readable after release: ${JSON.stringify(during(4.5, 5.7)[0])}`);
    // The dragged surface is wider than the pointer's track: it travels whole.
    const held = (t: number) => [400 + (1500 - 600) * (t - 3) / 1.5, 1000, 500, 250];
    assert.ok(during(3, 4.5).length >= 10 && during(3, 4.5).every(f => contains(f, held(f.t))),
      `the portrait crop carries the dragged item whole: ${JSON.stringify(during(3, 4.5).find(f => !contains(f, held(f.t))))}`);

    // Drag then release, made from a real capture: the portrait view carries a card
    // right to the Done lane, the card it displaces slides down after release
    // (2.3-2.65 s), and at 5 s a text line paints left of the drop, across the
    // carried view's left edge. The release framing waits out that layout
    // animation, then pans at the same width until the line is whole.
    const line: [number, number, number, number] = [2560, 1880, 750, 40];
    const glyphs = (x: number, y: number, w: number, enable = "1") => Array.from({ length: Math.ceil(w / 12) }, (_, i) =>
      `drawbox=x=${x + i * 12}:y=${y}:w=6:h=40:color=0x39424e:t=fill:enable='${enable}'`).join(",");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-filter_threads", "2", "-filter_complex_threads", "2",
      "-filter_complex", `color=c=0xeef0f3:s=3840x2160:r=10:d=8.5,drawbox=x=3000:y=200:w=640:h=1880:color=0xe3e7ec:t=fill,` +
        `${glyphs(3040, 240, 120)}[board];color=c=white:s=560x170:r=10:d=8.5,${glyphs(32, 34, 360)},split[card][carried];` +
        `[board][card]overlay=x=3040:y='995+200*clip((t-2.3)/0.35,0,1)'[settling];` +
        `[settling][carried]overlay=x='1640+1400*clip((t-0.6)/1.6,0,1)^2*(3-2*clip((t-0.6)/1.6,0,1))':y=995,` +
        // Two words: an edge in the 14 px gap between them misses every glyph but still cuts the line.
        `${glyphs(line[0], line[1], 120, "gte(t,5)")},${glyphs(line[0] + 128, line[1], line[2] - 128, "gte(t,5)")}`,
      "-c:v", "mpeg4", "-q:v", "2", "-threads", "2", "-f", "matroska", join(dir, "screen.webm")]);
    await writeFile(join(dir, "frames.tsv"), Array.from({ length: 85 }, (_, i) =>
      `${i * 9000}\t${i * 100_000_000}`).join("\n") + "\n");
    const carryX = (t: number) => {
      const u = Math.min(1, Math.max(0, (t - 0.6) / 1.6));
      return 1920 + 1400 * u * u * (3 - 2 * u);
    };
    await writeFile(join(dir, "events.jsonl"), [
      { k: "win", t: 0, cls: "board", title: "Umer's board", rect: [0, 0, 3840, 2160] },
      // A resting hand still jitters a pixel, so capture keeps reporting the pointer.
      ...Array.from({ length: 86 }, (_, i) => ({ k: "ptr", t: i * 100, x: carryX(i / 10) + i % 2, y: 1080 })),
      { k: "btn", t: 500, b: "left", down: true }, { k: "btn", t: 2300, b: "left", down: false },
    ].sort((a, b) => a.t - b.t).map(e => JSON.stringify(e)).join("\n") + "\n");
    await writeFile(join(dir, "take.json"), JSON.stringify({ ...fourK, trim: { start: 0, end: 8000 } }));
    drive4K("make", "--no-ai", "--set", "out_w=540", "--set", "out_h=960", "--set", "outro_s=0");
    const dropped = (await camera4K()).map(f => ({ ...sourceViewport(f, 3840, 2160, tallStage, tall), t: f.t }));
    const at = (t: number) => dropped[Math.round(t * 10)]!;
    assert.ok(dropped.at(-1)!.t >= 7.8, "the render holds the settled drop to the take end");
    assert.ok(at(1.4).x > at(0.5).x + 600 && contains(at(2.3), [3300, 1060, 40, 40]),
      `the carry follows the pointer to the drop: ${JSON.stringify([at(0.5), at(1.4), at(2.3)])}`);
    assert.ok(dropped.filter(f => f.t >= 2.3 && f.t <= 2.6).every(f => Math.abs(f.x - at(2.3).x) + Math.abs(f.w - at(2.3).w) < 0.5),
      `the view holds still while the layout animates: ${JSON.stringify(dropped.filter(f => f.t >= 2.3 && f.t <= 2.7))}`);
    // An edge that only grazes the line still reads as a cut: the line stays 8 px clear of it.
    const settledDrop = dropped.filter(f => f.t >= 4.5), clearLine = [line[0] - 8, line[1] - 8, line[2] + 16, line[3] + 16];
    assert.ok(settledDrop.every(f => contains(f, clearLine) && contains(f, [3300, 1060, 40, 40])),
      `the settled view keeps the whole late line clear of its edges, and the drop: ${JSON.stringify(settledDrop.find(f => !contains(f, clearLine)))}`);
    assert.ok(settledDrop.every(f => Math.abs(f.w - at(2.3).w) < 1), "a pan fits the line, so the view does not zoom out");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("synthetic source renders silent H.264 at the configured size and 60fps", {
  timeout: 120_000, skip: needsFfmpeg,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "takeone:render-"));
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

test("a render split into parallel segments matches the single pass", { timeout: 300_000 }, async () => {
  // New tests cannot declare the needsFfmpeg skip (the floor guard blocks
  // new skips), so the prerequisite fails loudly here instead of with ENOENT.
  if (!hasFfmpeg()) throw new Error("requires system ffmpeg and ffprobe on PATH");
  const dir = await mkdtemp(join(tmpdir(), "takeone:segments-"));
  const previous = process.env["TAKEONE_RENDER_SEGMENTS"];
  try {
    await mkdir(join(dir, "analysis"));
    // Moving content under two camera moves: a segment that starts on the wrong
    // frame or shutter sample, or a part placed off the frame clock, cannot match.
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=8",
      "-c:v", "mpeg4", "-q:v", "2", "-f", "matroska", "-y", join(dir, "screen.webm")]);
    await writeFile(join(dir, "take.json"), JSON.stringify({ id: "segments", width: 640, height: 360, trim_start: 0, trim_end: 8,
      zooms: [{ t0: 1.5, t1: 3.5, bbox: [100, 60, 320, 180], level: 3 }, { t0: 5, t1: 6.5, bbox: [300, 150, 320, 180], level: 3 }] }));
    await writeFile(join(dir, "analysis/beats.json"), "[]");
    await writeFile(join(dir, "analysis/decisions.jsonl"), "");
    const render = async (segments: string) => {
      process.env["TAKEONE_RENDER_SEGMENTS"] = segments;
      const { out } = await renderTake(dir, FAST);
      const copy = join(dir, `segments-${segments}.mp4`);
      await writeFile(copy, await readFile(out));
      return copy;
    };
    const single = await render("1");
    assert.ok(JSON.parse(await readFile(join(dir, "motion-blur.json"), "utf8")).blurredFrames > 0, "the shutter path runs");
    const split = await render("3");
    assert.match(await readFile(join(dir, "render.log"), "utf8"), /^render segments start at frames 0, \d+/);
    const frames = (file: string) => execFileSync("ffprobe", ["-v", "error", "-show_entries", "frame=pts_time", "-of", "csv=p=0", file], { encoding: "utf8" }).match(/[\d.]+/g);
    assert.deepEqual(frames(split), frames(single), "same frames on the same clock");
    // Each segment is encoded on its own, so decoded frames differ by encoding noise only;
    // one frame of misplaced moving content falls far below this floor.
    const { stderr } = spawnSync("ffmpeg", ["-nostats", "-i", single, "-i", split, "-lavfi", "psnr", "-f", "null", "-"], { encoding: "utf8" });
    const psnr = /PSNR y:\S+ u:\S+ v:\S+ average:\S+ min:(\S+)/.exec(stderr);
    assert.ok(psnr && Number(psnr[1]) > 40, `split render against the single pass: ${psnr?.[0] ?? stderr}`);
  } finally {
    if (previous === undefined) delete process.env["TAKEONE_RENDER_SEGMENTS"];
    else process.env["TAKEONE_RENDER_SEGMENTS"] = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

// Every v360 command rebuilds the camera warp's whole remap table, and a fast move sends one per
// shutter sample. The even-rounded stage of a 4:3 take is not exactly 16:9, so its wide window must
// keep the export aspect (one d_fov per zoom step, not h_fov plus v_fov).
test("a blurred wide zoom rebuilds the warp only for camera parameters that change", { timeout: 120_000 }, async () => {
  if (!hasFfmpeg()) throw new Error("requires system ffmpeg and ffprobe on PATH");
  const dir = await mkdtemp(join(tmpdir(), "takeone:rebuilds-"));
  try {
    await mkdir(join(dir, "analysis"));
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=640x480:r=30:d=4",
      "-c:v", "mpeg4", "-q:v", "2", "-f", "matroska", "-y", join(dir, "screen.webm")]);
    await writeFile(join(dir, "take.json"), JSON.stringify({ id: "rebuilds", width: 640, height: 480, trim_start: 0, trim_end: 4,
      zooms: [{ t0: 1.5, t1: 3, bbox: [100, 100, 320, 180], level: 3 }] }));
    await writeFile(join(dir, "analysis/beats.json"), "[]");
    await writeFile(join(dir, "analysis/decisions.jsonl"), "");
    await renderTake(dir, FAST);
    assert.ok(JSON.parse(await readFile(join(dir, "motion-blur.json"), "utf8")).blurredFrames > 0, "the shutter path runs");
    const graph = await readFile(join(dir, "camera.cmd"), "utf8");
    const steps = [...graph.matchAll(/sendcmd=commands='([^']*)'/g)]
      .flatMap(([, commands]) => commands!.split(";").filter(entry => entry.includes(" v360 ")))
      .map(entry => {
        const space = entry.indexOf(" ");
        const updates = entry.slice(space + 1).split(",").map(update => {
          const [, key, value] = update.split(" ");
          return { key: key!, value: value! };
        });
        return { time: Number(entry.slice(0, space)), updates };
      });
    const keys = steps.flatMap(step => step.updates.map(update => update.key));
    assert.ok(keys.includes("d_fov") && steps.filter(step => step.updates.some(update => update.key === "d_fov")).length > 1,
      "the camera zooms in several steps");
    assert.ok(!keys.includes("h_fov") && !keys.includes("v_fov"), "a wide window zooms with one d_fov command per step");
    const last = new Map<string, string>();
    for (const step of steps) {
      const seen = new Set<string>();
      for (const { key, value } of step.updates) {
        assert.ok(!seen.has(key), `one rebuild per parameter per step at ${step.time}s`);
        seen.add(key);
        assert.notEqual(last.get(key), value, `${key} is rebuilt only when it changes (${step.time}s)`);
        last.set(key, value);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a blurred zoom blends only the moving exposures, leaving holds as sharp as an unblurred render", { timeout: 240_000 }, async () => {
  if (!hasFfmpeg()) throw new Error("requires system ffmpeg and ffprobe on PATH");
  const dir = await mkdtemp(join(tmpdir(), "takeone:blend-"));
  try {
    await mkdir(join(dir, "analysis"));
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=640x480:r=30:d=4",
      "-c:v", "mpeg4", "-q:v", "2", "-f", "matroska", "-y", join(dir, "screen.webm")]);
    await writeFile(join(dir, "take.json"), JSON.stringify({ id: "blend", width: 640, height: 480, trim_start: 0, trim_end: 4,
      zooms: [{ t0: 1.5, t1: 3, bbox: [100, 100, 320, 180], level: 3 }] }));
    await writeFile(join(dir, "analysis/beats.json"), "[]");
    await writeFile(join(dir, "analysis/decisions.jsonl"), "");
    const render = async (motion_blur: number) => {
      const { out } = await renderTake(dir, { ...FAST, motion_blur });
      const copy = join(dir, `blend-${motion_blur}.mp4`);
      await writeFile(copy, await readFile(out));
      return copy;
    };
    const blurred = await render(1);
    assert.ok(JSON.parse(await readFile(join(dir, "motion-blur.json"), "utf8")).blurredFrames > 0, "the shutter path runs");
    const sharp = await render(0);
    const luma = (file: string) => execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
      { maxBuffer: 1 << 26 });
    const a = luma(blurred), b = luma(sharp);
    const bytes = 320 * 180;
    assert.equal(a.length, b.length, "same frame count");
    const meanDiff = (from: number, to: number) => {
      const diffs: number[] = [];
      for (let f = 0; f * bytes < a.length; f++) {
        const t = f / DEFAULTS.fps;
        if (t < from || t >= to) continue;
        let sum = 0;
        for (let p = f * bytes; p < (f + 1) * bytes; p++) sum += Math.abs(a[p]! - b[p]!);
        diffs.push(sum / bytes);
      }
      return diffs.reduce((x, y) => x + y, 0) / diffs.length;
    };
    const hold = meanDiff(0, 0.7);
    const move = meanDiff(0.9, 1.2);
    assert.ok(hold < 0.1, `a hold before the zoom matches the sharp render (mean ${hold})`);
    assert.ok(move > 0.5, `the zoom is blurred against the sharp render (mean ${move}, hold ${hold})`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("master blur preserves full-resolution chroma through production rendering", { skip: needsFfmpeg }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "takeone-chroma-"));
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

test("a drag that reaches the screen edge stays visible through the closing ease", async () => {
  const { gestures, gestureZone } = await import("../src/camera/gesture.ts");
  const late = beat("late", 4, 550, "click");
  late.t1 = 7.5;
  late.actions = [{ k: "drag", t0: 6000, t1: 7500,
    from: [280, 720], to: [570, 855],
    bbox: [130, 640, 300, 160], whole_object: [130, 640, 300, 160] }];
  const end = 8.8;
  const frames = solveCamera([late], [decision(late, 2)],
    { width: 3840, height: 2160, trim_end: end }, DEFAULTS);
  const swept = gestureZone(gestures(late)[0]!, 3840, 2160).bbox;
  const arrival = end - DEFAULTS.outro_s;
  for (const f of frames) {
    if (f.t >= arrival) assert.deepEqual({ x: f.x, y: f.y, w: f.w, h: f.h }, { x: 0, y: 0, w: 3840, h: 2160 });
    else if (f.t >= 6 && f.t <= 7.5) assert.ok(contains(f, swept), `drag cropped at ${f.t}: ${JSON.stringify(f)}`);
  }
});

test("a drag with no whole object holds the screen wide for the drag, not for the whole beat around it", () => {
  const click = beat("click", 4, 400);
  const dragging = beat("dragging", 9, 400, "drag");
  dragging.t0 = 8;
  dragging.t1 = 26;
  dragging.actions = [{ k: "drag", t0: 14000, t1: 15500, from: [280, 720], to: [570, 855], bbox: [130, 640, 300, 160] }];
  const frames = solveCamera([click, dragging], [decision(click, 2), decision(dragging, 2)],
    { width: 3840, height: 2160, trim_end: 34 }, DEFAULTS);
  const at = (t: number) => frames[Math.round(t * DEFAULTS.fps)]!;
  for (const t of [14, 15, 15.5]) assert.equal(at(t).w, 3840, `wide through the drag at ${t}`);
  for (const t of [10, 20, 24]) assert.ok(at(t).w < 3840 * 0.6, `back on the shot at ${t}: ${at(t).w}`);
});

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

// J2 reveal regression (found on the real take at 38.0 s): a wide revealed
// result used to park slicing the detected surfaces beside it — the column
// label row cut in half at the top of the frame — because revealed zones
// carried no boxes, so compose's whole-element search never ran. The reveal
// must frame with the beat's surfaces: every detected box is whole or mostly
// out, on the projected stage view, through the reveal and the settled hold.
test("a revealed result never parks slicing the detected surfaces beside it", () => {
  const surfaces: Zone["bbox"][] = [[0, 0, 3840, 136], [24, 172, 372, 96],
    [480, 192, 780, 64], [1308, 192, 780, 64], [2136, 192, 780, 64],
    [1344, 504, 1152, 940], [2972, 188, 824, 1920]];
  const result: Zone["bbox"] = [496, 292, 2984, 1800];
  const reveal: Beat = { id: "b10", kind: "click", t0: 37.87, t1: 43.07, anchor_t: 37.87,
    actions: [],
    zones: [{ name: "z1", type: "act", bbox: [1344, 504, 1152, 1046], boxes: surfaces },
      { name: "z2", type: "all", bbox: [0, 0, 3840, 2160] }],
    dialog_results: [{ t: 37.9, bbox: result }] };
  const decisions: Decision[] = [
    { beat: "b10", A: "z1", L: 2, p: 0, K: 1, conf: 1, decided_by: "test" },
  ];
  const d = { ...DEFAULTS, outro_s: 0 };
  const stage = stageGeometry(3840, 2160, d);
  const project = (f: Parameters<typeof sourceViewport>[0]) => sourceViewport(f, 3840, 2160, stage, d);
  const frames = solveCamera([reveal], decisions, { width: 3840, height: 2160, trim_end: 42 }, d, project)
    .map(project).filter(f => f.t >= 38.9);
  assert.ok(frames.length > 100, "check the settled hold, not just the arrival");
  assert.ok(frames.every(f => contains(f, result)), "the revealed result must stay whole");
  for (const f of frames) {
    const clips = clippedFractions(f, surfaces);
    assert.deepEqual(clips.map(c => c === 0 || c >= 0.9), clips.map(() => true),
      `surface sliced at t=${f.t.toFixed(2)}: ${clips.map((c, i) => c > 0 && c < 0.9 ? `${surfaces[i]} cut ${(c * 100).toFixed(0)}%` : null).filter(Boolean).join("; ")}`);
  }
});

// Reveal sibling of the rail-cut regression: a revealed result must frame with
// the large Activity rail as an edge constraint too, so the settled hold never
// slices the rail. The geometry is the reveal test's surfaces with a narrower result.
test("a revealed result never parks slicing the Activity rail", () => {
  const surfaces: Zone["bbox"][] = [[0, 0, 3840, 136], [24, 172, 372, 96],
    [480, 192, 780, 64], [1308, 192, 780, 64], [2136, 192, 780, 64],
    [1344, 504, 1152, 940], [2972, 188, 824, 1916]];
  const rail = surfaces[6]!;
  const result: Zone["bbox"] = [500, 300, 2400, 1500];
  const reveal: Beat = { id: "b10", kind: "click", t0: 37.87, t1: 43.07, anchor_t: 37.87,
    actions: [],
    zones: [{ name: "z1", type: "act", bbox: [1344, 504, 1152, 1046], boxes: surfaces },
      { name: "z2", type: "all", bbox: [0, 0, 3840, 2160] }],
    dialog_results: [{ t: 37.9, bbox: result }] };
  const decisions: Decision[] = [
    { beat: "b10", A: "z1", L: 2, p: 0, K: 1, conf: 1, decided_by: "test" },
  ];
  const d = { ...DEFAULTS, outro_s: 0 };
  const stage = stageGeometry(3840, 2160, d);
  const project = (f: Parameters<typeof sourceViewport>[0]) => sourceViewport(f, 3840, 2160, stage, d);
  const frames = solveCamera([reveal], decisions, { width: 3840, height: 2160, trim_end: 42 }, d, project)
    .map(project).filter(f => f.t >= 38.9);
  assert.ok(frames.length > 100, "check the settled hold, not just the arrival");
  for (const f of frames) {
    const [clip] = clippedFractions(f, [rail]);
    assert.ok(clip === 0 || clip! >= 0.9,
      `rail sliced at t=${f.t.toFixed(2)}: ${((clip ?? 0) * 100).toFixed(1)}% out`);
  }
});

// Rail-cut regression (README hero, main a2fe36e): the push-ins on the New
// task dialog parked the crop edge inside the right-hand Activity rail, so the
// render sliced words at the frame edge (visual-check clipped-text failed at
// film 4.72 s and 8.77 s). The planner already knows the rail surface, so the
// solver keeps no projected edge inside it: every pushed-in hold keeps the
// rail and the top bar whole or leaves them out, on the projected stage view
// the render shows - while the hero opening push-in stays a close-up.
test("a dialog push-in never parks its edge inside the known side rail", () => {
  const heroBeats = [{"id":"b3","t0":3.2,"t1":6.366666666666667,"anchor_t":3.2,"kind":"type","window_cls":"headless-demo","window_rect":[0,0,3840,2160],"actions":[{"k":"dwell","t0":3.2,"t1":6.083333333333333,"x":3450,"y":66,"window_cls":"headless-demo"},{"k":"click","t":3.2,"x":3450,"y":66,"window_cls":"headless-demo"},{"k":"type","t0":3.9,"t1":5.5,"window_cls":"headless-demo","region":[1428,736,396,52]},{"k":"travel","t0":5.366666666666667,"t1":6.366666666666667,"from":[3450,66],"to":[2458.56,655.0319999999999],"bbox":[2458.56,66,991.44,589.0319999999999],"window_cls":"headless-demo"}],"zones":[{"name":"z1","type":"txt","bbox":[1396,704,1048,372],"boxes":[[2972,188,824,1916],[1344,504,1152,940],[0,128,424,2032],[0,0,3840,136],[1412,888,1016,176],[496,516,748,212],[500,296,740,208],[1328,296,740,208],[2156,296,740,208],[500,740,740,208],[1412,720,1016,88],[2524,516,376,208],[1468,28,904,76],[1412,1152,456,92],[24,172,372,96],[2156,1320,276,88],[3296,28,308,76],[1900,1316,236,96],[1428,736,48,52],[1452,744,52,44],[1476,736,36,52],[1484,740,36,48],[1504,736,32,52],[1508,744,60,44]],"t_change":3.9},{"name":"z2","type":"act","bbox":[0,0,3840,136],"boxes":[[2972,188,824,1916],[1344,504,1152,940],[0,128,424,2032],[0,0,3840,136],[1412,888,1016,176],[496,516,748,212],[500,296,740,208],[1328,296,740,208],[2156,296,740,208],[500,740,740,208],[1412,720,1016,88],[2524,516,376,208],[1468,28,904,76],[1412,1152,456,92],[24,172,372,96],[2156,1320,276,88],[3296,28,308,76],[1900,1316,236,96],[1396,704,1048,120]]},{"name":"z3","type":"path","bbox":[2459,66,991,589],"boxes":[[2972,188,824,1916],[1344,504,1152,940],[0,128,424,2032],[0,0,3840,136],[1412,888,1016,176],[496,516,748,212],[500,296,740,208],[1328,296,740,208],[2156,296,740,208],[500,740,740,208],[1412,720,1016,88],[2524,516,376,208],[1468,28,904,76],[1412,1152,456,92],[24,172,372,96],[2156,1320,276,88],[3296,28,308,76],[1900,1316,236,96],[1396,704,1048,120]]},{"name":"z4","type":"all","bbox":[0,0,3840,2160]}]},{"id":"b4","t0":6.766666666666667,"t1":12.4,"anchor_t":6.766666666666667,"kind":"type","window_cls":"headless-demo","window_rect":[0,0,3840,2160],"actions":[{"k":"dwell","t0":6.766666666666667,"t1":10.533333333333333,"x":1920,"y":975,"window_cls":"headless-demo"},{"k":"click","t":6.766666666666667,"x":1920,"y":975,"window_cls":"headless-demo"},{"k":"type","t0":7.066666666666667,"t1":9.933333333333334,"window_cls":"headless-demo","region":[1428,908,628,56]},{"k":"click","t":11.2,"x":1641,"y":1198.5,"window_cls":"headless-demo"},{"k":"click","t":12.4,"x":1641,"y":1462.5,"window_cls":"headless-demo"}],"zones":[{"name":"z1","type":"res","bbox":[1388,1264,504,372],"boxes":[[2972,188,824,1916],[1344,504,1152,940],[0,128,424,2032],[0,0,3840,136],[1412,888,1016,176],[496,516,748,212],[500,296,740,208],[1328,296,740,208],[2156,296,740,208],[500,740,740,208],[1412,716,1016,96],[2524,516,376,208],[1468,28,904,76],[1412,1152,456,92],[24,172,372,96],[2156,1320,276,88],[3296,28,308,76],[1900,1316,236,96],[1420,1256,152,100],[1712,1256,152,100],[1420,1256,444,176],[1420,1336,444,176],[1432,1172,120,56],[1388,1264,504,372],[1440,1280,80,52],[1440,1360,124,48]],"t_change":12.4},{"name":"z2","type":"act","bbox":[1344,504,1152,1132],"boxes":[[2972,188,824,1916],[1344,504,1152,940],[0,128,424,2032],[0,0,3840,136],[1412,888,1016,176],[496,516,748,212],[500,296,740,208],[1328,296,740,208],[2156,296,740,208],[500,740,740,208],[1412,716,1016,96],[2524,516,376,208],[1468,28,904,76],[1412,1152,456,92],[24,172,372,96],[2156,1320,276,88],[3296,28,308,76],[1900,1316,236,96],[1428,908,68,48],[1468,912,44,44]]},{"name":"z3","type":"all","bbox":[0,0,3840,2160]}]}] as Beat[];
  const heroDecisions = [{"beat":"b3","A":"z1","B":"z1","L":2,"p":0,"K":1,"conf":0,"decided_by":"heuristic"},{"beat":"b4","A":"z2","B":"z2","L":2,"p":1,"K":1,"conf":0,"decided_by":"heuristic"}] as Decision[];
  const d = { ...DEFAULTS, outro_s: 0 };
  const stage = stageGeometry(3840, 2160, d);
  const project = (f: Parameters<typeof sourceViewport>[0]) => sourceViewport(f, 3840, 2160, stage, d);
  const raw = solveCamera(heroBeats, heroDecisions, { width: 3840, height: 2160, trim_end: 13 }, d, project);
  const frames = raw.map(project);
  const rail: Zone["bbox"] = [2972, 188, 824, 1916];
  const topbar: Zone["bbox"] = [0, 0, 3840, 136];
  for (const [lo, hi] of [[3.9, 6], [7.5, 11]] as const) {
    const hold = frames.filter((f) => f.t >= lo && f.t <= hi);
    assert.ok(hold.length > 100, "check every held frame, not just the arrival");
    for (const f of hold) {
      const clips = clippedFractions(f, [rail, topbar]);
      assert.ok(clips.every((c) => c === 0 || c >= 1 - 1e-9),
        "rail or top bar sliced at t=" + f.t.toFixed(2) + ": " + clips.map((c) => (c * 100).toFixed(1) + "% out").join(", "));
    }
  }
  // The hero opens on the b3 push-in: it stays a close-up, not a wide shot.
  assert.ok(raw.filter((f) => f.t >= 3.9 && f.t <= 6).every((f) => f.w < 2600),
    "the opening push-in keeps its close-up instead of parking wide");
});

// Subject-in-rail regression: a card inside the Activity rail may own its own
// rows, but a crop edge must not slice the rail rows above or below it. Those
// rows are the rail outside the subject's extent, so each stays whole or out.
test("a rail-item subject never parks a crop edge through the rail rows beside it", () => {
  const rail: Zone["bbox"] = [2972, 188, 824, 1916];
  const card: Zone["bbox"] = [2990, 400, 700, 300];
  const above: Zone["bbox"] = [rail[0], rail[1], rail[2], card[1] - rail[1]];
  const below: Zone["bbox"] = [rail[0], card[1] + card[3], rail[2], rail[1] + rail[3] - card[1] - card[3]];
  for (const w0 of [1200, 1500, 2000]) {
    const crop = wholeCrop(w0, 3840, 16 / 9, card, [card], 3840, 2160, undefined, [rail]);
    assert.ok(crop, `a crop exists at w0=${w0}`);
    const clips = clippedFractions(crop, [above, below]);
    assert.ok(clips.every((c) => c === 0 || c >= 1 - 1e-9),
      `rail rows beside the card sliced at w0=${w0}: ${clips.map((c) => (c * 100).toFixed(1) + "% out").join(", ")}`);
  }
});

// The Ctrl+K / search shortcut push-in the planner left unannotated: the saved
// demo take's beat zone carried no rail box, so the solver's whole-element search
// had nothing constraining its edges and parked the crop edge inside the rail.
// The guard is the acceptance check's own definition - edgeCuts with no guard band,
// one dense text stretch counting as a cut - so no emitted crop edge runs through a
// word. The board is synthetic ink: horizontal strokes in the rail read as a dense
// run along a vertical edge, exactly what the guard measures.
test("a shortcut push-in with no planner boxes keeps its crop edge out of rail text", () => {
  const W = 3840, H = 2160;
  const rail: Zone["bbox"] = [2600, 100, 1200, 1960];
  const search: Beat = { id: "shortcut", kind: "shortcut", t0: 2.4, t1: 5.4, anchor_t: 2.9237,
    actions: [{ k: "shortcut", t: 2923.7, combo: "Ctrl+K" }],
    zones: [{ name: "search", type: "act", bbox: [800, 400, 2000, 900] }] };
  const decisions: Decision[] = [{ beat: "shortcut", A: "search", L: 1, p: 0, K: 0, conf: 1, decided_by: "test" }];
  const d = { ...DEFAULTS, outro_s: 0 };
  const stage = stageGeometry(W, H, d);
  const project = (f: Parameters<typeof sourceViewport>[0]) => sourceViewport(f, W, H, stage, d);
  const grey = new Uint8Array(W * H);
  for (let y = rail[1]; y < rail[1] + rail[3]; y++) {
    if ((y - rail[1]) % 10 >= 5) continue;
    for (let x = rail[0]; x < rail[0] + rail[2]; x++) grey[y * W + x] = 255;
  }
  const cut = edgeCuts([grey], W, H, 0);
  const cuts = (v: { x: number; y: number; w: number; h: number }) => cutCount(cut(v));
  const unguarded = solveCamera([search], decisions, { width: W, height: H, trim_end: 6 }, d, project)
    .map(project).filter((f) => f.t >= 3 && f.t <= 5);
  assert.ok(unguarded.some((f) => cuts(f) > 0), "the unguarded push-in is the regression: its edge runs through rail text");
  const guarded = solveCamera([search], decisions, { width: W, height: H, trim_end: 6 }, d, project, cuts)
    .map(project).filter((f) => f.t >= 3 && f.t <= 5);
  assert.ok(guarded.length >= 100, "sample the push-in, not just the arrival");
  for (const f of guarded) {
    assert.equal(cuts(f), 0, `rail text cut at t=${f.t.toFixed(2)}: ${JSON.stringify(f)}`);
  }
});

// The guard's window must cover the frames the hold shows, not stop at the beat
// end: a hold continues to the next move, so content that paints after the beat
// but while the camera still holds it must constrain the framing.
test("a hold guard window covers the frames the hold shows, not just the beat", () => {
  const W = 3840, H = 2160;
  const first: Beat = { id: "first", kind: "click", t0: 0, t1: 2, anchor_t: 0.5, actions: [],
    zones: [{ name: "a", type: "act", bbox: [1400, 800, 400, 300] }] };
  const second: Beat = { id: "second", kind: "click", t0: 10, t1: 12, anchor_t: 10.5, actions: [],
    zones: [{ name: "b", type: "act", bbox: [200, 200, 400, 300] }] };
  const decisions: Decision[] = [
    { beat: "first", A: "a", B: "a", L: 3, p: 0, K: 1, conf: 1, decided_by: "test" },
    { beat: "second", A: "b", B: "b", L: 3, p: 0, K: 1, conf: 1, decided_by: "test" },
  ];
  const d = { ...DEFAULTS, outro_s: 0 };
  const take = { width: W, height: H, trim_end: 13 };
  // Content shown at 5 s: the tight first framing cuts it, so it may only be
  // accepted while the guard's window still ends before that content paints.
  const shown = (_v: { x: number; y: number; w: number; h: number }, _at: number, until: number): number =>
    until > 5 && _v.w < 2000 ? 1 : 0;
  const tight = solveCamera([first, second], decisions, take, d, undefined, () => 0)
    .filter((f) => f.t >= 3 && f.t <= 8);
  assert.ok(tight.length > 20, "sample the first hold");
  assert.ok(tight.every((f) => f.w < 2000), "control: the tight first framing is reachable");
  const guarded = solveCamera([first, second], decisions, take, d, undefined, shown)
    .filter((f) => f.t >= 3 && f.t <= 8);
  assert.ok(guarded.length > 20, "sample the guarded first hold");
  assert.ok(guarded.every((f) => f.w >= 2000),
    `the first hold must widen for content shown during it (${guarded.map((f) => f.w.toFixed(0)).slice(0, 3).join(",")}...)`);
});

// Rate limiting, preparation deferral and stale-drag skips drop planned targets
// after their guard windows are computed, so a dropped target must not end the
// preceding hold's window: each window derives from the emitted move graph.
// The wide take drops a full-width preparation hold past its deferral limit and
// two mid-sequence targets past the rate cap; the portrait take's drag leaves
// its mid-drag click (and the grab) stale. Every emitted hold then sits inside
// its guard window, and the window still bites: the extended hold widens for
// content painted mid-hold, where the unguarded control stays tight.
test("dropped targets leave every emitted hold inside its guard window", () => {
  const initialDefaults = { ...DEFAULTS, out_w: 1080, out_h: 1920, outro_s: 0 };
  const initialTake = { width: 3840, height: 2160, trim_start: 1, trim_end: 10 };
  const centered: Beat = { id: "centered", kind: "click", t0: 2, t1: 4, anchor_t: 3,
    actions: [], zones: [{ name: "center", type: "act", bbox: [1600, 800, 640, 560] }] };
  const centeredDecisions: Decision[] = [{ beat: "centered", A: "center", L: 3, p: 0, K: 1,
    conf: 1, decided_by: "test" }];
  const rest = toFrame({ cx: 1920, cy: 1080, z: 1 }, 3840, 2160, initialDefaults);
  const lateText = (v: { x: number; y: number; w: number; h: number }, at: number, until: number) =>
    at <= 6 && until >= 6 && Math.abs(v.x - rest.x) < 20 ? 1 : 0;
  const unguardedInitial = solveCameraDetailed([centered], centeredDecisions, initialTake, initialDefaults);
  assert.equal(unguardedInitial.holds.length, 1, "the centered target leaves only the implicit initial hold");
  assert.ok(unguardedInitial.frames.some(f => lateText(f, f.t + 1, f.t + 1) > 0),
    "control: later text cuts the unchanged initial viewport");
  for (const beats of [[], [centered]]) {
    const guardedInitial = solveCameraDetailed(beats, beats.length ? centeredDecisions : [],
      initialTake, initialDefaults, undefined, lateText);
    const initial = guardedInitial.holds[0]!;
    assert.equal(initial.t, initialTake.trim_start);
    assert.equal(initial.moveStart, initialTake.trim_start);
    assert.ok(initial.until >= (guardedInitial.holds[1]?.moveStart ?? initialTake.trim_end));
    for (const f of guardedInitial.frames) {
      assert.equal(lateText(f, f.t + 1, f.t + 1), 0, "later text must not cut a held viewport");
    }
    assert.equal(lateText(guardedInitial.frames[0]!, 1, 10), 0,
      "the initial framing uses the extended mask, not just its arrival");
  }
  const d = { ...DEFAULTS, outro_s: 0 };
  const click = (id: string, anchor: number, bbox: Zone["bbox"]): Beat => ({
    id, kind: "click", t0: anchor - 0.5, t1: anchor + 1, anchor_t: anchor, actions: [],
    zones: [{ name: `${id}-z`, type: "act", bbox }],
  });
  const decide = (beaten: Beat[], K: 0 | 1 | 2 = 1): Decision[] => beaten.map((b) => ({
    beat: b.id, A: b.zones[0]!.name, L: 3, p: 0, K, conf: 1, decided_by: "test",
  }));
  const wideBeats = [
    click("b0", 2, [200, 900, 180, 120]),
    click("bv", 3.5, [0, 900, 3840, 200]),
    click("b1", 5.2, [900, 900, 180, 120]),
    click("b2", 6.8, [1600, 900, 180, 120]),
    click("b3", 8.4, [2300, 900, 180, 120]),
    click("b4", 10, [3000, 900, 180, 120]),
    click("b5", 11.6, [3400, 900, 180, 120]),
  ];
  const wideDecisions = decide(wideBeats).map((decided) =>
    ["bv", "b4", "b5"].includes(decided.beat) ? { ...decided, K: 2 as const } : decided);
  const wideTake = { width: 3840, height: 2160, trim_end: 14 };
  const drag: Beat = { id: "g", kind: "drag", t0: 2, t1: 4.7, anchor_t: 2.4,
    actions: [{ k: "drag", t0: 2200, t1: 4500, from: [1500, 1050], to: [2200, 1050],
      bbox: [1480, 1030, 60, 60], whole_object: [1480, 1030, 60, 60] }],
    zones: [{ name: "surf", type: "act", bbox: [1480, 1030, 60, 60] }] };
  const portraitBeats = [
    click("c1", 2, [1000, 900, 180, 120]),
    drag,
    click("v", 3.6, [2700, 900, 180, 120]),
    click("c2", 6.5, [3400, 900, 180, 120]),
  ];
  const portraitDecisions: Decision[] = portraitBeats.map((b) => ({
    beat: b.id, A: b.id === "g" ? "surf" : `${b.id}-z`, L: 3, p: 0, K: 1, conf: 1, decided_by: "test",
  }));
  const portraitTake = { width: 3840, height: 2160, trim_end: 10 };
  const portraitDefaults = { ...d, out_w: 1080, out_h: 1920 };
  const carriedView = solveCameraDetailed(portraitBeats, portraitDecisions, portraitTake,
    portraitDefaults, undefined, () => 0);
  const at = (t: number) => carriedView.frames[Math.round(t * portraitDefaults.fps)]!;
  assert.ok(at(2.2).w < portraitTake.width, "the drag must run in a crop-to-fill export");
  for (const t of [2.5, 3, 3.5, 4, 4.5]) {
    assert.ok(Math.abs(at(t).x - at(2.2).x - 700 * (t - 2.2) / 2.3) < 1,
      `the viewport must carry the dragged surface at t=${t}`);
  }
  for (const t of [4.6, 4.8, 5]) {
    assert.ok(Math.abs(at(t).x - at(4.5).x) < 12, "release holds the drop instead of chasing a stale target");
  }
  assert.ok(at(7.5).x > at(5).x + 100, "a fresh post-release target still moves the camera");
  const withoutCarry = solveCameraDetailed(portraitBeats.map(b => b === drag ? { ...b, actions: [] } : b),
    portraitDecisions, portraitTake, portraitDefaults, undefined, () => 0);
  assert.ok(withoutCarry.holds.some(h => Math.abs(h.t - 3.5) < 0.05),
    "control: the mid-drag target emits when there is no carry to make it stale");
  // Dropped draft arrivals: the full-width strip (deferral) and two capped
  // mids on wide; the grab, the drag shot and the mid-drag click on portrait.
  const takes = [
    { beats: wideBeats, decisions: wideDecisions, take: wideTake, defaults: d, paint: 5, dropped: [3.4, 5.1, 6.7, 8.3] },
    { beats: portraitBeats, decisions: portraitDecisions, take: portraitTake, defaults: portraitDefaults,
      paint: 4, dropped: [2.2, 2.5, 3.5] },
  ];
  for (const { beats, decisions, take, defaults, paint, dropped } of takes) {
    // Content painted mid-hold constrains only framings whose window reaches it.
    const probe = (v: { x: number; y: number; w: number; h: number }, _at: number, until: number): number =>
      until > paint && v.w < 2000 ? 1 : 0;
    const { frames, holds } = solveCameraDetailed(beats, decisions, take, defaults, undefined, probe);
    assert.ok(holds.length >= 2, `a next emitted move must exist to end the first hold (${take.width}x${take.height})`);
    // Each hold's window reaches the next emitted move (or the take end),
    // passing over the dropped arrivals on the way.
    holds.forEach((h, i) => {
      const next = holds[i + 1]?.moveStart ?? take.trim_end;
      assert.ok(h.until >= next,
        `hold t=${h.t.toFixed(2)} window ${h.until.toFixed(2)} ends before the next move ${next.toFixed(2)}`);
    });
    for (const t of dropped) {
      assert.ok(holds.every((h) => Math.abs(h.t - t) > 0.05),
        `draft t=${t} emitted a hold: the drop sequence did not fire (${take.width}x${take.height})`);
      assert.ok(holds.some((h) => h.moveStart <= t && h.until >= t),
        `no emitted move/hold interval covers the dropped arrival t=${t}`);
    }
    // The window masks the frames the hold displays.
    holds.forEach((h, i) => {
      const next = holds[i + 1]?.moveStart ?? take.trim_end;
      const shown = frames.filter((f) => f.t >= h.moveStart && f.t < next);
      assert.ok(shown.length > 0, `hold t=${h.t.toFixed(2)} displays no frames`);
      for (const f of shown) {
        assert.ok(f.t <= h.until, `hold t=${h.t.toFixed(2)} shows t=${f.t.toFixed(2)} past its window ${h.until.toFixed(2)}`);
      }
    });
  }
  // The guard is not inert: the wide take's extended first hold widens for
  // the painted content, while the unguarded control stays tight.
  const tight = solveCamera(wideBeats, wideDecisions, wideTake, d, undefined, () => 0)
    .filter((f) => f.t >= 3 && f.t <= 8);
  assert.ok(tight.length > 20 && tight.every((f) => f.w < 2000), "control: the extended hold is reachable tight");
  const paint = (_v: { x: number; y: number; w: number; h: number }, _at: number, until: number): number =>
    until > 5 && _v.w < 2000 ? 1 : 0;
  const guarded = solveCamera(wideBeats, wideDecisions, wideTake, d, undefined, paint)
    .filter((f) => f.t >= 3 && f.t <= 8);
  assert.ok(guarded.length > 20, "sample the guarded extended hold");
  assert.ok(guarded.every((f) => f.w >= 2000),
    `the extended hold must widen for content painted mid-hold (${guarded.map((f) => f.w.toFixed(0)).slice(0, 3).join(",")}...)`);
});

// The stage margin fade used to clamp a hairline matte to a fixed width, so the
// projected viewport jumped a whole matte wider at the zoom where the margin
// reached zero. The projection must stay continuous through the push-in (the
// solver moves a framing that would rest in the hairline band instead).
test("the stage viewport stays continuous through a push-in", () => {
  const st = stageGeometry(3840, 2160, DEFAULTS);
  const aspect = DEFAULTS.out_w / DEFAULTS.out_h;
  const widths = Array.from({ length: 600 }, (_, i) => 3800 - i * 3);
  const views = widths.map((w) => stageFrames([{ t: 0, x: (3840 - w) / 2, y: (2160 - w / aspect) / 2, w, h: w / aspect }],
    3840, 2160, st, DEFAULTS)[0]!);
  for (let i = 1; i < views.length; i++) {
    assert.ok(Math.abs(views[i]!.w - views[i - 1]!.w) < 4.5,
      `stage viewport jumped ${views[i - 1]!.w} -> ${views[i]!.w} at source width ${widths[i]}`);
  }
});

// A framing whose projected margin lands under minStageMargin is snapped onto the
// card or onto a readable margin, and the snapped view is re-judged by the guard:
// the emitted hold must pass the same cut predicate the search used.
test("a held framing moved off a hairline matte still passes the cut guard", () => {
  const W = 3840, H = 2160;
  const st = stageGeometry(W, H, DEFAULTS);
  const project = (f: CameraFrame) => sourceViewport(f, W, H, st, DEFAULTS);
  const min = minStageMargin(W, DEFAULTS);
  const band = (w: number) => w > W && w < W + 2 * min;
  // Dense ink in a left column band: snapping this hold to the card parks its left
  // edge inside the words, so the guard must reject that snap.
  const grey = new Uint8Array(W * H);
  for (let y = 900; y < 1300; y++) for (let x = 24; x < 520; x++) grey[y * W + x] = (y % 4) < 2 ? 255 : 0;
  const mask = edgeCuts([grey], W, H, 0);
  const cuts = (v: { x: number; y: number; w: number; h: number }): number => cutCount(mask(v));
  const state = frame({ name: "z", type: "act", bbox: [330, 700, 3230, 1000] }, 1, W, H, undefined, DEFAULTS, project, cuts);
  const view = project(toFrame(state, W, H, DEFAULTS));
  assert.ok(!band(view.w), `emitted hold rests on a hairline matte (${view.w.toFixed(1)} px wide)`);
  assert.equal(cutCount(mask(view)), 0, `emitted hold cuts the guard's own text at ${JSON.stringify(view)}`);
});

test("a crop with no zoom headroom and no clean edge settles instead of hanging", () => {
  // A 1080p source in a 4:5 export cannot zoom (zMax 1) and here every edge cuts text.
  // Run in a child: on a hang, a synchronous loop would block this runner's own timeout.
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { DEFAULTS } from ${JSON.stringify(new URL("../src/camera/defaults.ts", import.meta.url).href)};
    import { frame, zMax } from ${JSON.stringify(new URL("../src/camera/solver.ts", import.meta.url).href)};
    import { sourceViewport, stageGeometry } from ${JSON.stringify(new URL("../src/render/stage.ts", import.meta.url).href)};
    const d = { ...DEFAULTS, out_w: 1080, out_h: 1350 };
    const stage = stageGeometry(1920, 1080, d);
    const project = (f) => sourceViewport(f, 1920, 1080, stage, d);
    const z = { name: "save", type: "act", bbox: [800, 500, 200, 80] };
    console.log(JSON.stringify({ top: zMax(1920, 1080, d), state: frame(z, 2, 1920, 1080, undefined, d, project, () => 1) }));
  `], { encoding: "utf8", timeout: 30_000 });
  assert.equal(child.signal, null, "frame() did not return within 30 s");
  assert.equal(child.status, 0, child.stderr);
  const { top, state } = JSON.parse(child.stdout);
  assert.equal(top, 1);
  assert.equal(state.z, 1);
});

// A variable-rate screen recording ends at its last change, but the take's clock runs on past it:
// the text guard must sample the last frame there, not warn that the source would not decode.
test("text guard samples the last frame of a recording that ends before the take", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "takeone:guard-tail-"));
  const warnings: string[] = [];
  const warn = console.warn;
  try {
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=320x180:r=10:d=3",
      "-c:v", "mpeg4", "-q:v", "2", "-f", "matroska", "-y", join(dir, "screen.webm")]);
    const meta = { id: "guard-tail", width: 320, height: 180 } as Parameters<typeof sourceEdgeCuts>[1];
    console.warn = (message: string) => { warnings.push(message); };
    const cuts = sourceEdgeCuts(dir, meta, (t) => t + 2.5);
    assert.ok(cuts, "the recording exists, so the guard runs");
    assert.equal(typeof cuts({ x: 0, y: 0, w: 320, h: 180 }, 1, 2), "number");
    assert.deepEqual(warnings, [], "a time past the last frame must not switch the guard off");
  } finally {
    console.warn = warn;
    await rm(dir, { recursive: true, force: true });
  }
});

// The safe-area gate judges the text each frame paints. A push-in crops the screen card, so a
// box the crop hides or cuts is not text in the outer 5% of the output; text the frame paints
// there is, and must still stop the render. One journey, both ways, through the real renderer.
test("the safe-area gate judges the text a push-in paints", { timeout: 120_000 }, async () => {
  // New tests cannot declare the needsFfmpeg skip (the floor guard blocks new skips).
  if (!hasFfmpeg()) throw new Error("requires system ffmpeg and ffprobe on PATH");
  // A 2x source held at the upscale ceiling crops 320x180 source px into the 320x180 output;
  // the trim starts inside the hold, so the camera is settled and the crop does not move.
  const render = async (title: string | undefined, boxes: [number, number, number, number, string][]) => {
    const dir = await mkdtemp(join(tmpdir(), "takeone:safe-area-"));
    await mkdir(join(dir, "analysis"));
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=navy:s=640x360:r=30:d=4",
      "-c:v", "mpeg4", "-q:v", "2", "-f", "matroska", "-y", join(dir, "screen.webm")]);
    await writeFile(join(dir, "take.json"), JSON.stringify({ id: "safe-area", width: 640, height: 360,
      trim_start: 2, trim_end: 3.2, ...(title ? { title } : {}),
      zooms: [{ t0: 0.3, t1: 3.5, bbox: [440, 60, 120, 90], level: 3 }] }));
    await writeFile(join(dir, "analysis/beats.json"), "[]");
    await writeFile(join(dir, "analysis/decisions.jsonl"), "");
    await writeFile(join(dir, "text-boxes.json"), JSON.stringify({ space: "stream px", clock: "video s",
      samples: [{ t: 0, boxes }] }));
    return dir;
  };
  const cut = [500, 10, 60, 12, "cut by the crop"] as [number, number, number, number, string];
  // A title keeps the screen card inside the output inset: the box's top rows fall on the
  // background ring above the card, so the render must pass, and the box the crop hides must
  // not even be counted.
  const titled = await render("Board demo", [cut, [60, 60, 80, 12, "hidden by the crop"]]);
  try {
    await renderTake(titled, FAST);
    const report = JSON.parse(await readFile(join(titled, "safe-area.json"), "utf8"));
    assert.equal(report.failures.length, 0);
    assert.equal(report.checked, 74, "one shown box across the held frames, and no placement for the hidden one");
  } finally { await rm(titled, { recursive: true, force: true }); }
  // Without a title the card fills the frame, so the same box is painted in the outer 5%.
  const untitled = await render(undefined, [cut]);
  try {
    await assert.rejects(renderTake(untitled, FAST), /safe area: 73 text box placements cross the 5% inset .* "cut by the crop"/);
    assert.ok(JSON.parse(await readFile(join(untitled, "safe-area.json"), "utf8")).failures.length);
  } finally { await rm(untitled, { recursive: true, force: true }); }
});

test("a planner shot=false on a click beat removes its camera move", () => {
  const click: Beat = { id: "b1", t0: 3, t1: 6, anchor_t: 4, kind: "click", zones: [zone("z1", [1500, 900, 300, 200])],
    actions: [{ k: "click", t: 4000, x: 1650, y: 1000, window_cls: "x" } as Action] };
  const take = { width: 3840, height: 2160, trim_end: 9 } as Parameters<typeof solveCamera>[2];
  const moves = (decided: Decision) => solveCamera([click], [decided], take, DEFAULTS)
    .filter((f) => f.w < take.width - 1).length;
  assert.ok(moves(decision(click)) > 0, "the rules move the camera for a click");
  assert.equal(moves({ ...decision(click), shot: false }), 0);
});
