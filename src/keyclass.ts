/**
 * evdev key-code classification. Characters are never recorded: the emitted
 * record carries a class and, when a non-Shift modifier is held, a shortcut
 * name like "Ctrl+S" (modifiers plus one key name, no text).
 */

export const KEY_CLASSES = [
  "char",
  "space",
  "enter",
  "backspace",
  "tab",
  "esc",
  "nav",
  "mod",
  "fn",
] as const;
export type KeyClass = (typeof KEY_CLASSES)[number];

// Linux event codes (input-event-codes.h).
const MODIFIER_NAMES: Record<number, string> = {
  29: "Ctrl", // left ctrl
  97: "Ctrl", // right ctrl
  56: "Alt", // left alt
  100: "Alt", // right alt
  125: "Meta", // left meta
  126: "Meta", // right meta
  42: "Shift", // left shift
  54: "Shift", // right shift
};

const NAV_NAMES: Record<number, string> = {
  102: "Home",
  107: "End",
  104: "PageUp",
  109: "PageDown",
  103: "Up",
  108: "Down",
  105: "Left",
  106: "Right",
  110: "Insert",
  111: "Delete",
};

const PUNCT_NAMES: Record<number, string> = {
  12: "Minus",
  13: "Equal",
  26: "LeftBracket",
  27: "RightBracket",
  39: "Semicolon",
  40: "Apostrophe",
  41: "Grave",
  43: "Backslash",
  51: "Comma",
  52: "Dot",
  53: "Slash",
};

const LETTERS: Record<number, string> = {
  16: "Q", 17: "W", 18: "E", 19: "R", 20: "T", 21: "Y", 22: "U", 23: "I", 24: "O", 25: "P",
  30: "A", 31: "S", 32: "D", 33: "F", 34: "G", 35: "H", 36: "J", 37: "K", 38: "L",
  44: "Z", 45: "X", 46: "C", 47: "V", 48: "B", 49: "N", 50: "M",
};

const fnName = (code: number): string | undefined =>
  code >= 59 && code <= 68
    ? `F${code - 58}`
    : code === 87
      ? "F11"
      : code === 88
        ? "F12"
        : undefined;

export interface KeyInfo {
  cls: KeyClass;
  /** Stable key name, used only for shortcut combos. Never a typed character. */
  name?: string;
}

export function keyInfoFor(code: number): KeyInfo {
  if (code === 1) return { cls: "esc", name: "Esc" };
  if (code === 28) return { cls: "enter", name: "Enter" };
  if (code === 14) return { cls: "backspace", name: "Backspace" };
  if (code === 15) return { cls: "tab", name: "Tab" };
  if (code === 57) return { cls: "space", name: "Space" };
  const mod = MODIFIER_NAMES[code];
  if (mod !== undefined) return { cls: "mod", name: mod };
  const nav = NAV_NAMES[code];
  if (nav !== undefined) return { cls: "nav", name: nav };
  const fn = fnName(code);
  if (fn !== undefined) return { cls: "fn", name: fn };
  // Caps lock (58), num lock (69), scroll lock (70), print (99), pause (119):
  // function-ish, never content.
  if (code === 58 || code === 69 || code === 70 || code === 99 || code === 119)
    return { cls: "fn", name: `Key${code}` };
  const letter = LETTERS[code];
  if (letter !== undefined) return { cls: "char", name: letter };
  if (code >= 2 && code <= 11) return { cls: "char", name: String(code === 11 ? 0 : code - 1) };
  const punct = PUNCT_NAMES[code];
  if (punct !== undefined) return { cls: "char", name: punct };
  // Anything else (international, media, keyboard-attach): content-bearing
  // keys classify as char; the class carries no character itself.
  return { cls: "char", name: `Key${code}` };
}

/** Modifiers that make a key press a shortcut (Shift alone does not). */
const COMBO_MODS = ["Ctrl", "Alt", "Meta"];
export type HeldMods = { has(name: string): boolean };

/**
 * Shortcut name for a non-modifier key press, or null when no non-Shift
 * modifier is held. Order is Ctrl+Alt+Meta+Key.
 */
export function comboName(key: KeyInfo, held: HeldMods): string | null {
  if (key.cls === "mod") return null;
  const mods = COMBO_MODS.filter((m) => held.has(m));
  if (mods.length === 0 || key.name === undefined) return null;
  return [...mods, key.name].join("+");
}

/** The events.jsonl key record: a class, a direction, and never a character. */
export interface KeyEventRecord {
  k: "key";
  cls: KeyClass;
  down: boolean;
  /** Shortcut name like "Ctrl+S"; only with a non-Shift modifier held. */
  combo?: string;
}

/** Everything the tap needs for one EV_KEY record, computed purely. */
export interface KeyEventResult {
  record: KeyEventRecord;
  /** Set when the key is a modifier, so the caller tracks held state. */
  modifier: string | null;
}

export function classifyKeyEvent(code: number, down: boolean, held: HeldMods): KeyEventResult {
  const info = keyInfoFor(code);
  const record: KeyEventRecord = { k: "key", cls: info.cls, down };
  if (down && info.cls !== "mod") {
    const combo = comboName(info, held);
    if (combo !== null) record.combo = combo;
  }
  return { record, modifier: info.cls === "mod" ? (info.name ?? null) : null };
}
