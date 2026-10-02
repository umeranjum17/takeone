import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "../src/camera/defaults.ts";
import { baseWidth, manualZoomLimitWarning, solveCamera } from "../src/camera/solver.ts";
import type { Beat, TakeMeta } from "../src/camera/types.ts";
import { editBeats, editTimeline, editZooms, validateEdits } from "../src/render/edits.ts";
import { measureCaptions, renderTake } from "../src/render/render.ts";
import { bandFrames, bandLayout, bandText, takeCaptions, stageFrames, stageGeometry } from "../src/render/stage.ts";
import { cameraMetrics } from "../scripts/quality.ts";
import { gestures, gestureZone } from "../src/camera/gesture.ts";
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
  assert.ok(requestedFrame.x <= requested.bbox[0]
    && requestedFrame.x + requestedFrame.w >= requested.bbox[0] + requested.bbox[2],
  `requested region is framed by t0: ${requestedFrame.x}, ${requestedFrame.w}`);
  for (const frame of frames.slice(2 * d.fps, 2.6 * d.fps)) {
    assert.ok(frame.x <= requested.bbox[0]
      && frame.x + frame.w >= requested.bbox[0] + requested.bbox[2],
    `manual framing held through t1: ${frame.x}, ${frame.w}`);
  }
  assert.throws(() => solveCamera([], [], { ...take, zooms: [{ ...requested, t1: 2.49 }] }, d), /0.5s hold/);
});

test("manual anticipation stays inside clip boundaries and reports feasible arrival", () => {
  const portrait = { ...d, out_w: 180, out_h: 320, outro_s: 0 };
  for (const t0 of [1, 5]) {
    const zoom = { t0, t1: 8, bbox: [250, 110, 160, 90] as [number,number,number,number], level: 3 as const };
    const timing = { cuts: [], arrivals: [] as import("../src/camera/solver.ts").CameraArrival[] };
    const frames = solveCamera([], [], { width: 640, height: 360, trim_end: 9, zooms: [zoom] }, portrait, timing);
    const arrival = timing.arrivals[0]!;
    assert.equal(frames[0]!.t, 0);
    assert.ok(frames[0]!.w >= 639, "never fabricate motion before the clip");
    assert.equal(arrival.boundary, 0);
    assert.ok(arrival.feasibleStart >= arrival.boundary);
    if (t0 === 1) assert.ok(arrival.lateness > 0);
    else assert.equal(arrival.lateness, 0);
    const attained = frames[Math.ceil(arrival.actualArrival * portrait.fps)]!;
    const held = frames[7 * portrait.fps]!;
    assert.ok(attained.w <= held.w * 1.1, "requested framing reached at reported arrival");
    const stage = stageGeometry(640, 360, portrait);
    const metrics = cameraMetrics(stageFrames(frames, 640, 360, stage, portrait),60,180,320,portrait.min_shot);
    assert.ok(metrics.zoom_speed!.value <= 1);
    assert.ok(metrics.zoom_acceleration!.value <= 4);
    assert.ok(metrics.pan_acceleration!.value <= 9000);
  }
  const timing = { cuts: [2], arrivals: [] as import("../src/camera/solver.ts").CameraArrival[] };
  solveCamera([], [], {width:640,height:360,trim_end:9,zooms:[{t0:3,t1:8,bbox:[250,110,160,90],level:3}]},portrait,timing);
  assert.equal(timing.arrivals[0]!.boundary, 2);
  assert.equal(timing.arrivals[0]!.feasibleStart, 2);
  assert.ok(timing.arrivals[0]!.lateness > 0);
});

test("square 4K manual zoom moves to the native upscale boundary after stage padding", () => {
  const square4k = { ...DEFAULTS, out_w: 3840, out_h: 3840, max_upscale: 1.5 };
  const take = { width: 2560, height: 1440, trim_end: 8,
    zooms: [{ t0: 2, t1: 6, bbox: [940, 430, 680, 640] as [number, number, number, number], level: 3 as const }] };
  const sourceFrames = solveCamera([], [], take, square4k);
  const stage = stageGeometry(take.width, take.height, square4k);
  const frames = stageFrames(sourceFrames, take.width, take.height, stage, square4k);
  const metrics = cameraMetrics(frames, square4k.fps, square4k.out_w, square4k.out_h, square4k.min_shot);
  assert.ok(frames[0]!.w > frames[2 * square4k.fps]!.w,
    `manual zoom changes visible viewport ${frames[0]!.w} -> ${frames[2 * square4k.fps]!.w}`);
  assert.ok(metrics.max_upscale!.value <= 1.5, `visible viewport upscale ${metrics.max_upscale!.value}`);
  assert.ok(metrics.zoom_speed!.value <= 1, `visible zoom speed ${metrics.zoom_speed!.value}`);
  assert.ok(metrics.zoom_acceleration!.value <= 4, `visible zoom acceleration ${metrics.zoom_acceleration!.value}`);
  assert.ok(metrics.pan_acceleration!.value <= 9000, `visible pan acceleration ${metrics.pan_acceleration!.value}`);
  assert.match(manualZoomLimitWarning(take, square4k) ?? "", /requested .*x, achieved 1\.11x/);
});

test("wide source in portrait establishes then crops to an active region within one second", () => {
  const action = { ...beat, t0: 0, t1: 8, anchor_t: 5 };
  const portrait = { ...d, out_w: 180, out_h: 320, establish_s: 2, outro_s: 0 };
  const frames = solveCamera([action], [decision], { width: 640, height: 360, trim_end: 8 }, portrait);
  assert.ok(frames[0]!.w >= 639, `starts with wide establish: ${frames[0]!.w}`);
  assert.ok(frames[59]!.w < 500, `active crop reached by 1s: ${frames[59]!.w}`);
  assert.ok(frames.every(frame => 180 / frame.w <= portrait.max_upscale + 1e-8));
  const stage = stageGeometry(640, 360, portrait);
  const staged = stageFrames(frames, 640, 360, stage, portrait);
  const metrics = cameraMetrics(staged, portrait.fps, portrait.out_w, portrait.out_h, portrait.min_shot);
  assert.ok(metrics.max_upscale!.value <= 1.5, `portrait upscale ${metrics.max_upscale!.value}`);
  assert.ok(metrics.zoom_speed!.value <= 1, `portrait visible zoom speed ${metrics.zoom_speed!.value}`);
  assert.ok(metrics.zoom_acceleration!.value <= 4,
    `portrait visible zoom acceleration ${metrics.zoom_acceleration!.value}`);
  assert.ok(metrics.pan_acceleration!.value <= 9000,
    `portrait visible pan acceleration ${metrics.pan_acceleration!.value}`);
  const active = { x: 280 + stage.screenX, y: 120 + stage.screenY, w: 120, h: 40 };
  for (const frame of staged.slice(3 * portrait.fps, 6 * portrait.fps)) {
    assert.ok(frame.x <= active.x && frame.x + frame.w >= active.x + active.w,
      `portrait viewport keeps the active region horizontally: ${frame.x}, ${frame.w}`);
    assert.ok(frame.y <= active.y && frame.y + frame.h >= active.y + active.h,
      `portrait viewport keeps the active region vertically: ${frame.y}, ${frame.h}`);
  }
});

test("portrait manual zoom holds the requested region in the padded stage", () => {
  const portrait = { ...d, out_w: 180, out_h: 320, outro_s: 0 };
  const zoom = { t0: 2, t1: 6, bbox: [250, 110, 160, 90] as [number,number,number,number], level: 2 as const };
  const frames = solveCamera([], [], { width: 640, height: 360, trim_end: 8, zooms: [zoom] }, portrait);
  const camera = frames[Math.round(3 * portrait.fps)]!;
  assert.ok(camera.x <= zoom.bbox[0] && camera.x + camera.w >= zoom.bbox[0] + zoom.bbox[2]);
  assert.ok(camera.y <= zoom.bbox[1] && camera.y + camera.h >= zoom.bbox[1] + zoom.bbox[3]);
  const stage = stageGeometry(640, 360, portrait);
  const [staged] = stageFrames([camera], 640, 360, stage, portrait);
  assert.ok(staged!.x <= stage.screenX + zoom.bbox[0]);
  assert.ok(staged!.x + staged!.w >= stage.screenX + zoom.bbox[0] + zoom.bbox[2]);
  assert.ok(staged!.y <= stage.screenY + zoom.bbox[1]);
  assert.ok(staged!.y + staged!.h >= stage.screenY + zoom.bbox[1] + zoom.bbox[3]);
});

test("portrait stage mapping stays continuous as the crop reaches screen fill", () => {
  const portrait = { ...d, out_w: 180, out_h: 320, outro_s: 0 };
  const stage = stageGeometry(640, 360, portrait);
  const fill = 360 * portrait.out_w / portrait.out_h;
  const frames = Array.from({ length: 7 }, (_, i) => {
    const w = fill * (1.1 + (3 - i) * 0.0001);
    const h = w / (portrait.out_w / portrait.out_h);
    return { t: i / portrait.fps, x: 320 - w / 2, y: 180 - h / 2, w, h };
  });
  const staged = stageFrames(frames, 640, 360, stage, portrait);
  const metrics = cameraMetrics(staged, portrait.fps, portrait.out_w, portrait.out_h, portrait.min_shot);
  assert.ok(metrics.zoom_speed!.value <= 1, `stage zoom speed ${metrics.zoom_speed!.value}`);
  assert.ok(metrics.zoom_acceleration!.value <= 4, `stage zoom acceleration ${metrics.zoom_acceleration!.value}`);
});

test("portrait stage crop keeps its aspect while crossing the source-fill boundary", () => {
  const portrait = { ...DEFAULTS, out_w: 1080, out_h: 1920 };
  const width = 2560, height = 1440, aspect = portrait.out_w / portrait.out_h;
  const fill = height * aspect;
  const stage = stageGeometry(width, height, portrait);
  const frames = [1.0998, 1.0999, 1.1, 1.1001, 1.1002].map((ratio, i) => {
    const w = fill * ratio, h = w / aspect;
    return { t: i / portrait.fps, x: width / 2 - w / 2, y: height / 2 - h / 2, w, h };
  });
  const staged = stageFrames(frames, width, height, stage, portrait);
  for (const frame of staged) {
    assert.ok(Math.abs(frame.h / frame.w - 1 / aspect) < 1e-9,
      `portrait viewport aspect ${frame.w}:${frame.h}`);
  }
  const metrics = cameraMetrics(staged, portrait.fps, portrait.out_w, portrait.out_h, portrait.min_shot);
  assert.ok(metrics.zoom_speed!.value <= 1, `stage zoom speed ${metrics.zoom_speed!.value}`);
  assert.ok(metrics.zoom_acceleration!.value <= 4, `stage zoom acceleration ${metrics.zoom_acceleration!.value}`);
  assert.ok(metrics.pan_acceleration!.value <= 9000, `stage pan acceleration ${metrics.pan_acceleration!.value}`);
});

test("stage edge clamp eases across the source-to-card boundary", () => {
  const portrait = { ...d, out_w: 180, out_h: 320 };
  const stage = stageGeometry(640, 360, portrait);
  const frames = Array.from({ length: 81 }, (_, i) => {
    const w = 600 + i;
    return { t: i / d.fps, x: -w / 2, y: 0, w, h: 180 };
  });
  const mapped = stageFrames(frames, 640, 360, stage, portrait);
  const jumps = mapped.slice(1).map((frame, i) => Math.abs(frame.x - mapped[i]!.x));
  assert.ok(Math.max(...jumps) < 10, `source-to-card edge jump ${Math.max(...jumps)}px`);
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
    const geometry = JSON.parse(readFileSync(join(dir,"render-camera.json"),"utf8"));
    const captions = takeCaptions({ ...meta, captions: [{t:6,d:3,text:"Keep reading"}] },
      t => editTimeline({ ...meta, cuts:[{t0:4,t1:6}],speed:[{kind:"type_speed",rate:2}] },[beat],1,11,d).at(t),6);
    const initial = bandText(captions,[],d);
    let ink = await measureCaptions(dir,captions,initial,true);
    const text = bandText(captions,ink,initial);
    if (text !== initial) ink = await measureCaptions(dir,captions,text,true);
    const band = bandLayout(640,360,text,captions,ink)!;
    assert.deepEqual(geometry.frames,bandFrames(frames,band,d,640,360));
    assert.deepEqual(geometry.sourceOrigin,{x:stageGeometry(640,360,d).screenX,y:stageGeometry(640,360,d).screenY});
    for (const [x,y] of [[0.5,0.025],[0.5,0.975],[0.025,0.5],[0.975,0.5]]) {
      const margin = execFileSync("ffmpeg",["-v","error","-i",result.out,"-vf",
        `crop=2:2:${Math.floor(band.stage.screenX+band.stage.baseW*x!)}:${Math.floor(band.stage.screenY+band.stage.baseH*y!)},format=gray`,
        "-frames:v","1","-f","rawvideo","-"]);
      assert.ok([...margin].every(v=>v>220),`padded card margin ${x},${y}: ${[...margin]}`);
    }
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

test("square manual zoom bounds full-path pan acceleration", () => {
  const square = { ...DEFAULTS, out_w: 1080, out_h: 1080 };
  const take: TakeMeta = { width: 2560, height: 1440, trim_end: 15,
    zooms: [{ t0: 1, t1: 8, bbox: [940, 430, 680, 640], level: 3 }] };
  const frames = solveCamera([], [], take, square);
  let previous: { x: number; y: number } | undefined;
  let peak = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]!, b = frames[i]!, dt = b.t - a.t;
    const velocity = {
      x: (b.x + b.w / 2 - a.x - a.w / 2) / dt * square.out_w / b.w,
      y: (b.y + b.h / 2 - a.y - a.h / 2) / dt * square.out_w / b.w,
    };
    if (previous) peak = Math.max(peak, Math.hypot(velocity.x - previous.x, velocity.y - previous.y) / dt);
    previous = velocity;
  }
  assert.ok(peak <= 9000, `square pan acceleration ${peak} px/s²`);
});


test("nested edited timestamps retain only surviving samples on the camera clock", () => {
  const drag: Beat = { ...beat, kind: "drag", anchor_t: 4,
    actions: [{k:"drag",t0:4000,t1:6000,from:[100,100],to:[500,250],bbox:[100,100,400,150],
      path:[{t:4500,x:200,y:150},{t:5000,x:300,y:180},{t:5500,x:400,y:200}]}],
    dialog_results:[{t:4,bbox:[100,100,100,100]},{t:5,bbox:[200,100,100,100]}] };
  const clock = editTimeline({...meta,speed:[{t0:1,t1:11,rate:2}],cuts:[{t0:5,t1:5.2}]},[drag],1,11,d);
  const mapped = editBeats([drag],clock,1)[0]!;
  const g = gestures(mapped)[0]!;
  assert.equal(g.t0,(1+clock.at(4))*1000);
  assert.equal(g.t1,(1+clock.at(6))*1000);
  assert.deepEqual(g.path!.map(p=>p.t),[4.5,5.5].map(t=>(1+clock.at(t))*1000));
  assert.deepEqual(mapped.dialog_results,[{t:1+clock.at(4),bbox:[100,100,100,100]}]);
  assert.ok(solveCamera([mapped],[decision],{width:640,height:360,trim_start:1,trim_end:1+clock.duration},d).length>0);
});

test("valid source zoom holds survive speed cuts and idle compression", () => {
  const zoom = {t0:4,t1:4.6,bbox:[250,130,140,60] as [number,number,number,number],level:2 as const};
  for (const edits of [{speed:[{t0:0,t1:8,rate:2}]},{cuts:[{t0:4.1,t1:4.5}]},{}]) {
    const take = {width:640,height:360,trim_end:8,zooms:[zoom],...edits};
    validateEdits(take);
    const clock = editTimeline(take,[],0,8,{...d,idle_speed:4});
    const zooms = editZooms(take.zooms,clock,0);
    assert.ok(zooms[0]!.t1-zooms[0]!.t0<0.5);
    const timing = {cuts:[],arrivals:[] as import("../src/camera/solver.ts").CameraArrival[],zoomClock:"output" as const};
    const frames = solveCamera([],[],{...take,zooms,trim_end:clock.duration},d,timing);
    assert.ok(frames.length>0);
    assert.equal(timing.arrivals[0]!.holdEnd,zooms[0]!.t1);
  }
  assert.throws(()=>validateEdits({width:640,height:360,zooms:[{...zoom,t1:4.3}]}),/0.5s hold/);
});

test("manual portrait whole-stage and wide rectangles remain fully visible", () => {
  const portrait = {...DEFAULTS,out_w:1080,out_h:1920,outro_s:0};
  const stage = stageGeometry(2560,1440,portrait);
  for (const zoom of [
    {t0:5,t1:10,bbox:[1100,600,100,100] as [number,number,number,number],level:0 as const},
    {t0:5,t1:10,bbox:[0,0,2560,1440] as [number,number,number,number],level:2 as const},
  ]) {
    const raw = solveCamera([],[],{width:2560,height:1440,trim_end:12,zooms:[zoom]},portrait);
    const frames = stageFrames(raw,2560,1440,stage,portrait);
    const box = zoom.level===0 ? [0,0,2560,1440] : zoom.bbox;
    for (const f of frames.filter(f=>f.t>=6&&f.t<10)) {
      assert.ok(f.x<=stage.screenX+box[0]! && f.x+f.w>=stage.screenX+box[0]!+box[2]!);
      assert.ok(f.y<=stage.screenY+box[1]! && f.y+f.h>=stage.screenY+box[1]!+box[3]!);
    }
    assert.deepEqual(frames[6*60],{...frames[9*60]!,t:6});
  }
});

test("bounded portrait square and manual paths reserve drag visibility and motion budgets", () => {
  const drag: Beat = {id:"drag",kind:"drag",t0:3,t1:8,anchor_t:3,
    zones:[{name:"press",type:"act",bbox:[100,100,100,100]}],
    actions:[{k:"drag",t0:4000,t1:7000,from:[150,150],to:[2300,1200],bbox:[150,150,2150,1050],
      path:[{t:5500,x:1200,y:1300}]}]};
  const select = {beat:"drag",A:"press",L:3 as const,K:1 as const,p:0,conf:1,decided_by:"heuristic"};
  for (const settings of [{out_w:1080,out_h:1920},{out_w:1080,out_h:1080},{out_w:1920,out_h:1080}]) {
    const camera = {...DEFAULTS,...settings,outro_s:0};
    for (const known of [false,true]) {
      const g = {...gestures(drag)[0]!,...(known?{whole_object:[100,100,100,100] as [number,number,number,number]}:{})};
      const action = {...drag,actions:[g]};
      const zooms = [{t0:2,t1:9,bbox:[100,100,100,100] as [number,number,number,number],level:3 as const}];
      const raw = solveCamera([action],[select],{width:2560,height:1440,trim_end:12,
        ...(settings.out_h===1080?{zooms}:{})},camera);
      const stage = stageGeometry(2560,1440,camera);
      const frames = stageFrames(raw,2560,1440,stage,camera);
      const box = gestureZone(g,2560,1440).bbox;
      for (const f of frames.filter(f=>f.t>=4&&f.t<=7)) {
        assert.ok(f.x<=stage.screenX+box[0]+1e-8 && f.x+f.w>=stage.screenX+box[0]+box[2]-1e-8);
        assert.ok(f.y<=stage.screenY+box[1]+1e-8 && f.y+f.h>=stage.screenY+box[1]+box[3]-1e-8);
      }
      const metrics = cameraMetrics(frames,60,camera.out_w,camera.out_h,camera.min_shot);
      for (const key of ["max_upscale","zoom_speed","zoom_acceleration","pan_acceleration"]) {
        assert.equal(metrics[key]!.goalPassed,true,`${key}: ${metrics[key]!.value}`);
      }
    }
  }
});


test("late drags preserve unrelated manual holds before and after their bounded lead", () => {
  const zooms = [
    {t0:4,t1:8,bbox:[1100,600,100,100] as [number,number,number,number],level:3 as const},
    {t0:17,t1:21,bbox:[1000,500,200,200] as [number,number,number,number],level:2 as const},
  ];
  const drag: Beat = {id:"later",kind:"drag",t0:10,t1:12,anchor_t:10,camera_suppressed:true,zones:[{name:"all",type:"all",bbox:[0,0,2560,1440]}],
    actions:[{k:"drag",t0:10000,t1:12000,from:[100,100],to:[2400,1200],bbox:[100,100,2300,1100]}]};
  for (const settings of [{out_w:1080,out_h:1920},{out_w:1080,out_h:1080}]) {
    const camera = {...DEFAULTS,...settings,outro_s:0};
    const take = {width:2560,height:1440,trim_end:24,zooms};
    const baseline = solveCamera([],[],take,camera);
    const actual = solveCamera([drag],[{...decision,beat:drag.id,A:"all"}],take,camera);
    assert.deepEqual(actual.slice(4*60,8*60+1),baseline.slice(4*60,8*60+1));
    assert.deepEqual(actual.slice(14*60),baseline.slice(14*60));
    const stage = stageGeometry(2560,1440,camera);
    const frames = stageFrames(actual,2560,1440,stage,camera);
    for (const f of frames.filter(f=>f.t>=10&&f.t<=12)) {
      assert.ok(f.x<=stage.screenX+1e-8 && f.x+f.w>=stage.screenX+2560-1e-8);
      assert.ok(f.y<=stage.screenY+1e-8 && f.y+f.h>=stage.screenY+1440-1e-8);
    }
    const metrics = cameraMetrics(frames,60,camera.out_w,camera.out_h,camera.min_shot);
    for (const key of ["max_upscale","zoom_speed","zoom_acceleration","pan_acceleration"]) {
      assert.equal(metrics[key]!.goalPassed,true,`${key}: ${metrics[key]!.value}`);
    }
  }
});

test("edge manual holds remain exact and their entire curves stay inside the padded stage", () => {
  const boxes: [number,number,number,number][] = [[0,600,100,100],[2460,600,100,100],[1200,0,100,100],[1200,1340,100,100]];
  for (const settings of [{out_w:1080,out_h:1080},{out_w:1080,out_h:1920},{out_w:1920,out_h:1080}]) {
    const camera = {...DEFAULTS,...settings,outro_s:0};
    const stage = stageGeometry(2560,1440,camera);
    for (const bbox of boxes) {
      const timing = {cuts:[],arrivals:[] as import("../src/camera/solver.ts").CameraArrival[]};
      const raw = solveCamera([],[],{width:2560,height:1440,trim_end:14,zooms:[{t0:6,t1:10,bbox,level:3}]},camera,timing);
      const frames = stageFrames(raw,2560,1440,stage,camera);
      assert.equal(timing.arrivals[0]!.lateness,0);
      for (const f of frames) {
        assert.ok(f.x>=-1e-8 && f.y>=-1e-8);
        assert.ok(f.x+f.w<=stage.w+1e-8 && f.y+f.h<=stage.h+1e-8,JSON.stringify(f));
      }
      for (const f of frames.filter(f=>f.t>=6&&f.t<=10)) {
        assert.ok(f.x<=stage.screenX+bbox[0]+1e-8 && f.x+f.w>=stage.screenX+bbox[0]+bbox[2]-1e-8);
        assert.ok(f.y<=stage.screenY+bbox[1]+1e-8 && f.y+f.h>=stage.screenY+bbox[1]+bbox[3]-1e-8);
        for (const key of ["x","y","w","h"] as const) assert.ok(Math.abs(f[key]-timing.arrivals[0]!.requestedFrame[key])<1e-8);
      }
      const metrics = cameraMetrics(frames,60,camera.out_w,camera.out_h,camera.min_shot);
      for (const key of ["max_upscale","zoom_speed","zoom_acceleration","pan_acceleration"]) {
        assert.equal(metrics[key]!.goalPassed,true,`${key}: ${metrics[key]!.value}`);
      }
    }
  }
});


test("manual native warning reports the emitted portrait viewport", () => {
  const camera = {...DEFAULTS,out_w:1080,out_h:1920,max_upscale:1.5,outro_s:0};
  const take = {width:2560,height:1440,trim_end:12,zooms:[{t0:6,t1:10,bbox:[1200,600,100,100] as [number,number,number,number],level:3 as const}]};
  const raw = solveCamera([],[],take,camera);
  const emitted = stageFrames(raw,2560,1440,stageGeometry(2560,1440,camera),camera)[8*60]!;
  const achieved = baseWidth(2560,1440,camera)/emitted.w;
  assert.ok(Math.abs(achieved-3.51)<0.01);
  assert.ok(manualZoomLimitWarning(take,camera)!.includes(`achieved ${achieved.toFixed(2)}x`));
});

test("identity edits preserve camera pace and cut temporal zones cannot re-aim portrait", {skip:!hasFfmpeg()}, async () => {
  mkdirSync(join(process.cwd(),"tmp"),{recursive:true});
  const dir = mkdtempSync(join(process.cwd(),"tmp/edit-boundary-test-"));
  try {
    execFileSync("ffmpeg",["-v","error","-f","lavfi","-i","color=white:s=640x360:r=60:d=12",
      "-c:v","libvpx-vp9","-deadline","realtime","-cpu-used","8",join(dir,"screen.webm")]);
    mkdirSync(join(dir,"analysis"));
    const actions: Beat[] = [5,6.5].map((t,i)=>({id:`b${i}`,kind:"click",t0:t-0.5,t1:t+1,anchor_t:t,
      zones:[{name:"target",type:"act",bbox:[i?480:40,120,100,80]}],actions:[]}));
    writeFileSync(join(dir,"analysis/beats.json"),JSON.stringify(actions));
    writeFileSync(join(dir,"analysis/decisions.jsonl"),actions.map(b=>JSON.stringify({...decision,beat:b.id,A:"target",L:3})).join("\n"));
    const take = {id:"boundaries",width:640,height:360,trim_start:0,trim_end:12};
    const camera = {...d,pace:2};
    writeFileSync(join(dir,"take.json"),JSON.stringify(take));
    await renderTake(dir,camera);
    const baseline = JSON.parse(readFileSync(join(dir,"camera.json"),"utf8"));
    for (const edits of [{speed:[{t0:0,t1:12,rate:1}]},{cuts:[{t0:20,t1:21}]},{speed:[{kind:"type_speed",rate:2}]}]) {
      writeFileSync(join(dir,"take.json"),JSON.stringify({...take,...edits}));
      await renderTake(dir,camera);
      assert.deepEqual(JSON.parse(readFileSync(join(dir,"camera.json"),"utf8")),baseline);
    }
    const event: Beat = {id:"toast",kind:"click",t0:0,t1:12,anchor_t:2,actions:[],zones:[
      {name:"all",type:"all",bbox:[0,0,640,360]},
      {name:"toast",type:"res",bbox:[480,140,100,80],t_change:5},
    ]};
    const edited = {...take,cuts:[{t0:4,t1:7}]};
    const clock = editTimeline(edited,[event],0,12,d);
    assert.deepEqual(editBeats([event],clock,0)[0]!.zones.map(z=>z.name),["all"]);
    writeFileSync(join(dir,"take.json"),JSON.stringify(edited));
    writeFileSync(join(dir,"analysis/beats.json"),JSON.stringify([event]));
    writeFileSync(join(dir,"analysis/decisions.jsonl"),JSON.stringify({...decision,beat:"toast",A:"all",B:"toast"}));
    await renderTake(dir,{...d,out_w:180,out_h:320});
    const frames = JSON.parse(readFileSync(join(dir,"camera.json"),"utf8")) as import("../src/camera/types.ts").CameraFrame[];
    assert.ok(frames.every(f=>f.w>=640),`cut toast restored: ${Math.min(...frames.map(f=>f.w))}`);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
