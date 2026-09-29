/** Hyprland monitor and desklink geometry types shared by mapping code. */

export interface MonitorInfo {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

export interface SurfaceGeometry {
  source: { width: number; height: number };
  encoded: { width: number; height: number };
  origin: { x: number; y: number };
}

/**
 * Stream pixels per logical layout pixel for the captured monitor.
 * The design's rule: scale = source.width / (monitor.width / monitor.scale).
 */
export function mappingScale(sourceWidth: number, m: MonitorInfo): number {
  if (m.scale <= 0) return 0;
  return sourceWidth / (m.width / m.scale);
}

export function mapLogicalToStream(
  x: number,
  y: number,
  m: MonitorInfo,
  scale: number,
): { x: number; y: number } {
  return {
    x: Math.round((x - m.x) * scale),
    y: Math.round((y - m.y) * scale),
  };
}

export function mapRectToStream(
  rect: [number, number, number, number],
  m: MonitorInfo,
  scale: number,
): [number, number, number, number] {
  const a = mapLogicalToStream(rect[0], rect[1], m, scale);
  return [a.x, a.y, Math.round(rect[2] * scale), Math.round(rect[3] * scale)];
}

/**
 * Find the captured monitor: the one whose logical size x scale matches the
 * stream size within 2 px on both axes. When several match, prefer the one at
 * the geometry origin. Returns null when no monitor fits (no-pointer mode).
 */
export function pickMonitor(
  monitors: MonitorInfo[],
  geo: SurfaceGeometry,
): { monitor: MonitorInfo; scale: number } | null {
  let best: { monitor: MonitorInfo; scale: number; d: number } | null = null;
  for (const m of monitors) {
    const scale = mappingScale(geo.source.width, m);
    if (!Number.isFinite(scale) || scale <= 0) continue;
    if (Math.abs(m.width - geo.source.width) > 2) continue;
    if (Math.abs(m.height - geo.source.height) > 2) continue;
    const dx = m.x - geo.origin.x;
    const dy = m.y - geo.origin.y;
    const d = dx * dx + dy * dy;
    if (best === null || d < best.d) best = { monitor: m, scale, d };
  }
  return best === null ? null : { monitor: best.monitor, scale: best.scale };
}
