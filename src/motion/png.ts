// Minimal PNG codec (8-bit RGB/RGBA, non-interlaced: what Chromium screenshots emit) for sub-frame averaging.
import { averageRaw, type PixelFrame } from "../render/frame-average.ts";
export { averageRaw } from "../render/frame-average.ts";
import { crc32, deflateSync, inflateSync } from "node:zlib";

export type Raw = PixelFrame;

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function decodePng(png: Uint8Array): Raw {
  const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error("not a PNG");
  let width = 0, height = 0, channels: 3 | 4 = 3;
  const idat: Buffer[] = [];
  for (let at = 8; at < buf.length;) {
    const len = buf.readUInt32BE(at), type = buf.toString("latin1", at + 4, at + 8), body = buf.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      const depth = body[8], colour = body[9], interlace = body[12];
      if (depth !== 8 || (colour !== 2 && colour !== 6) || interlace !== 0) throw new Error(`unsupported PNG (depth ${depth}, colour ${colour}, interlace ${interlace})`);
      channels = colour === 6 ? 4 : 3;
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    at += 12 + len;
  }
  const inflated = inflateSync(Buffer.concat(idat));
  const stride = width * channels, data = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = inflated[y * (stride + 1)]!, src = y * (stride + 1) + 1, row = y * stride, prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? data[row + x - channels]! : 0, b = y ? data[prev + x]! : 0, c = y && x >= channels ? data[prev + x - channels]! : 0;
      const v = inflated[src + x]!;
      let p: number;
      if (filter === 0) p = v;
      else if (filter === 1) p = v + a;
      else if (filter === 2) p = v + b;
      else if (filter === 3) p = v + ((a + b) >> 1);
      else if (filter === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      else throw new Error(`bad PNG filter ${filter}`);
      data[row + x] = p & 255;
    }
  }
  return { width, height, channels, data };
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

export function encodePng(raw: Raw): Buffer {
  const { width, height, channels, data } = raw, stride = width * channels;
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    rows[y * (stride + 1)] = 1; // Sub filter: cheap and compresses screen content well
    const row = y * stride, out = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) rows[out + x] = (data[row + x]! - (x >= channels ? data[row + x - channels]! : 0)) & 255;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
}

export function averagePngs(pngs: Uint8Array[]): Buffer {
  return encodePng(averageRaw(pngs.map(decodePng)));
}
