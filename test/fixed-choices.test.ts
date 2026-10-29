import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";

// docs/fixed-choices.md names the file and symbol behind every fixed choice, so a
// renamed or removed rule has to be re-classified there.
test("every fixed choice names a file and symbol that exist", () => {
  const doc = readFileSync("docs/fixed-choices.md", "utf8");
  const refs = [...doc.matchAll(/`(src\/[^`]+)` · `([^`]+)`/g)];
  assert.ok(refs.length >= 50, `only ${refs.length} references found`);
  for (const [, file, symbol] of refs) {
    assert.ok(existsSync(file!), `${file} is gone`);
    assert.ok(readFileSync(file!, "utf8").includes(symbol!), `${symbol} is not in ${file}`);
  }
});

test("the open taste rules stay in their own table", () => {
  const doc = readFileSync("docs/fixed-choices.md", "utf8");
  const open = doc.split("## Fixed, and a taste rule")[1] ?? "";
  for (const rule of ["planStoryboard", "planTake", "Math.min(duration, 3.1)", "t0 + 2.2"]) assert.ok(open.includes(rule), rule);
});
