import test from "node:test";
import assert from "node:assert/strict";
import { brandFromUrl, matchFont, toHex } from "../src/motion/brand-link.ts";

test("page colours are read as hex and anything that is not a plain colour is skipped, never guessed", () => {
  assert.equal(toHex("rgb(8, 9, 10)"), "#08090a");
  assert.equal(toHex("rgba(247, 248, 248, 1)"), "#f7f8f8");
  assert.equal(toHex("#FFEBC6"), "#ffebc6");
  assert.equal(toHex("#abc"), "#aabbcc");
  assert.equal(toHex("var(--blue)"), undefined);
  assert.equal(toHex("color(display-p3 1 0 0)"), undefined);
});

test("a page font maps onto a bundled family and a near-match says it is one", () => {
  assert.deepEqual(matchFont("Inter Variable", "body"), { family: "Inter SemiBold", from: "Inter Variable", exact: true });
  assert.deepEqual(matchFont("Berkeley Mono", "mono"), { family: "JetBrains Mono", from: "Berkeley Mono", exact: false });
  assert.deepEqual(matchFont("Georgia", "display"), { family: "Instrument Serif", from: "Georgia", exact: false });
  assert.equal(matchFont("Circular Std", "display")?.family, "Inter Bold");
  assert.equal(matchFont("Circular Std", "display")?.exact, false);
  assert.equal(matchFont("", "body"), undefined);
});

test("only an http(s) link is read", async () => {
  await assert.rejects(brandFromUrl("file:///etc/passwd", "/nonexistent-out"), /expected an http\(s\) link/);
});
