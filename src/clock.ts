/**
 * Clock alignment between the video track's RTP capture clock (90 kHz) and
 * the event clock (process.hrtime.bigint() milliseconds).
 *
 * offset_ms = min over frames(recv_mono_ms - rtp_ts / 90): the minimum-latency
 * frame, which bounds the encode-and-loopback delay from below. A frame's
 * capture time on the event clock is then rtp_ts / 90 + offset_ms.
 */

export interface FrameSample {
  /** RTP timestamp from the packet header (90 kHz). */
  rtpTs: number;
  /** Local monotonic receive time in ms. */
  recvMs: number;
}

export interface ClockAlign {
  offsetMs: number;
  /** Median residual after alignment. */
  medianMs: number;
  spreadMs: number;
  frames: number;
}

export const SPREAD_WARN_MS = 50;

export function alignClock(samples: FrameSample[]): ClockAlign | null {
  if (samples.length === 0) return null;
  let min = Infinity;
  for (const s of samples) {
    const v = s.recvMs - s.rtpTs / 90;
    if (v < min) min = v;
  }
  const residuals = samples.map((s) => s.recvMs - (s.rtpTs / 90 + min)).sort((a, b) => a - b);
  const n = residuals.length;
  const median = residuals[Math.floor((n - 1) / 2)] ?? 0;
  return {
    offsetMs: min,
    medianMs: median,
    spreadMs: (residuals[n - 1] ?? 0) - (residuals[0] ?? 0),
    frames: n,
  };
}
