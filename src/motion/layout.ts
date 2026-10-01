import type { Layout, Scene } from "./types.ts";

export function timeline(raw: unknown, path: string, parse: (raw: unknown, path: string) => Scene): Scene[] {
  if (!Array.isArray(raw) || !raw.length) throw new Error(`${path}: expected scenes`);
  let end = 0;
  return raw.map((r, i) => {
    const s = parse(r, `${path}[${i}]`);
    s.at ??= end;
    if (i > 0 && s.at < end) throw new Error(`${path}[${i}].at: overlapping scenes`);
    end = s.at + s.d;
    if (end > 120) throw new Error(`${path}: timeline exceeds 120 s`);
    return s;
  });
}
export function validateLayout(raw: unknown, parse: (raw: unknown, path: string) => Scene): Layout {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") throw new Error("layout: expected object");
  if (r["kind"] === "single") return { kind: "single" };
  if (r["kind"] !== "bento") throw new Error("layout.kind: choose single or bento");
  if (r["grid"] === "2x2") {
    const master = r["master"] as { d?: number; scenes?: unknown } | undefined;
    if (!master || !Number.isFinite(master.d) || master.d! <= 0 || master.d! > 120) throw new Error("layout.master.d: expected 0 < duration <= 120");
    const scenes = timeline(master.scenes, "layout.master.scenes", parse);
    const tiles = r["tiles"] as { id: "TL" | "TR" | "BL" | "BR"; offset_s: number }[];
    if (!Array.isArray(tiles) || tiles.length !== 4 || new Set(tiles.map(t => t.id)).size !== 4 || tiles.some(t => !["TL", "TR", "BL", "BR"].includes(t.id) || !Number.isFinite(t.offset_s) || Math.abs(t.offset_s) > 120)) throw new Error("layout.tiles: expected TL, TR, BL, BR with finite offsets");
    return { kind: "bento", grid: "2x2", master: { d: master.d!, scenes }, tiles };
  }
  if (r["grid"] === "pinwheel-3x2") {
    const tiles = r["tiles"] as Record<string, unknown> | undefined;
    if (!tiles) throw new Error("layout.tiles: expected A, B, C, D timelines");
    return { kind: "bento", grid: "pinwheel-3x2", tiles: Object.fromEntries(["A", "B", "C", "D"].map(id => [id, timeline(tiles[id], `layout.tiles.${id}`, parse)])) as Record<"A" | "B" | "C" | "D", Scene[]> };
  }
  throw new Error("layout.grid: choose 2x2 or pinwheel-3x2");
}
export function layoutDuration(layout: Layout, scenes: Scene[]): number {
  if (layout.kind === "bento" && layout.grid === "2x2") return layout.master.d;
  if (layout.kind === "bento") scenes = Object.values(layout.tiles).flat();
  return Math.max(0, ...scenes.map(s => (s.at ?? 0) + s.d));
}
export function allTimelines(layout: Layout, scenes: Scene[]): Scene[][] {
  return layout.kind === "single" ? [scenes] : layout.grid === "2x2" ? [layout.master.scenes] : Object.values(layout.tiles);
}
