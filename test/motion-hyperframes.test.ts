import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseMotionArgs } from "../src/motion/cli.ts";
import { buildHyperframesProject, validateHyperframesProject } from "../src/motion/hyperframes.ts";
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
    assert.match(html, /GSAP 3\.13\.0/);
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
