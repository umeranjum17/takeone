// Measuring a reference film, and cutting an existing pattern on the beats it measured.
// The fixture is the first 6.2 s of a real halo render of resources/demo/tidewater-pieces.png, at 480x270
// and 30 fps, so every beat can be checked against the boundaries that render itself recorded
// (out/scenes.json: 0, 2.617, 4.133, 5.267, 7.633, 10.017 s).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { planHalo } from "../src/motion/halo.ts";
import { filmStoryboard } from "../src/motion/film.ts";
import { planStory } from "../src/motion/story.ts";
import { measureReference, missedBeats } from "../src/motion/reference.ts";
import { minSceneDuration, validateStoryboard } from "../src/motion/storyboard.ts";
import { hasFfmpeg } from "./helpers.ts";

const CLIP = resolve("test/fixtures/reference-halo.mp4");
const BOARD = resolve("resources/demo/tidewater-pieces.png");
const REGIONS = ["120,240,760,420:logo", "960,300,700,300:stack:Crew", "960,640,700,260:row"];
const PITCH = "Crew, planned. Every watch. One board.";
/** The render's own scene starts, minus the opening: what the measurement has to find in the clip. */
const RECORDED = [2.617, 4.133, 5.267];
const skip = hasFfmpeg() ? undefined : "ffmpeg and ffprobe are not on PATH";

const measured = async (): Promise<{ facts: Awaited<ReturnType<typeof measureReference>>; dir: string }> => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-reference-"));
  return { facts: await measureReference(CLIP, join(dir, "reference")), dir };
};

test("a reference film is measured into beats, frames, a contact sheet and the rules", { skip }, async () => {
  const { facts, dir } = await measured();
  try {
    const written = join(dir, "reference", "facts.json");
    assert.deepEqual(JSON.parse(readFileSync(written, "utf8")), JSON.parse(JSON.stringify(facts)), "facts.json is the returned measurement");
    assert.equal(facts.width, 480);
    assert.equal(facts.height, 270);
    assert.equal(facts.fps, 30);
    assert.ok(Math.abs(facts.duration - 6.2) < 0.05, `duration ${facts.duration}`);
    assert.ok(facts.frames.length >= 16, `${facts.frames.length} frames`);
    for (const t of RECORDED) assert.ok(facts.cuts.some((c) => Math.abs(c - t) <= 0.15), `beat near ${t} s, got ${facts.cuts.join(" ")}`);
    for (const f of facts.frames) assert.ok(statSync(join(dir, "reference", f.file)).size > 1000, `${f.file} holds a frame`);
    assert.ok(statSync(join(dir, "reference", facts.contact)).size > 1000, "the contact sheet is written");
    assert.ok(existsSync(join(dir, "reference", facts.rules)), "the replication rules are copied beside it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("measured beats retime a halo plan and a film's cuts, never under a reading floor", { skip }, async () => {
  const { facts, dir } = await measured();
  try {
    const plain = validateStoryboard(planHalo({ inputs: [BOARD], regions: REGIONS, pitch: PITCH }, "reference-before"));
    const timed = validateStoryboard(planHalo({ inputs: [BOARD], regions: REGIONS, pitch: PITCH, beats: facts.cuts }, "reference-after"));
    assert.equal(timed.scenes.length, plain.scenes.length);
    timed.scenes.forEach((s) => assert.ok(s.d >= minSceneDuration(s) - 1e-9, `${s.pattern} keeps its reading floor`));
    let at = 0;
    for (const [i, s] of timed.scenes.entries()) {
      at += s.d;
      // A boundary is a measured beat, or past the last beat: then the reading floor is all that is left.
      if (i < timed.scenes.length - 1) assert.ok(facts.cuts.some((c) => Math.abs(c - at) <= 0.02) || at > Math.max(...facts.cuts),
        `boundary ${at.toFixed(2)} s sits on a measured beat`);
    }
    assert.notDeepEqual(timed.scenes.map((s) => s.d), plain.scenes.map((s) => s.d), "the measured beats moved the plan");

    const board = filmStoryboard({ video: "footage.mp4", pieces: [{ kind: "callout", source: "brief", at: 4 }], tech: "html", engine: "hyperframes", beats: facts.cuts },
      "reference-film", { width: 1920, height: 1080, duration: 12 }) as { scenes: { pattern: string; d: number }[]; clips: Record<string, { start: number }> };
    const cut = board.clips["footage2"]!.start;
    assert.ok(facts.cuts.some((c) => Math.abs(c - cut) <= 0.02), `the cut at ${cut} s moved onto a beat`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a story in a brand follows a reference's beats, and a beat its reading floor outran is reported", () => {
  const brief = "chips: Plan the watch / in one board | Crew; Night shift; Safety\nphone: Ask / anything | Who has the 22:00 watch?; Ana, until 06:00\nstats: Your crew, / on one clock | 9 crew; 3 watches";
  const args = { pitch: brief, logo: "TIDEWATER", brand: resolve("resources/demo/tidewater-brand.json") };
  const sb = (beats?: number[]) => validateStoryboard(planStory({ ...args, beats }, "reference-story"));
  const timed = sb([3.37, 6.22, 9.03]);
  assert.equal(timed.theme.overrides?.accent, "#18c8a4", "the brand file still dresses the retimed film");
  assert.ok(timed.scenes.some((s, i) => i < 2 && s.d !== sb().scenes[i]!.d), "the measured beats moved the plan");
  const missed = missedBeats(timed.scenes.map((s) => s.d), [3.37, 6.22, 9.03]);
  assert.ok(missed.length < 3 && missed.every((b) => [3.37, 6.22, 9.03].includes(b)));
  // A scene that ran 5.66 s cannot end at 6.22 s: that beat has no cut, and the next one does.
  assert.deepEqual(missedBeats([3.37, 5.66, 3.35], [3.37, 6.22, 9.03]), [6.22]);
  assert.deepEqual(missedBeats([3.37, 2.85, 2], [3.37, 6.22, 9.03, 20]), [], "a beat past the film's end is not missed");
});
