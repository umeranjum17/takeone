// `takeone motion --storyboard template.json --data rows.csv`: one template, one film per spreadsheet row. Every
// `{{column}}` in the template's strings is filled from the row, so names, companies, plans and brand colours are
// inputs instead of hard-coded copy. Every row is checked (layout, reading time, glyph coverage, colours) before any
// render starts, so the long name or the odd colour that breaks a layout stops the batch up front, not at row 412.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderMotion } from "./motion.ts";
import { validateStoryboard } from "./storyboard.ts";
import type { MotionEngine, Storyboard } from "./types.ts";

export const MAX_ROWS = 1000;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const FIELD = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** RFC 4180 CSV: comma separated, `"` quotes a field and `""` is a quote inside one, CRLF or LF rows. Spaces around
 *  a field are trimmed (a quoted field keeps its own). The first row names the columns; blank lines are skipped, so an
 *  empty cell of a one-column file is written `""`. */
export function parseCsv(text: string): { columns: string[]; rows: Record<string, string>[] } {
  const records: string[][] = [];
  let record: string[] = [], field = "", quoted = false, kept = false, i = 0;
  const src = text.replace(/^﻿/, "");
  const endField = () => { record.push(kept ? field : field.trim()); field = ""; kept = false; };
  const endRecord = () => { const blank = !record.length && !kept && !field.trim(); endField(); if (!blank) records.push(record); record = []; };
  while (i < src.length) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; kept = true; i++; continue; }
      field += ch; i++; continue;
    }
    if (kept && ch !== "," && ch !== "\r" && ch !== "\n" && ch !== " " && ch !== "\t") {
      throw new Error("data: unexpected character after a closing quote");
    }
    if (ch === '"' && field.trim()) throw new Error("data: quote inside an unquoted field");
    if (ch === '"' && !kept && !field.trim()) { quoted = true; field = ""; i++; continue; }
    if (ch === ",") { endField(); i++; continue; }
    if (kept && (ch === " " || ch === "\t")) { i++; continue; } // spaces after a closing quote
    if (ch === "\r" && src[i + 1] === "\n") { endRecord(); i += 2; continue; }
    if (ch === "\n" || ch === "\r") { endRecord(); i++; continue; }
    field += ch; i++;
  }
  if (quoted) throw new Error("data: a quoted field is never closed");
  if (field !== "" || kept || record.length) endRecord();
  const [head, ...body] = records;
  if (!head) throw new Error("data: no header row");
  const columns = head.map(c => c.trim());
  columns.forEach((c, j) => {
    if (!c) throw new Error(`data: column ${j + 1} has no name`);
    if (columns.indexOf(c) !== j) throw new Error(`data: column ${c} appears twice`);
  });
  if (!body.length) throw new Error("data: no rows under the header");
  if (body.length > MAX_ROWS) throw new Error(`data: ${body.length} rows; at most ${MAX_ROWS} per batch`);
  const rows = body.map((r, n) => {
    if (r.length !== columns.length) throw new Error(`data row ${n + 1}: ${r.length} fields for ${columns.length} columns`);
    return Object.fromEntries(columns.map((c, j) => [c, r[j]!]));
  });
  return { columns, rows };
}

/** The template with every `{{column}}` in its string values filled from the row. Keys are left alone. */
export function fillTemplate(template: unknown, row: Record<string, string>): unknown {
  const fill = (v: unknown): unknown => {
    if (typeof v === "string") return v.replace(FIELD, (_, name: string) => {
      if (!Object.hasOwn(row, name)) throw new Error(`{{${name}}} names no column`);
      return row[name]!;
    });
    if (Array.isArray(v)) return v.map(fill);
    if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  return fill(template);
}

export interface BatchRow { row: number; id: string; storyboard: Storyboard }

/** One checked storyboard per row, its id the row's `id` column or else its zero-padded row number. Throws naming
 *  every row that fails, so a batch either plans whole or not at all. */
export function planBatch(template: unknown, csv: string): BatchRow[] {
  const { columns, rows } = parseCsv(csv);
  const used: string[] = [];
  const collect = (value: unknown) => {
    if (typeof value === "string") used.push(...[...value.matchAll(FIELD)].map(m => m[1]!));
    else if (Array.isArray(value)) value.forEach(collect);
    else if (typeof value === "object" && value !== null) Object.values(value).forEach(collect);
  };
  collect(template);
  if (!used.length) throw new Error("--data: the storyboard has no {{column}} field to fill");
  const missing = [...new Set(used.filter(name => !columns.includes(name)))];
  if (missing.length) throw new Error(`--data: ${missing.map(n => `{{${n}}}`).join(", ")} names no column; the columns are ${columns.join(", ")}`);
  const width = String(rows.length).length, seen = new Set<string>(), errors: string[] = [];
  const out = rows.flatMap((row, n) => {
    const id = columns.includes("id") ? row["id"]! : String(n + 1).padStart(width, "0");
    try {
      if (!ID.test(id)) throw new Error(`id ${JSON.stringify(id)}: expected [A-Za-z0-9_-]{1,64}`);
      if (seen.has(id.toLowerCase())) throw new Error(`id ${id} repeats an earlier row (ids are compared ignoring case, as take directories are)`);
      seen.add(id.toLowerCase());
      const filled = fillTemplate(template, row) as Record<string, unknown>;
      return [{ row: n + 1, id, storyboard: validateStoryboard({ ...filled, id }) }];
    } catch (e) {
      errors.push(`data row ${n + 1} (${id}): ${(e as Error).message}`);
      return [];
    }
  });
  if (errors.length) throw new Error(`${errors.length} of ${rows.length} rows cannot be rendered; nothing was written:\n${errors.join("\n")}`);
  return out;
}

/** Write each row's take under dir (`<dir>/<id>/`) and `batch.json`, then render them one at a time unless planOnly. */
export async function runBatch(dir: string, rows: BatchRow[], o: { engine: MotionEngine; planOnly: boolean; template: string; data: string },
  log: (line: string) => void = (line) => console.error(line)): Promise<void> {
  const takes = rows.map(r => {
    const take = join(dir, r.id);
    mkdirSync(take, { recursive: true });
    writeFileSync(join(take, "storyboard.json"), JSON.stringify(r.storyboard, null, 2) + "\n");
    writeFileSync(join(take, "take.json"), JSON.stringify({ id: r.id, theme: r.storyboard.theme.name,
      motion: { pattern: r.storyboard.scenes.map(s => s.pattern).join("+"), storyboard: "storyboard.json" } }, null, 2) + "\n");
    return { row: r.row, id: r.id, dir: r.id, out: join(r.id, "out", `${r.id}.mp4`) };
  });
  writeFileSync(join(dir, "batch.json"), JSON.stringify({ version: 1, template: resolve(o.template), data: resolve(o.data), takes }, null, 2) + "\n");
  if (o.planOnly) { for (const t of takes) console.log(join(dir, t.dir, "storyboard.json")); return; }
  for (const [i, t] of takes.entries()) {
    const { out, manifest } = await renderMotion(join(dir, t.dir), { engine: o.engine }).catch((e: Error) => {
      throw new Error(`data row ${t.row} (${t.id}): ${e.message}; rows before it are rendered, rerun to render the rest`);
    });
    log(`motion: ${i + 1}/${takes.length} ${t.id}: ${manifest.frames} frames ${manifest.width}x${manifest.height} in ${manifest.render_s} s`);
    console.log(out);
  }
}
