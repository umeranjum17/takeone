// Planner images carry no screen pixels in the clear: a text zone OCR read nothing in is still blurred.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTake } from "../src/make.ts";
import { DEFAULTS } from "../src/camera/defaults.ts";
import { blurredStill } from "../src/decide/ocr.ts";
import type { TakeMeta } from "../src/types.ts";
import { hasFfmpeg } from "./helpers.ts";

const needsFfmpeg = hasFfmpeg() ? undefined : "requires system ffmpeg and ffprobe on PATH";
const W = 320, H = 180;
/** Where a patch of 1-pixel stripes sits: a small zone (under the 25% text-zone cap) that holds detail OCR cannot read as words. */
const PATCH = { x: 180, y: 60, w: 120, h: 80 };
const FAST = { ...DEFAULTS, preset: "veryfast", out_w: W, out_h: H, ripple_ms: 0, fade_s: 0 };

function buildTake(dir: string): void {
  execFileSync("ffmpeg", [
    "-nostdin", "-f", "lavfi", "-i", `color=c=gray:s=${W}x${H}:d=10:r=30`,
    "-f", "lavfi", "-i", `nullsrc=s=${PATCH.w}x${PATCH.h}:d=10:r=30,geq=lum='255*mod(X+N\\,2)':cb=128:cr=128`,
    "-filter_complex", `[0][1]overlay=${PATCH.x}:${PATCH.y}`,
    "-c:v", "mpeg4", "-q:v", "1", "-f", "matroska", "-frames:v", "300", "-y", join(dir, "screen.webm"),
  ], { stdio: "ignore" });
  writeFileSync(join(dir, "frames.tsv"), Array.from({ length: 300 }, (_, i) => `${i * 3000}\t${i * 33333333}\n`).join(""));
  const events = [
    { t: 100, k: "win", cls: "chromium", title: "App", rect: [0, 0, W, H] },
    { t: 400, k: "ptr", x: 240, y: 100 },
    { t: 500, k: "btn", b: "left", down: true },
    { t: 560, k: "btn", b: "left", down: false },
  ];
  writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const take: TakeMeta = { id: "t1", stream: { w: W, h: H }, scale: 1, offset_ms: 0, pointer: "hyprland" };
  writeFileSync(join(dir, "take.json"), JSON.stringify(take));
}

/** Standard deviation of the grey pixels in a crop of an image or video frame: flat when blurred, large on stripes. */
function spread(input: Buffer | string, crop: [number, number, number, number]): number {
  const [x, y, w, h] = crop;
  const source = typeof input === "string" ? ["-i", input] : ["-i", "pipe:0"];
  const args = ["-nostdin", "-v", "error", ...source, "-frames:v", "1", "-vf", `crop=${w}:${h}:${x}:${y},format=gray`, "-f", "rawvideo", "-"];
  const raw = execFileSync("ffmpeg", args, { ...(typeof input === "string" ? {} : { input }), maxBuffer: 1 << 24 });
  const mean = raw.reduce((n, v) => n + v, 0) / raw.length;
  return Math.sqrt(raw.reduce((n, v) => n + (v - mean) ** 2, 0) / raw.length);
}

test("a text zone OCR read nothing in reaches the planner blurred, never sharp", { skip: needsFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-thumbpriv-"));
  try {
    buildTake(dir);
    mkdirSync(join(dir, "cfg", "takeone"), { recursive: true });
    // An Anthropic route that declares image support so the planner is sent keyframe thumbnails.
    writeFileSync(join(dir, "cfg", "takeone", "planner.json"), JSON.stringify({ backend: "anthropic", auth: "apiKey", model: "claude-opus-5-5", supportsImages: true }));
    const bodies: string[] = [];
    await assert.rejects(makeTake(dir, {
      apiKey: "test-key-000", camera: FAST, configDir: join(dir, "cfg"), log: () => {}, warn: () => {},
      fetchImpl: (async (_url, init) => {
        bodies.push(String(init?.body));
        if (bodies.length > 1) return new Response("no", { status: 500 });
        // Answer the film call so the image-bearing beat request is actually sent.
        const schema = JSON.parse(bodies[0]!).tools[0].input_schema.properties as Record<string, {
          required: string[]; properties: { probabilities: { properties: Record<string, unknown> } } }>;
        const input = Object.fromEntries(Object.entries(schema).map(([name, property]) => {
          const keys = Object.keys(property.properties.probabilities.properties);
          const pick = keys.includes("false") ? "false" : keys[0]!;
          return [name, { probabilities: Object.fromEntries(keys.map(key => [key, Number(key === pick)])), pick,
            ...Object.fromEntries(property.required.filter(key => !["probabilities", "pick"].includes(key)).map(key => [key, "fixture"])) }];
        }));
        return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "decisions", input }],
          usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
      }) as typeof fetch,
    }), /has no usable model decision; no film was rendered/);
    assert.ok(!existsSync(join(dir, "out", "t1.mp4")), "a failed beat request cannot render a fallback film");
    // Every JPEG the planner was sent, wherever the provider put it in the request.
    const thumbs = bodies.flatMap((b) => b.match(/\/9j\/[A-Za-z0-9+/=]+/g) ?? []).map((b64) => Buffer.from(b64, "base64"));
    assert.ok(thumbs.length > 0, "the planner request carried no thumbnail; the check below would prove nothing");
    const beats = JSON.parse(readFileSync(join(dir, "analysis", "beats.json"), "utf8")) as { zones: { type: string; bbox: [number, number, number, number] }[] }[];
    const zone = beats.flatMap((b) => b.zones).find((z) => z.type === "act" && z.bbox[2] * z.bbox[3] / (W * H) < 0.25)!;
    assert.ok(zone, "no small action zone to inspect");
    const [zx, zy, zw, zh] = zone.bbox;
    // The zone's interior below its label, inside the patch: sharp in the source, so a leak shows as spread.
    const inside = (k: number): [number, number, number, number] => [zx + 0.15 * zw, zy + 0.45 * zh, 0.7 * zw, 0.4 * zh].map((v) => Math.round(v * k)) as [number, number, number, number];
    assert.ok(spread(join(dir, "screen.webm"), inside(1)) > 100, "source zone is not sharp detail");
    for (const jpg of thumbs) {
      const k = 512 / W; // thumbnail pixels per source pixel
      assert.ok(spread(jpg, inside(k)) < 20, "unblurred text-zone pixels reached the planner");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rendered frame is blurred before the score judge sees it", { skip: needsFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-thumbpriv-"));
  try {
    const png = join(dir, "frame.png");
    execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", `nullsrc=s=640x360:d=1:r=1,geq=lum='255*mod(X\\,2)':cb=128:cr=128`, "-frames:v", "1", "-y", png]);
    assert.ok(spread(readFileSync(png), [100, 100, 200, 100]) > 100);
    assert.ok(spread(Buffer.from(await blurredStill(png)), [100, 100, 200, 100]) < 20);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
