// Local preview gate for screenshot planning. Never puts recognized text or decoded barcodes in reports.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { decodePng, encodePng } from "./png.ts";

type Box = [number, number, number, number];
type Mask = { kind: string; box: Box };
type Word = { text: string; box: Box; line: string };

// The report contains categories and geometry, never OCR text, decoded codes or source paths.
export interface RedactionReport { image: string; width: number; height: number; masks: Mask[]; scanClean: boolean }

const rules: [string, RegExp][] = [
  ["email", /[\w.+-]+\s*@\s*[\w.-]+\s*\.\s*[a-z]{2,}/i],
  ["phone", /(?:\+?\d[\d\s().-]{7,}\d)/],
  ["api-key", /(?:sk[-_]|api[-_]?key|key[-_:])[a-z\d_-]{8,}/i],
  ["token", /(?:bearer\s+|token\s*[:=]\s*|gh[pousr]_|eyJ)[a-z\d._-]{8,}/i],
  ["account", /(?:account|user(?:name)?|login)\s*[:=]\s*\S+|@[a-z][\w.-]{2,}/i],
  ["home-path", /(?:\/home\/|\/Users\/|C:\\Users\\)[\w.\\/-]+/i],
  ["ip-address", /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[\da-f]{1,4}:(?:[\da-f]{0,4}:){2,}[\da-f]{0,4}\b/i],
];

function command(bin: string, args: string[]): string {
  try { return execFileSync(bin, args, { encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); }
  catch { throw new Error(`redaction cannot run ${bin}; image not sent`); }
}

export function classifyText(text: string): string[] {
  return rules.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind);
}

function words(file: string, psm: string): Word[] {
  const tsv = command("tesseract", [file, "stdout", "--psm", psm, "tsv"]);
  return tsv.split("\n").slice(1).flatMap(row => {
    const c = row.split("\t");
    if (c.length < 12 || !c[11]?.trim() || !Number.isFinite(Number(c[10])) || Number(c[10]) < 0) return [];
    const box = [6, 7, 8, 9].map(i => Number(c[i])) as Box;
    if (!box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) throw new Error("redaction OCR returned an invalid box; image not sent");
    return [{ text: c[11]!.trim(), box, line: c.slice(1, 5).join("/") }];
  });
}

function codes(file: string): Mask[] {
  let output = "";
  try { output = execFileSync("zbarimg", ["-q", "--polygon", file], { encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); }
  catch (e) {
    if ((e as { status?: number }).status === 4) return []; // zbar's documented no-symbol result
    throw new Error("redaction cannot scan barcodes; image not sent");
  }
  return output.trim().split("\n").filter(Boolean).map(line => {
    const first = line.indexOf(":");
    const points = line.slice(first + 1, line.indexOf(":", first + 1)).match(/[+-]?\d+,[+-]?\d+/g);
    if (!points?.length) throw new Error("redaction cannot locate a barcode; image not sent");
    const xy = points.map(p => p.split(",").map(Number));
    const xs = xy.map(p => p[0]!), ys = xy.map(p => p[1]!);
    return { kind: line.startsWith("QR-Code:") ? "qr-code" : "barcode", box: [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs) + 1, Math.max(...ys) - Math.min(...ys) + 1] as Box };
  });
}

function covering(words: Word[]): Mask[] {
  const lines = new Map<string, Word[]>();
  for (const w of words) lines.set(w.line, [...(lines.get(w.line) ?? []), w]);
  const masks: Mask[] = [];
  for (const row of lines.values()) {
    row.sort((a, b) => a.box[0] - b.box[0]);
    const chunks: Word[][] = [];
    for (const w of row) {
      const current = chunks.at(-1);
      if (!current || w.box[0] - Math.max(...current.map(v => v.box[0] + v.box[2])) > 60) chunks.push([w]);
      else current.push(w);
    }
    for (const line of chunks) {
      const kinds = classifyText(line.map(w => w.text).join(" "));
      // All recognized text is hidden, not just regex matches: OCR can split a secret.
      for (const w of line) masks.push({ kind: "text", box: w.box });
      if (kinds.length) {
        const x = Math.min(...line.map(w => w.box[0])), y = Math.min(...line.map(w => w.box[1]));
        const right = Math.max(...line.map(w => w.box[0] + w.box[2]));
        const bottom = Math.max(...line.map(w => w.box[1] + w.box[3]));
        for (const kind of kinds) masks.push({ kind, box: [x, y, right - x, bottom - y] });
      }
    }
  }
  return masks;
}

/** Write a local PNG preview and inspect its remaining readable text/codes. Never sends an image. */
export function redactScreenshot(input: string, output: string): RedactionReport {
  let raw;
  try { raw = decodePng(readFileSync(input)); }
  catch { throw new Error("redaction supports only non-interlaced 8-bit RGB/RGBA PNG screenshots; image not sent"); }
  if (!raw.width || !raw.height || raw.width > 16384 || raw.height > 16384) throw new Error("redaction invalid screenshot dimensions; image not sent");
  const detected = [...words(input, "11"), ...words(input, "6")];
  const masks = [...new Map([...covering(detected), ...codes(input)].map(m => [JSON.stringify(m), m])).values()];
  if (!detected.length) throw new Error("redaction could not recognize any screen text; cannot prove clean, image not sent");
  const { width, height, channels, data } = raw;
  for (const { box } of masks) {
    const [x, y, w, h] = box;
    for (let row = Math.max(0, y - 5); row < Math.min(height, y + h + 5); row++)
      for (let col = Math.max(0, x - 5); col < Math.min(width, x + w + 5); col++) {
        const at = (row * width + col) * channels;
        data[at] = data[at + 1] = data[at + 2] = 0;
        if (channels === 4) data[at + 3] = 255;
      }
  }
  writeFileSync(output, encodePng(raw), { mode: 0o600 });
  if (words(output, "11").length || words(output, "6").length || codes(output).length) {
    throw new Error("redaction verification found readable text or a barcode; image not sent. Review the local preview only.");
  }
  return { image: basename(output), width, height, masks, scanClean: true };
}
