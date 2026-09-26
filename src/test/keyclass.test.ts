import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyKeyEvent, KEY_CLASSES } from "../keyclass.js";

const NO_MODS = { has: (): boolean => false };
const CTRL = { has: (m: string): boolean => m === "Ctrl" };

test("every key code classifies into the fixed vocabulary with no character content", () => {
  for (let code = 0; code <= 0x2ff; code++) {
    for (const down of [true, false]) {
      const { record } = classifyKeyEvent(code, down, NO_MODS);
      assert.ok(
        (KEY_CLASSES as readonly string[]).includes(record.cls),
        `code ${code}: ${record.cls} is not a key class`,
      );
      assert.equal(record.k, "key");
      assert.equal(typeof record.down, "boolean");
      // The record carries a class, a direction, optionally a combo: no text,
      // no char, no character content of any kind.
      assert.ok(!("text" in record), `code ${code}: record carries "text"`);
      assert.ok(!("char" in record), `code ${code}: record carries "char"`);
      assert.ok(!("character" in record), `code ${code}: record carries "character"`);
      assert.ok(!("combo" in record), `code ${code}: combo without a non-Shift modifier`);
      const fields = Object.keys(record).sort().join(",");
      assert.ok(
        fields === "cls,down,k" || fields === "combo,cls,down,k",
        `code ${code}: unexpected fields ${fields}`,
      );
    }
  }
});

test("letters classify as char with a name usable only in combos", () => {
  const { record } = classifyKeyEvent(31, true, NO_MODS); // KEY_S
  assert.equal(record.cls, "char");
  assert.equal(record.combo, undefined);
});

test("Ctrl+S produces the combo name, no character", () => {
  const { record } = classifyKeyEvent(31, true, CTRL); // KEY_S with Ctrl held
  assert.equal(record.cls, "char");
  assert.equal(record.combo, "Ctrl+S");
  assert.ok(!("text" in record) && !("char" in record));
});

test("Shift alone never creates a combo", () => {
  const shiftOnly = { has: (m: string): boolean => m === "Shift" };
  const { record } = classifyKeyEvent(31, true, shiftOnly);
  assert.equal(record.combo, undefined);
});

test("modifier keys report themselves so the caller tracks held state", () => {
  const down = classifyKeyEvent(29, true, NO_MODS); // left ctrl
  assert.equal(down.modifier, "Ctrl");
  assert.equal(down.record.cls, "mod");
  assert.equal(down.record.combo, undefined);
});

test("nav, space, enter, tab, esc, backspace and fn classes are stable", () => {
  const cases: Array<[number, string]> = [
    [103, "nav"], // up
    [106, "nav"], // right
    [55, "space"],
    [28, "enter"],
    [15, "tab"],
    [1, "esc"],
    [14, "backspace"],
    [59, "fn"], // F1
    [88, "fn"], // F12
    [2, "char"], // 1
    [11, "char"], // 0
  ];
  for (const [code, cls] of cases) {
    assert.equal(classifyKeyEvent(code, true, NO_MODS).record.cls, cls, `code ${code}`);
  }
});

test("key up events never carry a combo", () => {
  const { record } = classifyKeyEvent(31, false, CTRL);
  assert.equal(record.combo, undefined);
});
