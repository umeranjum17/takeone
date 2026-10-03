import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main, renderDimensions } from "../src/cli.ts";
import { hasFfmpeg } from "./helpers.ts";

test("render aspect and 4k sizing preserve each requested aspect", () => {
  assert.deepEqual(renderDimensions("square", "4k"), { out_w: 3840, out_h: 3840 });
  assert.deepEqual(renderDimensions("portrait", "4k"), { out_w: 2160, out_h: 3840 });
  assert.deepEqual(renderDimensions("landscape", "4k"), { out_w: 3840, out_h: 2160 });
  assert.deepEqual(renderDimensions(undefined, "4k", true), { out_w: 2160, out_h: 3840 });
  assert.throws(() => renderDimensions("square", "8k"), /unknown resolution/);
  assert.throws(() => renderDimensions("vertical"), /unknown aspect/);
});

test("native GIF exports cap both axes without enlarging or changing landscape output", { skip: !hasFfmpeg() }, async () => {
  mkdirSync(join(process.cwd(), "tmp"), { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), "tmp/gif-cap-test-"));
  try {
    mkdirSync(join(dir, "analysis"));
    writeFileSync(join(dir, "take.json"), JSON.stringify({ id: "gif-cap", width: 640, height: 360, trim_end: 0.4 }));
    writeFileSync(join(dir, "analysis/beats.json"), "[]");
    writeFileSync(join(dir, "analysis/decisions.jsonl"), "");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=5:d=0.4",
      "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", join(dir, "screen.webm")]);
    const cases = [
      { options: ["--aspect", "portrait"], size: [608, 1080] },
      { options: ["--set", "out_w=1080", "--set", "out_h=3840"], size: [304, 1080] },
      { options: ["--aspect", "landscape"], size: [1080, 608] },
      { options: ["--set", "out_w=320", "--set", "out_h=180"], size: [320, 180] },
    ];
    for (const { options, size } of cases) {
      assert.equal(await main(["render", dir, "--format", "gif", "--set", "fps=5",
        "--set", "motion_blur=0", "--set", "fade_s=0", "--set", "preset=ultrafast", ...options]), 0);
      const gif = join(dir, "out/gif-cap.gif");
      const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", gif], { encoding: "utf8" }));
      const { width, height } = probe.streams[0];
      assert.deepEqual([width, height], size);
      assert.ok(width <= 1080 && height <= 1080);
      assert.ok(width * height <= 1920 * 1080);
      if (width >= height) {
        const previous = join(dir, "previous.gif");
        execFileSync("ffmpeg", ["-y", "-i", join(dir, "out/gif-cap.mp4"), "-vf",
          "fps=15,scale='min(1080,iw)':-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse", previous], { stdio: "ignore" });
        assert.deepEqual(readFileSync(gif), readFileSync(previous), "landscape export bytes stay unchanged");
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
