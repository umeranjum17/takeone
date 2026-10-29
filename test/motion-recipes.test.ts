import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateStoryboard } from "../src/motion/storyboard.ts";

const BOARD = resolve("resources/demo/tidewater-board.png");
const REGIONS = ["--region", "320,180,520,520:Plan the work", "--region", "872,180,520,420:Track progress", "--region", "1424,180,520,420:Ship it"];

function plan(dir: string, name: string, args: string[]) {
  const out = join(dir, name);
  const r = spawnSync(process.execPath, [resolve("bin/takeone.mjs"), "motion", ...args, "--plan-only", "--out", out], { encoding: "utf8", timeout: 60_000 });
  return { r, sb: r.status === 0 ? validateStoryboard(JSON.parse(readFileSync(join(out, "storyboard.json"), "utf8"))) : undefined };
}

test("every recipe plans its approved patterns in landscape and portrait, and social defaults to portrait", () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-recipes-"));
  try {
    const recipes: Record<string, { args: string[]; patterns: string[] }> = {
      launch: { args: [BOARD, ...REGIONS, "--logo", "Tidewater"], patterns: ["logo-sting", "hero-reveal", "zoom-tour", "end-card"] },
      feature: { args: [BOARD, ...REGIONS], patterns: ["hero-reveal", "feature-callouts", "end-card"] },
      social: { args: [BOARD, ...REGIONS], patterns: ["kinetic-type", "device-orbit", "spotlight", "end-card"] },
      compare: { args: [BOARD, BOARD], patterns: ["kinetic-type", "before-after", "end-card"] },
    };
    for (const [name, { args, patterns }] of Object.entries(recipes)) {
      for (const aspect of ["landscape", "portrait"]) {
        const { r, sb } = plan(dir, `${name}-${aspect}`, [...args, "--recipe", name, "--aspect", aspect]);
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(sb!.scenes.map(s => s.pattern), patterns, `${name} ${aspect}`);
        assert.deepEqual([sb!.output.out_w, sb!.output.out_h], aspect === "portrait" ? [1080, 1920] : [1920, 1080]);
      }
    }
    const halo = [BOARD, "--recipe", "halo", "--pitch", "Your crew. Ship it.", "--logo", "Tidewater", "--region", "0,0,400,300:logo", "--region", "800,100,500,400:card"];
    for (const [aspect, size] of [["landscape", [1920, 1080]], ["portrait", [1080, 1920]], ["square", [1080, 1080]]] as const) {
      const { r, sb } = plan(dir, `halo-${aspect}`, [...halo, ...(aspect === "landscape" ? [] : ["--aspect", aspect])]);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual([sb!.output.out_w, sb!.output.out_h], size);
    }
    const social = plan(dir, "social-default", [BOARD, ...REGIONS, "--recipe", "social"]).sb!;
    assert.deepEqual([social.output.out_w, social.output.out_h], [1080, 1920]);
    const each = plan(dir, "each", [BOARD, BOARD, ...REGIONS, "--pattern", "logo-sting,spotlight,feature-callouts,before-after,device-orbit"]).sb!;
    assert.equal(each.scenes.length, 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a recipe that lacks what its patterns need stops with the cause", () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-recipes-bad-"));
  try {
    assert.match(plan(dir, "a", [BOARD, "--recipe", "feature"]).r.stderr, /feature-callouts needs 2 to 5 labelled --region/);
    assert.match(plan(dir, "b", [BOARD, "--recipe", "compare"]).r.stderr, /before-after needs two screens/);
    assert.match(plan(dir, "c", [BOARD, "--recipe", "launch", "--pattern", "end-card"]).r.stderr, /exclusive/);
    assert.match(plan(dir, "d", [BOARD, "--recipe", "poster"]).r.stderr, /--recipe expects/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
