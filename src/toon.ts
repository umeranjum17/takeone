/** Hand-rolled TOON table writer (the only TOON takeone needs). */

function cell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "null";
  const s = String(value);
  return /[,\n"\\]/.test(s) ? JSON.stringify(s) : s;
}

/** `name[N]{f1,f2}:` then two-space-indented rows. */
export function toonTable(
  name: string,
  fields: string[],
  rows: Array<Array<string | number | boolean | null | undefined>>,
): string {
  const head = `${name}[${rows.length}]{${fields.join(",")}}:`;
  if (rows.length === 0) return head;
  const body = rows.map((row) => `  ${row.map(cell).join(",")}`).join("\n");
  return `${head}\n${body}`;
}

/** A structured error line for stderr, as JSON with a next-step hint. */
export function structuredError(
  code: string,
  message: string,
  hint: string,
): string {
  return JSON.stringify({ error: { code, message, hint } });
}
