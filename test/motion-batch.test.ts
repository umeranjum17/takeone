import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fillTemplate, parseCsv, planBatch } from "../src/motion/batch.ts";
import { runMotion } from "../src/motion/cli.ts";
import { minSceneDuration } from "../src/motion/storyboard.ts";

const TEMPLATE = resolve("resources/demo/batch/welcome.json"), ROWS = resolve("resources/demo/batch/customers.csv");
const template = () => JSON.parse(readFileSync(TEMPLATE, "utf8")) as Record<string, unknown>;

test("CSV rows: quoted commas, quotes and line breaks, CRLF, a BOM and blank lines", () => {
  const { columns, rows } = parseCsv('﻿name,company\r\n"Okafor, Ada","The ""Lab""\nNorth"\r\n\r\nLi,Quarry');
  assert.deepEqual(columns, ["name", "company"]);
  assert.deepEqual(rows, [{ name: "Okafor, Ada", company: 'The "Lab"\nNorth' }, { name: "Li", company: "Quarry" }]);
  assert.throws(() => parseCsv("a,b\n1"), /data row 1: 1 fields for 2 columns/);
  assert.throws(() => parseCsv("a,a\n1,2"), /column a appears twice/);
  assert.throws(() => parseCsv("a\n"), /no rows/);
  assert.throws(() => parseCsv('a\n"open'), /never closed/);
});

test("a template's {{column}} strings are filled from the row; numbers and keys are left alone", () => {
  assert.deepEqual(fillTemplate({ t: "Hi {{ name }}", d: 4, list: ["{{plan}} plan"], "{{name}}": 1 }, { name: "Ada", plan: "Pro" }),
    { t: "Hi Ada", d: 4, list: ["Pro plan"], "{{name}}": 1 });
  assert.throws(() => fillTemplate({ t: "{{nope}}" }, { name: "Ada" }), /\{\{nope\}\} names no column/);
});

test("the demo template plans one checked film per row, each in its row's accent", () => {
  const rows = planBatch(template(), readFileSync(ROWS, "utf8"));
  assert.deepEqual(rows.map(r => r.id), ["ada-okafor", "li-wei", "bartholomew-oyelaran-whitfield", "jo-park"]);
  for (const r of rows) {
    const [card, end] = r.storyboard.scenes;
    assert.equal(r.storyboard.id, r.id);
    assert.equal(card!.pattern, "welcome");
    assert.ok(card!.d >= minSceneDuration(card!), `${r.id}: the card clears every reading hold`);
    assert.equal(end!.pattern, "end-card");
  }
  assert.deepEqual(rows.map(r => r.storyboard.theme.overrides.accent), ["#d9673f", "#2f6f5e", "#1d2b53", "#f2c14e"]);
  assert.equal(rows[2]!.storyboard.scenes[0]!.subtitle, "Your Enterprise workspace at Northwind Freight & Logistics is ready.");
});

test("every bad row is named before anything renders: colour, glyphs, reading time, ids", () => {
  const csv = ["id,name,company,plan,accent", "ok,Ada,Lumen,Pro,#d9673f", "bad-colour,Li,Quarry,Team,teal", "glyphs,李伟,Quarry,Team,#2f6f5e",
    "long,Ada,Lumen,Pro plan for the whole company and everyone in it,#d9673f", "ok,Jo,Fable,Starter,#f2c14e", "bad id,Jo,Fable,Starter,#f2c14e"].join("\n");
  assert.throws(() => planBatch(template(), csv), (e: Error) => {
    assert.match(e.message, /^5 of 6 rows cannot be rendered; nothing was written/);
    assert.match(e.message, /row 2 \(bad-colour\): theme\.overrides/);
    assert.match(e.message, /row 3 \(glyphs\): .*missing glyph/);
    assert.match(e.message, /row 4 \(long\): .*reading-time floor/);
    assert.match(e.message, /row 5 \(ok\): id ok repeats an earlier row/);
    assert.match(e.message, /row 6 \(bad id\): id "bad id"/);
    return true;
  });
  assert.throws(() => planBatch({ ...template(), theme: { name: "editorial", overrides: {} }, scenes: [{ pattern: "statement", d: 3, title: "Hi" }] }, "name\nAda"), /no \{\{column\}\} field/);
  assert.throws(() => planBatch(template(), "name,company,plan\nAda,Lumen,Pro"), /\{\{accent\}\} names no column; the columns are name, company, plan/);
  assert.deepEqual(planBatch(template(), "name,company,plan,accent\nAda,Lumen,Pro,#d9673f\nLi,Quarry,Team,#2f6f5e").map(r => r.id), ["1", "2"]);
});

test("--data --plan-only writes a take per row and batch.json without rendering", async () => {
  const dir = mkdtempSync(join(tmpdir(), "takeone-batch-"));
  try {
    const out = join(dir, "batch"), csv = join(dir, "rows.csv");
    writeFileSync(csv, "id,name,company,plan,accent\nada,Ada Okafor,Lumen Labs,Pro,#d9673f\nli,Li Wei,Quarry,Team,#2f6f5e\n");
    assert.equal(await runMotion(["--storyboard", TEMPLATE, "--data", csv, "--out", out, "--plan-only"], join(dir, "takes")), 0);
    const batch = JSON.parse(readFileSync(join(out, "batch.json"), "utf8")) as { takes: { id: string; out: string }[] };
    assert.deepEqual(batch.takes.map(t => [t.id, t.out]), [["ada", "ada/out/ada.mp4"], ["li", "li/out/li.mp4"]]);
    const sb = JSON.parse(readFileSync(join(out, "li", "storyboard.json"), "utf8")) as { scenes: { title?: string }[]; theme: { overrides: { accent: string } } };
    assert.equal(sb.scenes[0]!.title, "Li Wei");
    assert.equal(sb.theme.overrides.accent, "#2f6f5e");
    assert.equal(JSON.parse(readFileSync(join(out, "li", "take.json"), "utf8")).motion.pattern, "welcome+end-card");
    await assert.rejects(runMotion(["shot.png", "--storyboard", TEMPLATE, "--data", csv], join(dir, "takes")), /--data fills a --storyboard template/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
