import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "../src/camera/defaults.ts";
import { solveCamera } from "../src/camera/solver.ts";
import type { Beat, TakeMeta } from "../src/camera/types.ts";
import { editBeats, editTimeline, editZooms, validateEdits } from "../src/render/edits.ts";
import { renderTake } from "../src/render/render.ts";
import { hasFfmpeg } from "./helpers.ts";

const d = { ...DEFAULTS, idle_speed: 1, out_w: 320, out_h: 180, caption_size: 14, fade_s: 0, preset: "ultrafast" };
const meta: TakeMeta = { id: "edits", width: 640, height: 360, trim_start: 1, trim_end: 11 };
const beat: Beat = { id: "typing", kind: "type", t0: 1, t1: 11, anchor_t: 2, zones: [
  { name: "all", type: "all", bbox: [0, 0, 640, 360] },
  { name: "field", type: "txt", bbox: [280, 120, 120, 40], t_change: 8 },
], actions: [
  { k: "click", t: 2000, x: 320, y: 150 },
  { k: "click", t: 5000, x: 320, y: 150 },
  { k: "type", t0: 3000, t1: 9000 },
] };
const decision = { beat: beat.id, A: "all", L: 0 as const, K: 1 as const, p: 0, conf: 1, decided_by: "heuristic" };

test("cut, region speed, typing speed and idle speed share one clock with explicit precedence", () => {
  const take = { ...meta, cuts: [{ t0: 4, t1: 6 }], speed: [
    { kind: "type_speed" as const, rate: 3 }, { t0: 7, t1: 9, rate: 0.5 },
  ] };
  const clock = editTimeline(take, [beat], 1, 11, d);
  // 1..3 normal, 3..4 type 3x, 4..6 cut, 6..7 type 3x,
  // 7..9 explicit half speed, 9..11 normal.
  assert.ok(Math.abs(clock.duration - (8 + 2 / 3)) < 1e-10);
  assert.equal(clock.at(4), clock.at(6));
  assert.equal(clock.contains(5), false);
  assert.equal(clock.contains(6), true);
  const mapped = editBeats([beat], clock, 1)[0]!;
  assert.equal(mapped.actions.length, 2);
  assert.equal((mapped.actions[0] as {t:number}).t, 2000);
  assert.equal((mapped.actions[1] as {t0:number}).t0, 3000);
  assert.ok(Math.abs(mapped.zones[1]!.t_change! - (1 + clock.at(8))) < 1e-10);
  assert.deepEqual(editZooms([{ t0: 4, t1: 6, bbox: [0, 0, 10, 10] }], clock, 1), []);
  const cutAnchor = editBeats([{ ...beat, anchor_t: 5 }], clock, 1)[0]!;
  assert.equal(cutAnchor.camera_suppressed, true);
  assert.equal(cutAnchor.actions.length, 2); // retained clicks survive a removed camera anchor
  const idle = editTimeline({ ...meta, speed: [{ t0: 4, t1: 6, rate: 1 }] }, [], 1, 11, { ...d, idle_speed: 4 });
  assert.equal(idle.at(6) - idle.at(4), 2); // explicit 1x defeats idle squeeze
});

test("JSON edit errors name the offending field and reject ambiguous overlaps", () => {
  for (const [edits, field] of [
    [{ cuts: [{t0: 4, t1: 2}] }, "cuts"], [{ cuts: [{t0: 1, t1: 4}, {t0: 3, t1: 5}] }, "cuts"],
    [{ speed: [{t0: 1, t1: 2, rate: 0}] }, "speed"],
    [{ speed: [{t0: 1, t1: 2, rate: Infinity}] }, "speed"],
    [{ speed: [{kind: "type_speed", rate: 3}, {kind: "type_speed", rate: 2}] }, "speed"],
    [{ zooms: [{t0: 1, t1: 3, bbox: [600, 0, 100, 50]}] }, "zooms"],
    [{ zooms: [{t0: 1, t1: 3, bbox: [0, 0, 100, 50], level: 4}] }, "zooms"],
  ] as const) assert.throws(() => validateEdits({ ...meta, ...edits } as unknown as TakeMeta), new RegExp(field));
  assert.throws(() => editTimeline({ ...meta, cuts: [{t0: 0, t1: 20}] }, [], 1, 11, d), /no footage remains/);
});

test("manual region zoom interrupts FOLLOW, holds its framing, then resumes the auto camera", () => {
  const take = { ...meta, trim_start: 0, trim_end: 12,
    zooms: [{ t0: 2, t1: 7, bbox: [250, 130, 140, 60] as [number,number,number,number], level: 3 as const }] };
  const automatic = solveCamera([beat], [decision], take, d);
  const held = automatic[Math.round(5 * d.fps)]!;
  assert.ok(held.w < 450, `manual viewport width ${held.w}`);
  assert.ok(Math.abs(held.x + held.w / 2 - 320) < 1);
  const end = automatic.at(-1)!;
  assert.ok(end.w > 630, `automatic viewport resumes: ${end.w}`);
  const frames = solveCamera([{ ...beat, kind: "drag", actions: [{k:"ptr", t:5000, x:630, y:300}] }], [decision], take, d);
  assert.deepEqual(frames[Math.round(5 * d.fps)], held);
  for (const f of frames) assert.ok(d.out_w / f.w <= d.max_upscale + 1e-8);
});

test("manual zoom pre-rolls to its region and rejects holds shorter than 0.5 seconds", () => {
  const requested = { t0: 2, t1: 2.6, bbox: [250, 130, 140, 60] as [number,number,number,number], level: 3 as const };
  const take = { ...meta, trim_start: 0, trim_end: 8, zooms: [requested] };
  const frames = solveCamera([], [], take, d);
  const requestedFrame = frames[Math.round(requested.t0 * d.fps)]!;
  assert.ok(requestedFrame.w < 250, `requested region reached by t0: ${requestedFrame.w}`);
  assert.ok(Math.abs(requestedFrame.x + requestedFrame.w / 2 - 320) < 2);
  for (const frame of frames.slice(2 * d.fps, 2.6 * d.fps)) {
    assert.ok(frame.w < 250, `manual framing held through t1: ${frame.w}`);
  }
  assert.throws(() => solveCamera([], [], { ...take, zooms: [{ ...requested, t1: 2.49 }] }, d), /0.5s hold/);
});

test("wide source in portrait establishes then crops to an active region within one second", () => {
  const action = { ...beat, t0: 0, t1: 8, anchor_t: 5 };
  const portrait = { ...d, out_w: 180, out_h: 320, establish_s: 2, outro_s: 0 };
  const frames = solveCamera([action], [decision], { width: 640, height: 360, trim_end: 8 }, portrait);
  assert.ok(frames[0]!.w >= 639, `starts with wide establish: ${frames[0]!.w}`);
  assert.ok(frames[59]!.w < 500, `active crop reached by 1s: ${frames[59]!.w}`);
  assert.ok(frames.every(frame => 180 / frame.w <= portrait.max_upscale + 1e-8));
});

test("ffmpeg applies cuts and speed to actual pixels and timestamps", { skip: !hasFfmpeg() }, () => {
  const clock = editTimeline({ ...meta, cuts: [{t0:4,t1:6}], speed: [{t0:6,t1:10,rate:2}] }, [], 1, 11, d);
  // Source frames encode the absolute source second in their luma. At output
  // second 3, seconds 4 and 5 must have disappeared and second 6 must be visible.
  const pixels = execFileSync("ffmpeg", ["-v","error","-f","lavfi","-i",
    "nullsrc=s=16x16:r=60:d=12,geq=lum='20+10*T':cb=128:cr=128", "-vf",
    `trim=start=1:end=11,${clock.filter},fps=60,format=gray`, "-t",String(clock.duration),"-f","rawvideo","-"], {maxBuffer:2_000_000});
  assert.equal(pixels.length / 256, Math.round(clock.duration * 60));
  const luma = (t: number) => pixels[Math.round(t * 60) * 256]!;
  // range conversion to gray raises video luma; compare expected relative values.
  assert.ok(luma(3.1) > luma(2.9) + 15, "removed source seconds do not leave a held frame");
  assert.ok(luma(4.1) > luma(3.1) + 20, "2x segment advances two source seconds");
});

test("render reruns edits from take.json, preserves captions reading time and is deterministic", { skip: !hasFfmpeg() }, async () => {
  mkdirSync(join(process.cwd(), "tmp"), {recursive:true});
  const dir = mkdtempSync(join(process.cwd(), "tmp/edits-test-"));
  try {
    execFileSync("ffmpeg", ["-y","-v","error","-f","lavfi","-i","testsrc2=s=640x360:r=60:d=12",
      "-c:v","libvpx-vp9","-deadline","realtime","-cpu-used","8",join(dir,"screen.webm")]);
    mkdirSync(join(dir,"analysis"));
    writeFileSync(join(dir,"analysis/beats.json"), JSON.stringify([beat]));
    writeFileSync(join(dir,"analysis/decisions.jsonl"), JSON.stringify(decision));
    writeFileSync(join(dir,"take.json"), JSON.stringify({ ...meta, cuts: [{t0:4,t1:6}],
      speed: [{kind:"type_speed",rate:2}], zooms: [{t0:6,t1:10,bbox:[240,100,160,80]}],
      captions: [{t:5,text:"Removed"},{t:6,d:3,text:"Keep reading"}] }));
    const result = await renderTake(dir,d);
    const bytes = readFileSync(result.out);
    assert.equal(result.seconds,6);
    const probe = JSON.parse(execFileSync("ffprobe",["-v","error","-count_frames","-show_streams","-of","json",result.out],{encoding:"utf8"}));
    assert.equal(Number(probe.streams[0].nb_read_frames),360);
    assert.equal(probe.streams[0].color_space,"bt709");
    const emitted = readFileSync(join(dir,"captions.ass"),"utf8");
    assert.ok(!emitted.includes("Removed"));
    assert.match(emitted, /Dialogue: 3,0:00:02\.50,0:00:05\.50,.*Keep reading/);
    const frames = JSON.parse(readFileSync(join(dir,"camera.json"),"utf8"));
    assert.equal(frames.length,361);
    const rerun = await renderTake(dir,d);
    assert.deepEqual(readFileSync(rerun.out),bytes);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test("deep manual zooms obey the zoom speed and acceleration budgets", () => {
  const take:TakeMeta={width:3840,height:2160,trim_end:14,
    zooms:[{t0:1,t1:9,bbox:[1600,800,500,300],level:3}]};
  const frames=solveCamera([],[],take,DEFAULTS);
  let previousSpeed=0;
  for(let i=1;i<frames.length;i++){
    const dt=frames[i]!.t-frames[i-1]!.t;
    const speed=Math.log(frames[i-1]!.w/frames[i]!.w)/dt;
    assert.ok(Math.abs(speed)<=1,`zoom speed ${speed}`);
    if(i>1)assert.ok(Math.abs(speed-previousSpeed)/dt<=4,`zoom acceleration ${(speed-previousSpeed)/dt}`);
    previousSpeed=speed;
  }
});
