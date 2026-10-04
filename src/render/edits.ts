// Validation of take.json edit fields at the JSON trust boundary.
import type { ManualZoom } from "../camera/types.ts";

interface Span { t0: number; t1: number }

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
function fail(field: string): never { throw new Error(`take.json: invalid ${field}`); }
function range(value: unknown, field: string): asserts value is Span {
  const v = value as Span | null;
  if (!v || !finite(v.t0) || !finite(v.t1) || v.t0 < 0 || v.t1 <= v.t0) fail(field);
}
function list(value: unknown, field: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(field);
  return value;
}
function ordered<T extends Span>(spans: T[], field: string): T[] {
  const sorted = [...spans].sort((a, b) => a.t0 - b.t0);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.t0 < sorted[i - 1]!.t1) fail(`${field}: overlapping intervals`);
  }
  return sorted;
}

export function validateZooms(zooms: unknown, width: number, height: number): void {
  const spans = list(zooms, "zooms").map((v, i) => {
    range(v, `zooms[${i}]`);
    const z = v as ManualZoom;
    const b = z.bbox;
    if (z.t1 - z.t0 < 0.5) fail(`zooms[${i}]: interval must allow a 0.5s hold`);
    if (!Array.isArray(b) || b.length !== 4 || !b.every(finite) || b[0] < 0 || b[1] < 0
      || b[2] <= 0 || b[3] <= 0 || b[0] + b[2] > width || b[1] + b[3] > height) fail(`zooms[${i}].bbox`);
    if (z.level !== undefined && (!Number.isInteger(z.level) || z.level < 0 || z.level > 3)) fail(`zooms[${i}].level`);
    return z;
  });
  ordered(spans, "zooms");
}
