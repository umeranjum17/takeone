import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hasFfmpeg } from "./helpers.ts";
import { applyOverrides, DEFAULTS } from "../src/camera/defaults.ts";
import type { Beat } from "../src/camera/types.ts";
import { idleSqueezes, setptsExpr, warp } from "../src/render/pace.ts";
import { bandLayout, captionAss, captionLayouts, takeCaptions } from "../src/render/stage.ts";
import { THEMES, resolveTheme } from "../src/themes.ts";

const clickAt = (t: number): Beat => ({
  id: `b${t}`, t0: t, t1: t + 0.5, anchor_t: t, zones: [], actions: [{ k: "click", t: t * 1000, x: 10, y: 10 }],
} as unknown as Beat);

test("idle gaps squeeze and the setpts expression matches warp", () => {
  const squeezes = idleSqueezes([clickAt(1), clickAt(9)], 0, 12, DEFAULTS);
  // 1 s kept around each click; the 6 s gap between plays at idle_speed.
  assert.deepEqual(squeezes, [{ a: 2, b: 8 }, { a: 10, b: 12 }]);
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
    const band = bandLayout(3840, 2160, d)!;
    const card = band.stage;
    assert.equal(card.screenY + card.baseH, band.top, name);
    const captions = takeCaptions({ width: 3840, height: 2160, title: "From idea to launch",
      captions: [{ t: 1, text: "Umer adds a launch task" }, { t: 9, text: "a caption far too long to fit on one line ".repeat(4) }] },
      t => t, 20, true);
    // The band holds one line, so a caption overlapping the title waits for it.
    assert.deepEqual(captions.map(c => c.t0), [0.35, 3.1, 9], name);
    const layouts = captionLayouts(captions, [{ w: 600, h: 50 }, { w: 500, h: 30 }, { w: 9000, h: 30 }], d, false, band);
    for (const { cx, cy, w, h, size } of layouts) {
      assert.ok(cy - h / 2 >= band.top && cy + h / 2 <= d.out_h, `${name}: vertical`);
      assert.ok(cx - w / 2 >= 0 && cx + w / 2 <= d.out_w && size > 0, `${name}: horizontal`);
    }
    assert.ok(layouts[0]!.size > layouts[1]!.size, `${name}: title outranks captions`);
  }
  assert.equal(bandLayout(1080, 2340, DEFAULTS), null);
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
