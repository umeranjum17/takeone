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

test("a drag that reaches the screen edge stays visible through the closing ease", async () => {
  const { gestures, gestureZone } = await import("../src/camera/gesture.ts");
  const { contains } = await import("../scripts/check-framing.ts");
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
