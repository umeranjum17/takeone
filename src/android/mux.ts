// A timestamped H.264 transport for ffmpeg. Raw Annex-B loses PTS when ffmpeg
// probes/buffers the pipe; Matroska carries source timing, including idle holds.
const element = (id: string, data: Buffer): Buffer => {
  let bytes = 1;
  while (data.length >= 2 ** (7 * bytes) - 1) bytes++;
  const size = Buffer.alloc(bytes);
  let value = BigInt(data.length) | (1n << BigInt(7 * bytes));
  for (let i = bytes - 1; i >= 0; i--) { size[i] = Number(value & 255n); value >>= 8n; }
  return Buffer.concat([Buffer.from(id, "hex"), size, data]);
};
const uint = (id: string, value: number): Buffer => {
  let bytes = 1;
  while (value >= 2 ** (8 * bytes)) bytes++;
  const data = Buffer.alloc(bytes);
  data.writeUIntBE(value, 0, bytes);
  return element(id, data);
};
const string = (id: string, value: string): Buffer => element(id, Buffer.from(value));
const group = (id: string, children: Buffer[]): Buffer => element(id, Buffer.concat(children));

/** Split both three-byte and four-byte Annex-B start codes into bare NAL units. */
export function nalUnits(payload: Buffer): Buffer[] {
  const starts: { at: number; size: number }[] = [];
  for (let i = 0; i + 2 < payload.length; i++) {
    if (payload[i] !== 0 || payload[i + 1] !== 0) continue;
    const size = payload[i + 2] === 1 ? 3 : payload[i + 2] === 0 && payload[i + 3] === 1 ? 4 : 0;
    if (size) { starts.push({ at: i, size }); i += size - 1; }
  }
  if (!starts.length) return [payload];
  return starts.map((start, i) => payload.subarray(start.at + start.size, starts[i + 1]?.at ?? payload.length)).filter(nal => nal.length > 0);
}

/** Minimal single-track AVC Matroska stream; no external muxing dependency. */
export class AndroidVideoMux {
  private sps?: Buffer;
  private pps?: Buffer;
  private started = false;
  private firstPts?: bigint;
  private pending?: { t: number; keyframe: boolean; payload: Buffer };

  configure(payload: Buffer): void {
    for (const nal of nalUnits(payload)) {
      if ((nal[0]! & 31) === 7) this.sps = nal;
      if ((nal[0]! & 31) === 8) this.pps = nal;
    }
  }

  private header(width: number, height: number): Buffer {
    if (!this.sps || !this.pps || this.sps.length < 4) throw new Error("Android video has no AVC configuration");
    const spsSize = Buffer.alloc(2); spsSize.writeUInt16BE(this.sps.length);
    const ppsSize = Buffer.alloc(2); ppsSize.writeUInt16BE(this.pps.length);
    const avcc = Buffer.concat([Buffer.from([1, this.sps[1]!, this.sps[2]!, this.sps[3]!, 255, 225]), spsSize, this.sps,
      Buffer.from([1]), ppsSize, this.pps]);
    return Buffer.concat([
      group("1a45dfa3", [uint("4286", 1), uint("42f7", 1), uint("42f2", 4), uint("42f3", 8), string("4282", "matroska"), uint("4287", 4), uint("4285", 2)]),
      // Unknown segment size: the recorder streams until the stop signal.
      Buffer.from("1853806701ffffffffffffff", "hex"),
      group("1549a966", [uint("2ad7b1", 1_000_000), string("4d80", "TakeOne"), string("5741", "TakeOne")]),
      group("1654ae6b", [group("ae", [uint("d7", 1), uint("73c5", 1), uint("83", 1),
        string("86", "V_MPEG4/ISO/AVC"), element("63a2", avcc),
        group("e0", [uint("b0", width), uint("ba", height)])])]),
    ]);
  }

  /** One cluster per packet avoids signed 16-bit relative timestamp limits. */
  private flush(endMs: number): Buffer {
    const frame = this.pending!;
    const block = Buffer.concat([Buffer.from([0x81, 0, 0, 0]), frame.payload]);
    return group("1f43b675", [uint("e7", frame.t), group("a0", [
      element("a1", block), uint("9b", Math.max(1, Math.round(endMs - frame.t))),
      ...(frame.keyframe ? [] : [element("fb", Buffer.from([255]))]),
    ])]);
  }

  frame(pts: bigint, keyframe: boolean, payload: Buffer, width: number, height: number): Buffer {
    const chunks: Buffer[] = [];
    if (!this.started) { chunks.push(this.header(width, height)); this.started = true; this.firstPts = pts; }
    const t = Math.max(this.pending?.t ?? 0, Math.round(Number(pts - this.firstPts!) / 1000));
    if (this.pending) chunks.push(this.flush(t));
    const avc = nalUnits(payload).map(nal => {
      const length = Buffer.alloc(4); length.writeUInt32BE(nal.length);
      return Buffer.concat([length, nal]);
    });
    this.pending = { t, keyframe, payload: Buffer.concat(avc) };
    return Buffer.concat(chunks);
  }

  /** Give the final still frame its real hold through the end of capture. */
  finish(elapsedMs: number): Buffer {
    if (!this.pending) return Buffer.alloc(0);
    const out = this.flush(elapsedMs);
    this.pending = undefined;
    return out;
  }
}
