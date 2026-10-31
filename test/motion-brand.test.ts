import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { contrast, readBrand } from "../src/motion/brand.ts";
import { planStory } from "../src/motion/story.ts";
import { glowStoryboard } from "../src/motion/glow.ts";
import { imageSize } from "../src/motion/ingest.ts";
import { filmDuration, validateStoryboard } from "../src/motion/storyboard.ts";
import { motionTokens } from "../src/motion/theme.ts";

const BOARD = resolve("resources/demo/tidewater-board.png"), BRAND = resolve("resources/demo/tidewater-brand.json");
const ARGS = { inputs: [BOARD], title: "Meet the crew", subtitle: "Ask. Done.", pitch: "Plan the launch", logo: "Tidewater", tree: "Crew,>Chief,>Scout" };

test("a brand file becomes validated theme overrides, a bundled font and a logo; an unknown font or a light stage is refused", () => {
  const brand = readBrand(BRAND);
  assert.equal(brand.name, "Tidewater");
  assert.deepEqual([brand.overrides["accent"], brand.overrides["display_font"], brand.overrides["caption_font"], brand.overrides["mono_font"]],
    ["#18c8a4", "Space Grotesk Bold", "Manrope Medium", "JetBrains Mono"]);
  assert.match(brand.logo!, /tidewater-mark\.svg$/);

  const dir = mkdtempSync(join(tmpdir(), "takeone-brand-"));
  try {
    const md = join(dir, "DESIGN.md");
    writeFileSync(md, `---\nname: "Tidewater"\ncolors:\n  background: "#04141a"\n  accent: "#18c8a4"\n  foreground: "#f1faf7"\n---\n\n# Tidewater\n\n## Typography\n\n- **Display:** Space Grotesk — weights 700\n- **Body:** Manrope — weights 500\n`);
    const fromMd = readBrand(md);
    assert.deepEqual([fromMd.overrides["accent"], fromMd.overrides["background"], fromMd.overrides["text"], fromMd.overrides["display_font"], fromMd.overrides["caption_font"]],
      ["#18c8a4", "#04141a", "#f1faf7", "Space Grotesk Bold", "Manrope Medium"]);

    const bad = (name: string, body: unknown) => { const f = join(dir, name); writeFileSync(f, JSON.stringify(body)); return f; };
    assert.throws(() => readBrand(bad("font.json", { typography: { display: { family: "Papyrus" } } })), /"Papyrus" is not a font TakeOne bundles \(no fallback is used\); bundled families: .*Inter/);
    assert.throws(() => readBrand(bad("light.json", { colors: [{ role: "background", hex: "#ffffff" }] })), /too light for the glow recipe's dark stage/);
    assert.throws(() => readBrand(bad("dim.json", { colors: [{ role: "background", hex: "#04141a" }, { role: "accent", hex: "#0a1f26" }] })), /accent #0a1f26 .* need 3:1/);
    assert.throws(() => readBrand(bad("logo.json", { logo: "missing.png" })), /logo: .*missing\.png does not exist/);
    assert.throws(() => readBrand(bad("empty.json", { tagline: "nothing usable" })), /no colours, fonts or logo/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the glow storyboard carries the brand; without one the stage keeps its blue and the pattern's colour map is the identity", () => {
  const size = imageSize(BOARD), tap: [number, number, number, number] = [100, 100, 200, 60];
  const plain = validateStoryboard(glowStoryboard(ARGS, "plain", [size], tap));
  const branded = validateStoryboard(glowStoryboard({ ...ARGS, logo: undefined }, "branded", [size], tap, undefined, readBrand(BRAND)));
  assert.equal(plain.theme.overrides["accent"], "#2f7bff");
  assert.equal(branded.theme.overrides["accent"], "#18c8a4");
  assert.equal(motionTokens(branded.theme.name, branded.theme.overrides).display_font, "Space Grotesk Bold");
  const end = branded.scenes.at(-1)!;
  assert.deepEqual([end.logo, end.logo_image === readBrand(BRAND).logo], ["Tidewater", true], "the brand name is the wordmark, the mark rides the end card");
  assert.equal(plain.scenes.at(-1)!.logo_image, undefined);
  assert.deepEqual(plain.scenes.map(s => s.pattern), branded.scenes.map(s => s.pattern), "same storyboard, only the dress differs");
  assert.equal(filmDuration(plain), filmDuration(branded));
  assert.throws(() => validateStoryboard({ ...(glowStoryboard(ARGS, "x", [size], tap) as object), scenes: [{ pattern: "glow-prompt", d: 1, text: "hi", logo_image: "/x.png" }] }), /only an end-card takes a logo_image/);

  // The pattern's colour map, run as the page runs it: identity on the default blue, the accent's hue otherwise.
  const colourMap = (accent: string) => {
    const ctx = vm.createContext({ window: {}, PATTERNS: {}, STORYBOARD: { tokens: { accent, text: "#ffffff", background: "#030719", card: "#0e111b", border_color: "#2b3144", line: "#3b4a78", muted: "#c9d6f5" } } });
    vm.runInContext(readFileSync("resources/motion/patterns/glow.js", "utf8"), ctx);
    return (hex: string): string => vm.runInContext(`glC(${JSON.stringify(hex)})`, ctx) as string;
  };
  const same = colourMap("#2f7bff"), teal = colourMap("#18c8a4");
  for (const hex of ["#1f6bff", "#6aaaffdd", "#cfe3ff"]) assert.equal(same(hex), hex);
  const [r, g, b] = [1, 3, 5].map(i => parseInt(teal("#1f6bff").slice(i, i + 2), 16));
  assert.ok(g! > r! && g! > b! * 0.8 && teal("#6aaaffdd").endsWith("dd"), `the blue glow turns teal: ${teal("#1f6bff")}`);
});

test("a light brand is accepted by the story and take stages and inked from its own page; a failing pair is said with its ratio and drawn in the nearest colour that passes", () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-brand-light-"));
  try {
    const write = (name: string, colors: Record<string, string>) => { const f = join(dir, name); writeFileSync(f, JSON.stringify({ name: "Larder", colors })); return f; };
    const cream = write("cream.json", { background: "#faf5ea", accent: "#b4441e" });
    assert.throws(() => readBrand(cream), /too light for the glow recipe's dark stage/, "glow's white type still needs its dark stage");
    for (const stage of ["story", "take"] as const) {
      const brand = readBrand(cream, stage);
      assert.equal(brand.overrides["background"], "#faf5ea", "the brand keeps its own page");
      assert.ok(contrast(brand.overrides["text"]!, "#faf5ea") >= 4.5 && contrast(brand.overrides["card"]!, brand.overrides["text"]!) >= 4.5, "the foreground it chose reads on the page and on the cards");
      assert.deepEqual(brand.warnings, []);
    }
    const bad = readBrand(write("bad.json", { background: "#faf5ea", foreground: "#c9c3b5", accent: "#e9dcc0" }), "story");
    assert.match(bad.warnings[0]!, /foreground #c9c3b5 on #eee9df reads at 1\.5:1, below the 4\.5:1 floor; drawn as #[0-9a-f]{6} \(4\.[5-9]:1\)/);
    assert.match(bad.warnings[1]!, /accent #e9dcc0 on #faf5ea reads at 1\.2:1, below the 3:1 floor/);
    assert.ok(contrast(bad.overrides["text"]!, "#faf5ea") >= 4.5 && contrast(bad.overrides["accent"]!, "#faf5ea") >= 3, "no role is left below the floor");
    assert.equal(readBrand(BRAND, "story").warnings.length, 0, "a dark brand that already passes is untouched");

    const lines: string[] = [];
    const board = planStory({ pitch: "chips: Plan the watch / now. | A; B\nstats: One board / done. | 9 crew; 4 watches", brand: write("bad2.json", { background: "#faf5ea", foreground: "#c9c3b5" }) }, "story", [1920, 1080], l => lines.push(l)) as { theme: { overrides: Record<string, string> } };
    assert.match(lines.join("\n"), /1\.5:1/);
    assert.ok(contrast(board.theme.overrides["text"]!, "#faf5ea") >= 4.5, "the planned film carries the repaired colour");
    // A foreground alone, on a theme whose own page it cannot read, is refused before a frame is drawn.
    assert.throws(() => planStory({ pitch: "chips: Plan / now. | A; B\nstats: One / two. | 9 crew; 4 watches", theme: "paper", brand: write("pale.json", { foreground: "#f1faf7" }) }, "story"), /below the 4\.5:1 floor/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
