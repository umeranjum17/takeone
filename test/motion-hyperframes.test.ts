import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseMotionArgs } from "../src/motion/cli.ts";
import { buildHyperframesProject, validateHyperframesProject, writeScenes } from "../src/motion/hyperframes.ts";
import { validateStoryboard } from "../src/motion/storyboard.ts";

function fixture(): { dir: string; sb: ReturnType<typeof validateStoryboard> } {
  const dir = mkdtempSync(join(tmpdir(), "takeone-hyperframes-"));
  mkdirSync(join(dir, "sources", "clips", "C-1"), { recursive: true });
  cpSync(resolve("resources/demo/tidewater-board.png"), join(dir, "sources", "tidewater.png"));
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x335577:s=320x180:d=2:r=30",
    "-pix_fmt", "yuv420p", join(dir, "sources", "clip.mp4")]);
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:a", "pcm_s16le", join(dir, "sources", "music.wav")]);
  const sb = validateStoryboard({
    version: 1, id: "hyperframes-test",
    output: { out_w: 1920, out_h: 1080, fps: 60, workers: 2 },
    theme: { name: "paper", overrides: {} },
    source: { kind: "image", files: [join(dir, "sources", "tidewater.png")] },
    screens: { S1: { file: "sources/tidewater.png", width: 2560, height: 1440 } },
    regions: [],
    clips: {
      C: {
        files: ["sources/clip.mp4"], start: 0.5, d: 2,
        frames: [{ dir: "sources/clips/C-1", count: 120, width: 320, height: 180, aspect: 16 / 9 }],
      },
    },
    audio: { file: "sources/music.wav", volume: 0.4 },
    layout: { kind: "single" },
    scenes: [
      { pattern: "kinetic-type", d: 6, title: "Make it move", subtitle: "TakeOne" },
      { pattern: "clip", d: 2, clip: "C", label: "Footage" },
      { pattern: "end-card", d: 6, screen: "S1", logo: "TakeOne", cta: "Try it", url: "example.com" },
    ],
    planner: { by: "user", abstained: [] },
  });
  return { dir, sb };
}

test("hyperframes project is offline, timed and layer-shaped", () => {
  const { dir, sb } = fixture();
  try {
    const p = buildHyperframesProject(dir, sb);
    const html = readFileSync(p.html, "utf8");
    assert.equal(p.frames, 840);
    assert.equal(p.duration, 14);
    assert.match(html, /data-composition-id="main"[^>]*data-duration="14"[^>]*data-fps="60"/);
    assert.match(html, /<video[^>]*data-start="6"[^>]*data-duration="2"[^>]*data-track-index="1"[^>]*data-playback-start="0.5"/);
    assert.equal((html.match(/<audio\b/g) ?? []).length, 1);
    assert.match(html, /<audio[^>]*data-duration="14"[^>]*data-volume="0.4"/);
    assert.ok(!html.includes("file://"), "no file:// URLs survive");
    assert.ok(!/(?:src|href)="https?:/.test(html), "no network references");
    assert.ok(!/url\(["']?https?:/.test(html), "no network css references");
    assert.equal((html.match(/GSAP 3\.13\.0/g) ?? []).length, 1, "GSAP is inlined exactly once");
    assert.match(html, /data-track-index="/);
    assert.ok(readdirSync(join(p.dir, "assets")).some((f) => f.endsWith(".ttf")));
    for (const m of html.matchAll(/assets\/[^"'\s)\\]+/g)) {
      assert.ok(existsSync(join(p.dir, m[0].replace(/[?#].*$/, ""))), m[0]);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("hyperframes validation rejects a missing vendored asset", () => {
  const { dir, sb } = fixture();
  try {
    const p = buildHyperframesProject(dir, sb);
    const font = readdirSync(join(p.dir, "assets")).find((f) => f.endsWith(".ttf"))!;
    unlinkSync(join(p.dir, "assets", font));
    assert.throws(() => validateHyperframesProject(p.dir), /is missing/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("motion engine defaults to hyperframes and legacy is an explicit opt-out", () => {
  assert.equal(parseMotionArgs([]).engine, "hyperframes");
  assert.equal(parseMotionArgs(["--engine", "legacy"]).engine, "legacy");
  assert.equal(parseMotionArgs(["--engine", "hyperframes"]).engine, "hyperframes");
  assert.throws(() => parseMotionArgs(["--engine", "other"]), /hyperframes or legacy/);
});

test("a fill clip plays edge to edge with its label inside the safe inset", () => {
  const { dir, sb } = fixture();
  try {
    sb.scenes[1] = { ...sb.scenes[1]!, fill: true };
    const html = readFileSync(buildHyperframesProject(dir, sb).html, "utf8");
    assert.match(html, /<video[^>]*data-start="6"[^>]*style="[^"]*left:0;top:0;width:1920px;height:1080px;object-fit:cover/);
    const chip = /<div data-safe style="[^"]*left:([\d.]+)px;bottom:([\d.]+)px;[^"]*"[^>]*data-start="6" data-duration="2">Footage<\/div>/.exec(html);
    assert.ok(chip, "the label rides on the footage, timed to its scene");
    assert.ok(+chip[1]! >= 1920 * 0.05 && +chip[2]! >= 1080 * 0.05, "inside the 5% inset");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a rendered film is cut into one file per scene on its exact frames, listed in scenes.json", { timeout: 120_000 }, async () => {
  const { dir, sb } = fixture();
  try {
    sb.output = { ...sb.output, out_w: 320, out_h: 180 };
    mkdirSync(join(dir, "out"));
    const film = join(dir, "out", `${sb.id}.mp4`);
    // A 14 s film whose every frame shows its own number: a cut on the wrong frame shows the wrong one.
    execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=60:d=14", "-f", "lavfi", "-i", "sine=d=14",
      "-shortest", "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p", "-c:a", "aac", film]);
    const cuts = await writeScenes(dir, sb, film);
    const manifest = JSON.parse(readFileSync(join(dir, "out", "scenes.json"), "utf8"));
    assert.deepEqual(manifest.scenes, cuts);
    assert.deepEqual(cuts.map(c => [c.file, c.start, c.end, c.title, c.frames]), [
      ["out/scenes/01-make-it-move.mp4", 0, 6, "Make it move", 360],
      ["out/scenes/02-footage.mp4", 6, 8, "Footage", 120],
      ["out/scenes/03-takeone.mp4", 8, 14, "TakeOne", 360],
    ]);
    // The second scene's first frame is the film's frame 360.
    const frame = (file: string, at: number) => execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-i", file, "-vf", `select=eq(n\\,${at})`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
    const a = frame(join(dir, "out/scenes/02-footage.mp4"), 0), b = frame(film, 360);
    const diff = a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i]!)), 0);
    assert.ok(diff <= 24, `scene 2 starts on film frame 360 (max luma delta ${diff})`);
    for (const c of cuts) assert.equal(execFileSync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_name", "-of", "csv=p=0", join(dir, c.file)], { encoding: "utf8" }).trim(), "aac");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
