import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runMotion } from "../src/motion/cli.ts";
import { classifyText } from "../src/motion/redact.ts";
import { decodePng } from "../src/motion/png.ts";

const fixture = resolve("test/fixtures/a64-synthetic.png");

test("each sensitive text class is classified without retaining its value", () => {
  const examples = new Map([
    ["email", "demo@example.test"], ["phone", "+1 202 555 0189"],
    ["api-key", "sk-demo-key-1234567890"], ["token", "token: abcdefghijklmnop"],
    ["account", "account: demoUser"], ["home-path", "/home/demo/Documents/file.txt"],
    ["ip-address", "192.0.2.5"],
  ]);
  for (const [kind, text] of examples) assert.ok(classifyText(text).includes(kind), kind);
});

test("dry-run masks synthetic personal text, QR and barcode without contacting a planner", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-redaction-"));
  const savedLog = console.log;
  console.log = () => {};
  try {
    assert.equal(await runMotion([fixture, "--redaction-dry-run", "--out", dir], dir), 0);
    const report = JSON.parse(readFileSync(join(dir, "redaction-report.json"), "utf8")) as
      { image: string; scanClean: boolean; masks: { kind: string; box: number[] }[] }[];
    assert.equal(report[0]?.scanClean, true);
    const kinds = new Set(report[0]!.masks.map(m => m.kind));
    for (const kind of ["email", "phone", "api-key", "token", "account", "home-path", "ip-address", "qr-code", "barcode"])
      assert.ok(kinds.has(kind), kind);
    for (const { box } of report[0]!.masks) {
      assert.equal(box.length, 4);
      assert.ok(box.every(Number.isFinite) && box[2]! > 0 && box[3]! > 0);
    }
    assert.ok(!readFileSync(join(dir, "redaction-report.json"), "utf8").includes("demo@example.test"));
    const image = decodePng(readFileSync(join(dir, "screen-1.png")));
    for (const [x, y] of [[80, 75], [100, 170], [100, 260], [800, 160], [700, 750]]) {
      const at = (y! * image.width + x!) * image.channels;
      assert.deepEqual([...image.data.slice(at, at + 3)], [0, 0, 0]);
    }
    assert.equal(await runMotion([fixture, "--redaction-dry-run", "--out", dir], dir), 0);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "redaction-report.json"), "utf8")), report);
  } finally { console.log = savedLog; rmSync(dir, { recursive: true, force: true }); }
});

test("a missing local scanner fails closed before producing a clean report", async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-redaction-"));
  const old = process.env.PATH;
  try {
    process.env.PATH = dir;
    await assert.rejects(runMotion([fixture, "--redaction-dry-run", "--out", dir], dir), /redaction cannot run tesseract; image not sent/);
    assert.throws(() => readFileSync(join(dir, "redaction-report.json")));
  } finally { process.env.PATH = old; rmSync(dir, { recursive: true, force: true }); }
});

test("unsupported screenshots stop without reporting a clean preview", async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-redaction-"));
  try {
    await assert.rejects(runMotion(["docs/motion.md", "--redaction-dry-run", "--out", dir], dir), /redaction supports only/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
