import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { applyOverrides } from "../src/camera/defaults.ts";
import { readBrand } from "../src/motion/brand.ts";
import { renderTake } from "../src/render/render.ts";
import { hasFfmpeg } from "./helpers.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRAND = resolve(root, "resources/demo/tidewater-brand.json");
const FONT = resolve(root, "resources/fonts/Fraunces-SemiBold.ttf");
const needsFfmpeg = hasFfmpeg() ? undefined : "requires system ffmpeg and ffprobe on PATH";

test("a take brand keeps its own tokens over a light stage, and still refuses a family it cannot render", () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-take-brand-"));
  try {
    const file = join(dir, "light.json");
    writeFileSync(file, JSON.stringify({
      name: "Paper",
      colors: { background: "#f7f5ef", surface: "#ffffff", foreground: "#1b1b1b", border: "#dcd7cb", accent: "#0f766e" },
      typography: { display: "Fraunces", body: "Manrope" },
    }));
    const brand = readBrand(file, "take");
    // Only the tokens a take render has; the motion-only page/ink/mono keys do not ride along.
    assert.deepEqual(Object.keys(brand.overrides).sort(),
      ["accent", "background", "background_to", "bg_stops", "border_color", "caption_font", "card", "display_font", "text"]);
    // The stage paints bg_stops whenever it has them, so the brand's background replaces them.
    assert.equal(brand.overrides["bg_stops"], "");
    assert.deepEqual([brand.overrides["background"], brand.overrides["accent"], brand.overrides["display_font"], brand.overrides["caption_font"]],
      ["#f7f5ef", "#0f766e", "Fraunces SemiBold", "Manrope Medium"]);
    // The same file on the glow recipe keeps its dark-stage refusal.
    assert.throws(() => readBrand(file), /too light for the glow recipe's dark stage/);

    const bad = join(dir, "papyrus.json");
    writeFileSync(bad, JSON.stringify({ typography: { display: "Papyrus" } }));
    assert.throws(() => readBrand(bad, "take"), /"Papyrus" is not a font TakeOne bundles \(no fallback is used\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a brand font file is carried to the render, and a family that is not the one inside it is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-font-file-"));
  try {
    const file = join(dir, "brand.json");
    const write = (typography: unknown) => { writeFileSync(file, JSON.stringify({ typography })); return file; };
    const carried = readBrand(write({ display: { family: "Fraunces SemiBold", file: FONT } }), "take");
    assert.deepEqual(carried.fonts, [FONT]);
    assert.equal(carried.overrides["display_font"], "Fraunces SemiBold");
    // A path alone names the file's own family.
    assert.equal(readBrand(write({ body: FONT }), "take").overrides["caption_font"], "Fraunces SemiBold");
    // A family the file does not carry would render in another face, so it is an error, never a fallback.
    assert.throws(() => readBrand(write({ display: { family: "Clash Display", file: FONT } }), "take"),
      /"Clash Display" is not the family inside Fraunces-SemiBold\.ttf \(it carries "Fraunces SemiBold"\)/);
    assert.throws(() => readBrand(write({ display: { file: join(dir, "missing.ttf") } }), "take"), /font file .*missing\.ttf does not exist/);
    assert.throws(() => readBrand(write({ display: 7 }), "take"), /expected a font family name/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the sample brand dresses a take, and an unbundled family exits non-zero naming the font it cannot find", () => {
  const take = JSON.parse(JSON.stringify({ overrides: readBrand(BRAND, "take").overrides }));
  assert.deepEqual([take.overrides["background"], take.overrides["accent"], take.overrides["display_font"]],
    ["#04141a", "#18c8a4", "Space Grotesk Bold"]);
  assert.equal(readBrand(BRAND, "take").logo, readBrand(BRAND).logo, "the same file still validates its mark for the glow end card");

  const dir = mkdtempSync(join(tmpdir(), "takeone-brand-cli-"));
  try {
    writeFileSync(join(dir, "take.json"), JSON.stringify({ id: "brand", width: 640, height: 360 }));
    const bad = join(dir, "brand.json");
    writeFileSync(bad, JSON.stringify({ typography: { display: "BrandSans" } }));
    const result = spawnSync(process.execPath, [join(root, "bin/takeone.mjs"), "render", dir, "--brand", bad], { encoding: "utf8", timeout: 60_000 });
    assert.notEqual(result.status, 0, `an unbundled family must not render: ${result.stdout}`);
    assert.match(result.stderr, /"BrandSans" is not a font TakeOne bundles \(no fallback is used\)/);
    const unknown = spawnSync(process.execPath, [join(root, "bin/takeone.mjs"), "render", dir, "--brand", join(dir, "nope.json")], { encoding: "utf8", timeout: 60_000 });
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /no such file/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a brand font file reaches the renderer's font directory instead of falling back to another face", { skip: needsFfmpeg, timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-brand-font-render-"));
  const previous = process.env["FONTCONFIG_FILE"];
  // An empty fontconfig: only the render's own font directory can serve a face, so a font that
  // did not reach it cannot be found on this machine either.
  process.env["FONTCONFIG_FILE"] = join(dir, "fonts.conf");
  writeFileSync(process.env["FONTCONFIG_FILE"], "<fontconfig></fontconfig>");
  try {
    // A copy of a bundled face under a family no font on this machine carries: only the brand file
    // can supply it, so a staged file and a missing one cannot render the same pixels.
    const family = "Qzbrand Face 0001";
    const from = Buffer.from("Fraunces SemiBold", "utf16le").swap16();
    const to = Buffer.from(family, "utf16le").swap16();
    assert.equal(to.length, from.length, "the fixture name is the same length as the family it replaces");
    const patched = join(dir, "QzBrand-0001.ttf"), copy = Buffer.from(readFileSync(FONT));
    for (let at = copy.indexOf(from); at >= 0; at = copy.indexOf(from, at + to.length)) to.copy(copy, at);
    assert.ok(copy.includes(Buffer.from(family, "utf16le").swap16()), "the fixture carries the unique family");
    writeFileSync(patched, copy);
    const brandFile = join(dir, "brand.json");
    writeFileSync(brandFile, JSON.stringify({ typography: { display: { family, file: patched } } }));
    const brand = readBrand(brandFile, "take");
    assert.deepEqual([brand.overrides["display_font"], brand.fonts], [family, [patched]]);

    mkdirSync(join(dir, "take/analysis"), { recursive: true });
    const take = join(dir, "take");
    writeFileSync(join(take, "take.json"), JSON.stringify({ id: "brandfont", width: 640, height: 360, trim_end: 1.2, title: family }));
    writeFileSync(join(take, "analysis/beats.json"), "[]");
    writeFileSync(join(take, "analysis/decisions.jsonl"), "");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=60:d=1.2", "-c:v", "libvpx-vp9", "-threads", "2", join(take, "screen.webm")]);
    const camera = applyOverrides({ ...{ out_w: 640, out_h: 360, caption_size: 22, preset: "ultrafast", fade_s: 0 }, display_font: family });
    const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
    const staged = hash((await renderTake(take, camera, undefined, brand.fonts)).out);
    const missing = hash((await renderTake(take, camera)).out);
    assert.notEqual(staged, missing, "the staged brand file changes the film; a film without it falls back to another face");
  } finally {
    if (previous === undefined) delete process.env["FONTCONFIG_FILE"]; else process.env["FONTCONFIG_FILE"] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
