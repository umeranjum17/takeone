import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHyperframesProject } from "../src/motion/hyperframes.ts";
import { ingestSegments, segmentStale } from "../src/motion/segment.ts";
import { StoryboardError, validateStoryboard } from "../src/motion/storyboard.ts";
import { hasFfmpeg } from "./helpers.ts";

// A model-written page is untrusted code: these tests run real pages in the pinned shell, offline, and read the frames back.
if (!hasFfmpeg()) throw new Error("requires system ffmpeg and ffprobe on PATH");

const CANVAS = `<!doctype html><html><body style="margin:0;background:#101820"><canvas id=c></canvas><p id=t style="position:absolute;left:10%;top:40%;margin:0;color:#fff;font:24px sans-serif">Hello</p>
<script>const c=document.getElementById('c'),g=c.getContext('2d');c.width=innerWidth;c.height=innerHeight;
window.takeoneSegment={seek(t){g.fillStyle='#101820';g.fillRect(0,0,c.width,c.height);g.fillStyle='#7fd6b0';g.fillRect(c.width*0.1+t*c.width*0.5,c.height*0.7,c.width*0.1,c.height*0.1);}};
window.takeoneSegment.seek(0);</script></body></html>`;
const THREE_PAGE = `<!doctype html><html><body style="margin:0"><canvas id=c></canvas><script>
const r=new THREE.WebGLRenderer({canvas:document.getElementById('c')});r.setSize(innerWidth,innerHeight,false);
const s=new THREE.Scene(),cam=new THREE.PerspectiveCamera(50,innerWidth/innerHeight,.1,100);cam.position.z=4;
const m=new THREE.Mesh(new THREE.BoxGeometry(1.5,1.5,1.5),new THREE.MeshNormalMaterial());s.add(m);
window.takeoneSegment={seek(t){m.rotation.set(t*2,t*3,0);r.render(s,cam);}};window.takeoneSegment.seek(0);</script></body></html>`;

function film(dir: string, pages: Record<string, string>) {
  const segments: Record<string, { file: string; d: number }> = {};
  for (const [id, html] of Object.entries(pages)) { writeFileSync(join(dir, `${id}.html`), html); segments[id] = { file: `${id}.html`, d: 1 }; }
  return validateStoryboard({
    version: 1, id: "segments", output: { out_w: 320, out_h: 180, workers: 2 }, theme: { name: "paper", overrides: {} },
    source: { kind: "image", files: [] }, screens: {}, regions: [], layout: { kind: "single" }, segments,
    scenes: Object.keys(pages).map(id => ({ pattern: "segment", d: 1, segment: id, cut: true })),
  });
}

const lumaAt = (file: string, n: number) => execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-i", file, "-vf", `select=eq(n\\,${n}),scale=32:18`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);

test("a Canvas and a Three.js segment render offline to the film's size, move with time, and re-render only when the page changes", { timeout: 180_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-segment-"));
  try {
    const sb = film(dir, { canvas: CANVAS, cube: THREE_PAGE });
    assert.ok(sb.segments && segmentStale(dir, sb, "canvas"), "never rendered");
    await ingestSegments(dir, sb);
    for (const id of ["canvas", "cube"]) {
      const file = join(dir, sb.segments![id]!.video!);
      const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=width,height,nb_read_frames", "-of", "json", file], { encoding: "utf8" })) as { streams: { width: number; height: number; nb_read_frames: string }[] };
      assert.deepEqual([probe.streams[0]!.width, probe.streams[0]!.height, probe.streams[0]!.nb_read_frames], [320, 180, "60"], id);
      assert.notDeepEqual(lumaAt(file, 0), lumaAt(file, 45), `${id} changes between 0 s and 0.75 s`);
      assert.deepEqual(lumaAt(file, 30), lumaAt(file, 30), `${id} frame 30 reads back the same`);
    }
    assert.ok(!segmentStale(dir, sb, "canvas") && !segmentStale(dir, sb, "cube"), "rendered pages are current");
    const html = readFileSync(buildHyperframesProject(dir, validateStoryboard(JSON.parse(JSON.stringify(sb)))).html, "utf8");
    assert.match(html, /<video class="clip" data-start="1" data-duration="1" data-track-index="1" data-playback-start="0"[^>]*src="assets\/[^"]*cube\.mp4"/, "the segment is a full-frame video layer");
    writeFileSync(join(dir, "canvas.html"), CANVAS.replace("#7fd6b0", "#ff0000"));
    assert.ok(segmentStale(dir, sb, "canvas") && !segmentStale(dir, sb, "cube"), "only the edited page is stale");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a segment that breaks the contract fails the render and says why", { timeout: 180_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-segment-bad-"));
  const bad = async (html: string, why: RegExp) => {
    const sb = film(dir, { bad: html });
    await assert.rejects(ingestSegments(dir, sb), why);
    assert.equal(sb.segments!["bad"]!.video, undefined, "a failed segment keeps no video");
  };
  try {
    await bad("<!doctype html><body>no seek</body>", /segment bad \(bad\.html\).*no window\.takeoneSegment\.seek/);
    await bad(`<!doctype html><body><script>window.takeoneSegment={seek(){}};fetch("https://example.com/x.js").catch(()=>{});</script></body>`, /tried to fetch https:\/\/example\.com\/x\.js/);
    await bad(`<!doctype html><body><p style="position:absolute;left:0;top:50%;margin:0;font:20px sans-serif">Cut at the edge</p><script>window.takeoneSegment={seek(){}};</script></body>`, /text outside the 5% safe inset at 0\.000 s: Cut at the edge/);
    await bad(`<!doctype html><body><script>window.takeoneSegment={seek(t){if(t>0.5)throw new Error("boom at "+t.toFixed(2));}};</script></body>`, /boom at 0\.52/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a segment scene names a segment the storyboard declares, no longer than the page", () => {
  const raw = { version: 1, id: "s", source: { kind: "image", files: [] }, screens: {}, regions: [], segments: { a: { file: "a.html", d: 2 } }, scenes: [{ pattern: "segment", d: 2, segment: "a" }] };
  assert.equal(validateStoryboard(raw).scenes[0]!.segment, "a");
  assert.throws(() => validateStoryboard({ ...raw, scenes: [{ pattern: "segment", d: 2, segment: "b" }] }), (e: unknown) => e instanceof StoryboardError && /unknown segment b/.test(e.message));
  assert.throws(() => validateStoryboard({ ...raw, scenes: [{ pattern: "segment", d: 3, segment: "a" }] }), /shorter than the 3\.00 s it plays/);
});
