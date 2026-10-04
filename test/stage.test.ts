import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hasFfmpeg } from "./helpers.ts";
import { applyOverrides, DEFAULTS } from "../src/camera/defaults.ts";
import type { Beat } from "../src/camera/types.ts";
import { idleSqueezes, purposefulEnd, setptsExpr, warp } from "../src/render/pace.ts";
import { bandEligible, bandLayout, bandText, captionAss, captionLayouts, takeCaptions } from "../src/render/stage.ts";
import { measureCaptions } from "../src/render/render.ts";
import { THEMES, resolveTheme } from "../src/themes.ts";

const clickAt = (t: number): Beat => ({
  id: `b${t}`, t0: t, t1: t + 0.5, anchor_t: t, zones: [], actions: [{ k: "click", t: t * 1000, x: 10, y: 10 }],
} as unknown as Beat);

test("idle gaps squeeze and the setpts expression matches warp", () => {
  const squeezes = idleSqueezes([clickAt(1), clickAt(9)], 0, 12, DEFAULTS);
  // 1 s kept around each click; the 6 s gap between plays at idle_speed.
  assert.deepEqual(squeezes, [{ a: 2, b: 8 }]);
  assert.equal(warp(5, squeezes, 4), 2 + 3 / 4);
  const expr = setptsExpr(squeezes, 4).replace(/\/TB$/, "");
  for (const t of [0, 1.5, 5, 9, 11, 12]) {
    const value = Function("clip", "T", `return ${expr}`)(
      (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x)), t) as number;
    assert.ok(Math.abs(value - warp(t, squeezes, 4)) < 1e-3, `t=${t}`);
  }
  assert.deepEqual(idleSqueezes([clickAt(1)], 0, 12, { ...DEFAULTS, idle_speed: 1 }), []);
});

test("captions are sanitised, clamped and keep their on-screen duration", () => {
  const captions = takeCaptions({
    width: 1920, height: 1080, title: "Hi {\\b1}there",
    captions: [{ t: 10, text: "a\\N{b}" }, { t: 40, text: "late" }, { t: 5, text: "  " }],
  }, (t) => t / 2, 12);
  assert.deepEqual(captions.map((c) => c.text), ["Hi b1there", "aNb"]);
  assert.deepEqual([captions[1]!.t0, captions[1]!.t1], [5, 8]);
});

test("look overrides validate colours, fonts and ranges", () => {
  assert.equal(applyOverrides({ quality: "master", accent: "#ff0000", caption_font: "Noto Sans" }).accent, "#ff0000");
  for (const bad of [{ quality: "other" }, { accent: "red" }, { accent: 123456 }, { background: 123456 }, { caption_font: "x}{\\" }, { caption_font: 123 }, { idle_speed: 0.5 }, { shadow: 2 }, { stage_margin: 0.3 }]) {
    assert.throws(() => applyOverrides(bad), /invalid --set/);
  }
});

test("captions stop at the next mapped start in chronological order", () => {
  const captions = takeCaptions({ width: 1920, height: 1080,
    captions: [{t: 4, text: "second"}, {t: 2, d: 8, text: "first"}, {t: 4, text: "replacement"}],
  }, t => t / 2, 10);
  assert.deepEqual(captions.map(c => [c.text,c.t0,c.t1]), [["first",1,2],["replacement",2,5]]);
});

test("every theme keeps title and captions in the band below a fixed card", () => {
  for (const name of Object.keys(THEMES)) {
    const d = resolveTheme(name);
    const captions = takeCaptions({ width: 3840, height: 2160, title: "From idea to launch",
      captions: [{ t: 1, text: "Umer adds a launch task" }, { t: 9, text: "a caption far too long to fit on one line ".repeat(4) }] },
      t => t, 20);
    assert.deepEqual(captions.map(c => c.t0), [0.35, 1, 9], name);
    const ink = [{ w: 600, h: 50 }, { w: 500, h: 30 }, { w: 9000, h: 30 }];
    const band = bandLayout(3840, 2160, d, captions, ink)!;
    const card = band.stage;
    assert.equal(card.screenY + card.baseH, band.top, name);
    const layouts = captionLayouts(captions, ink, d, false, band);
    assert.ok(layouts[0]!.cy + layouts[0]!.h / 2 + layouts[0]!.rise
      < layouts[1]!.cy - layouts[1]!.h / 2 - d.caption_border, name);
    for (const { cx, cy, w, h, size } of layouts) {
      assert.ok(cy - h / 2 >= band.top && cy + h / 2 <= d.out_h, `${name}: vertical`);
      assert.ok(cx - w / 2 >= 0 && cx + w / 2 <= d.out_w && size > 0, `${name}: horizontal`);
    }
    assert.ok(layouts[0]!.size > layouts[1]!.size, `${name}: title outranks captions`);
  }
  assert.equal(bandLayout(1080, 2340, DEFAULTS), null);
});

test("matching non-16:9 exports retain the overlay layout", () => {
  for (const [width, height] of [[1080, 1920], [1080, 1080], [1440, 1080]]) {
    assert.equal(bandLayout(width!, height!, { ...DEFAULTS, out_w: width!, out_h: height! }), null);
  }
  assert.equal(bandLayout(1920, 1080, { ...DEFAULTS, out_w: 1080, out_h: 1080 }), null);
  assert.ok(bandLayout(1920, 1080, DEFAULTS));
});

test("titles preserve caption timestamps and ordinary replacement behavior", () => {
  const meta = { width: 1920, height: 1080, title: "Demo", captions: [
    { t: 0, d: 0.3, text: "before" }, { t: 0.1, d: 1, text: "first" },
    { t: 1, d: 2, text: "second" }, { t: 4, d: 3, text: "ordinary" },
  ] };
  const result = takeCaptions(meta, t => t, 10);
  assert.deepEqual(result.map(c => [c.text, c.t0, c.t1]), [
    ["Demo", 0.35, 3.1], ["before", 0, 0.1], ["first", 0.1, 1], ["second", 1, 3], ["ordinary", 4, 7],
  ]);
  assert.deepEqual(result.filter(c => !c.title), takeCaptions({ ...meta, title: "" }, t => t, 10));
  const sameStart = { ...meta, captions: [
    { t: 1, d: 1, text: "first" }, { t: 1, d: 1, text: "replacement" },
    { t: 9, d: 3, text: "last" },
  ] };
  assert.deepEqual(takeCaptions(sameStart, t => t, 10).filter(c => !c.title).map(c => [c.text, c.t0, c.t1]),
    [["replacement", 1, 2], ["last", 9, 10]]);
});

test("complete long caption ink is measured before fitting inside a band pill", { skip: !hasFfmpeg() }, async () => {
  const dir = mkdtempSync(`${process.cwd()}/tmp-long-caption-`);
  const d = { ...DEFAULTS, card: "#000000", text: "#ffffff", caption_border: 0 };
  let band = bandLayout(1920, 1080, d)!;
  const text = "Review every task and share the result. ".repeat(32).trim();
  const captions = [text, `${text} ${text}`].map(text => ({ t0: 0, t1: 2, text, title: false }));
  try {
    const ink = await measureCaptions(dir, captions, d, true);
    band = bandLayout(1920, 1080, d, captions, ink)!;
    assert.ok(ink[0]!.w > 16000, `natural width=${ink[0]!.w}`);
    assert.ok(Math.abs(ink[1]!.w / ink[0]!.w - 2) < 0.02, `widths=${ink.map(i => i.w)}`);
    for (let i = 0; i < captions.length; i++) {
      const layout = captionLayouts([captions[i]!], [ink[i]!], d, false, band)[0]!;
      writeFileSync(`${dir}/captions.ass`, captionAss([captions[i]!], [ink[i]!], d, false, band));
      const pixels = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
        `color=black:s=${d.out_w}x${d.out_h}:r=1:d=2`, "-vf",
        `ass=${dir}/captions.ass:fontsdir=resources/fonts,select=gte(t\\,1),format=gray`,
        "-frames:v", "1", "-f", "rawvideo", "-"], { maxBuffer: d.out_w * d.out_h * 2 });
      let left = d.out_w, right = -1;
      for (let y = 0; y < d.out_h; y++) for (let x = 0; x < d.out_w; x++) {
        if (pixels[y * d.out_w + x]! <= 16) continue;
        left = Math.min(left, x);
        right = Math.max(right, x);
        assert.ok(y > band.top && Math.abs(y - layout.cy) <= layout.h / 2, `ink y=${y}`);
      }
      assert.ok(left >= layout.cx - layout.w / 2 && right <= layout.cx + layout.w / 2,
        `ink ${left}..${right}, pill ${layout.cx - layout.w / 2}..${layout.cx + layout.w / 2}`);
      assert.ok(right - left > layout.w * 0.9, `complete fitted line spans ${right - left}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent band titles and captions retain separate measured rows in every theme", { skip: !hasFfmpeg() }, async () => {
  const dir = mkdtempSync(`${process.cwd()}/tmp-title-`);
  try {
    for (const name of Object.keys(THEMES)) {
      const d = resolveTheme(name);
      const captions = takeCaptions({ width: 1920, height: 1080,
        title: "From a new idea to a complete product: plan your launch, organise every task, and review the result with your team",
        captions: [{ t: 1, d: 4, text: "Review the result" }] }, t => t, 10);
      const ink = await measureCaptions(dir, captions, d, bandEligible(1920, 1080, d));
      const band = bandLayout(1920, 1080, d, captions, ink)!;
      const layouts = captionLayouts(captions, ink, d, false, band);
      assert.equal(layouts[0]!.size, Math.round(d.caption_size * 1.6), name);
      assert.ok(ink[0]!.h > layouts[0]!.size, `${name}: title wraps`);
      assert.equal(layouts[1]!.size, d.caption_size, name);
      assert.deepEqual([captions[1]!.t0, captions[1]!.t1], [1, 5], name);
      assert.ok(layouts[0]!.cy + layouts[0]!.h / 2 + layouts[0]!.rise
        < layouts[1]!.cy - layouts[1]!.h / 2 - d.caption_border, name);
      const background = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
        `color=0x${d.background.slice(1)}:s=${d.out_w}x${d.out_h}:r=1:d=1`, "-vf", "format=gray",
        "-frames:v", "1", "-f", "rawvideo", "-"], { maxBuffer: d.out_w * d.out_h * 2 });
      for (const t of [0.4, 1.4, 4]) for (let i = 0; i < captions.length; i++) {
        if (captions[i]!.t0 >= t || captions[i]!.t1 <= t) continue;
        writeFileSync(`${dir}/captions.ass`, captionAss([captions[i]!], [ink[i]!], d, false, band));
        const pixels = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
          `color=0x${d.background.slice(1)}:s=${d.out_w}x${d.out_h}:r=1:d=1`, "-vf",
          `settb=1/1000,setpts=PTS+${t}/TB,ass=${dir}/captions.ass:fontsdir=resources/fonts,format=gray`,
          "-frames:v", "1", "-f", "rawvideo", "-"], { maxBuffer: d.out_w * d.out_h * 2 });
        let count = 0;
        for (let y = 0; y < d.out_h; y++) for (let x = 0; x < d.out_w; x++) {
          if (Math.abs(pixels[y * d.out_w + x]! - background[y * d.out_w + x]!) <= 2) continue;
          count++;
          const rowTop = i === 0 ? band.top : layouts[0]!.cy + layouts[0]!.h / 2 + layouts[0]!.rise;
          const rowBottom = i === 0 ? layouts[1]!.cy - layouts[1]!.h / 2 - d.caption_border : d.out_h;
          assert.ok(y > rowTop && y < rowBottom, `${name}: row ${i} ink at y=${y}, t=${t}`);
          assert.ok(y > band.top + d.border && y < d.out_h - 1, `${name}: ink at y=${y}, t=${t}`);
          assert.ok(x > d.out_w * 0.04 && x < d.out_w * 0.96, `${name}: ink at x=${x}, t=${t}`);
        }
        assert.ok(count > 100, `${name}: visible ink at t=${t}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("small outputs and oversized captions scale band text, keeping distinct rows above a real card", { skip: !hasFfmpeg() }, async () => {
  const dir = mkdtempSync(`${process.cwd()}/tmp-small-`);
  try {
    const meta = { width: 1920, height: 1080, title: "Smoke title", captions: [{ t: 1.5, text: "Hello world" }] };
    assert.equal(bandText(takeCaptions(meta, t => t, 10), [{ w: 400, h: 50 }, { w: 300, h: 30 }], DEFAULTS), DEFAULTS);
    for (const d of [{ ...DEFAULTS, out_w: 320, out_h: 180 }, { ...DEFAULTS, caption_size: 200, caption_border: 8 },
      { ...DEFAULTS, out_w: 320, out_h: 180, caption_size: 200, caption_border: 8 }]) {
      const captions = takeCaptions(meta, t => t, 10);
      const initial = bandText(captions, [], d);
      const ink = await measureCaptions(dir, captions, initial, bandEligible(1920, 1080, d));
      const text = bandText(captions, ink, initial);
      assert.ok(text.caption_size < d.caption_size, `${d.out_w}: text shrinks`);
      assert.equal(text.caption_border, d.caption_border * (text.caption_size / d.caption_size));
      const fitted = await measureCaptions(dir, captions, text, bandEligible(1920, 1080, text));
      const band = bandLayout(1920, 1080, text, captions, fitted)!;
      assert.ok(band.stage.baseH >= d.out_h / 2, `${d.out_w}: card keeps most of the frame`);
      const [title, caption] = captionLayouts(captions, fitted, text, false, band);
      assert.ok(title!.size > caption!.size * 1.5, `${d.out_w}: title hierarchy`);
      assert.ok(band.top < title!.cy - title!.h / 2 - title!.rise, `${d.out_w}: title below the card`);
      assert.ok(title!.cy + title!.h / 2 + title!.rise < caption!.cy - caption!.h / 2, `${d.out_w}: separate rows`);
      assert.ok(caption!.cy + caption!.h / 2 + caption!.rise <= d.out_h, `${d.out_w}: caption inside the frame`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Inspect rendered white ink, rather than ASS source, for layout regressions.
function inkBands(captions: Parameters<typeof captionAss>[0], widths: number[], widePhone = false) {
  const dir = mkdtempSync(`${process.cwd()}/tmp-caption-`);
  const d = { ...DEFAULTS, out_w: 640, out_h: 360, caption_size: 28 };
  try {
    writeFileSync(`${dir}/captions.ass`,captionAss(captions,widths,d,widePhone));
    const pixels = execFileSync("ffmpeg",["-v","error","-f","lavfi","-i","color=black:s=640x360:r=10:d=2",
      "-vf",`ass=${dir}/captions.ass,select=gte(t\\,1),format=gray`,"-frames:v","1","-f","rawvideo","-"], {maxBuffer:1_000_000});
    const rows: number[] = [];
    let left = 640, right = 0;
    for (let y = 0; y < 360; y++) for (let x = 0; x < 640; x++) {
      if (pixels[y * 640 + x]! <= 220) continue;
      if (rows.at(-1) !== y) rows.push(y);
      left = Math.min(left, x);
      right = Math.max(right, x);
    }
    const bands = rows.filter((y,i)=>i===0 || y>rows[i-1]!+3);
    return {bands,left,right};
  } finally {rmSync(dir,{recursive:true,force:true});}
}
test("wide phone captions can use a lower lane when the upper lane covers app content", {skip:!hasFfmpeg()}, () => {
  const captions = takeCaptions({ width: 920, height: 2048,
    captions: [{ t: 0.5, text: "Choose a priority", position: "bottom" }],
  }, t => t, 3);
  assert.equal(captions[0]!.position, "bottom");
  const ink = inkBands(captions, [200], true);
  assert.ok(ink.bands[0]! > 250, `caption ink begins at ${ink.bands[0]}`);
});
test("long captions wrap within the output safe width", {skip:!hasFfmpeg()}, () => {
  const ink = inkBands([{t0:0,t1:2,text:"Move this card into the next column and review the result",title:false}],[850]);
  assert.ok(ink.bands.length>=2, `lines=${ink.bands.length}`);
  assert.ok(ink.left>=32 && ink.right<=608, `${ink.left}..${ink.right}`);
});
test("a simultaneous title stacks above the caption", {skip:!hasFfmpeg()}, () => {
  const ink=inkBands([{t0:0,t1:2,text:"TakeOne demo",title:true},{t0:0,t1:2,text:"Select a card",title:false}],[260,180]);
  assert.equal(ink.bands.length,2, `ink rows=${ink.bands}`);
  assert.ok(ink.bands[1]!-ink.bands[0]!>45, `ink rows=${ink.bands}`);
});


test("export preserves a full output-clock outro after results and cut settling", () => {
  const action = clickAt(5);
  action.zones = [{name:"result",type:"res",bbox:[0,0,100,100],t_change:5.7}];
  const idle: Beat = { ...clickAt(10), kind:"idle", actions:[{k:"ptr",t:10000,x:10,y:10}] };
  assert.equal(purposefulEnd([action,idle],0,12,DEFAULTS),7.3);
  const cut: Beat = { ...clickAt(5), kind:"cut", t1:7.3, actions:[{k:"cut",t:5000}] };
  for (const beats of [[action,idle], [cut,idle]]) {
    const start = 2;
    const end = purposefulEnd(beats,start,12,DEFAULTS);
    const squeezes = idleSqueezes(beats,start,end,DEFAULTS);
    const result = beats[0] === cut ? cut.t1 : 5.7;
    assert.ok(Math.abs(warp(end-start,squeezes,DEFAULTS.idle_speed)
      - warp(result-start,squeezes,DEFAULTS.idle_speed) - DEFAULTS.outro_s) < 1e-9);
    assert.ok(squeezes.every(s => s.a >= DEFAULTS.establish_s));
    if (beats[0] === cut) assert.ok(squeezes.every(s => s.b <= cut.t0-start || s.a >= cut.t1-start));
  }
  assert.equal(purposefulEnd([action,idle],0,12,{...DEFAULTS,outro_s:0}),12);
  assert.equal(purposefulEnd([action],0,6,DEFAULTS),6);
});
