/**
 * A fake `desklink-host serve` for tests: speaks protocol v2 over stdio and
 * plays a real werift VP9 sender on loopback. Proves takeone's session code
 * end to end without the portal or the real engine.
 */

import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import { MediaStreamTrack, RTCPeerConnection, RtpHeader, RtpPacket, useVP9 } from "werift";

const SESSION = "s1";
const FRAME_COUNT = 20;

let pending = Promise.resolve();
const send = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};
const reply = (id: number, result: unknown): void => {
  send({ id, result });
};

const pc = new RTCPeerConnection({
  iceServers: [],
  codecs: { video: [useVP9()] },
});
pc.onIceCandidate.subscribe((candidate) => {
  if (candidate?.candidate === undefined) return;
  send({
    event: "session.candidate",
    params: {
      sessionId: SESSION,
      generation: 1,
      candidate: candidate.candidate,
      sdpMid: null,
      sdpMLineIndex: null,
    },
  });
});

let framesSent = 0;
function pushFrames(track: MediaStreamTrack): void {
  const ivf = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=30", "-frames:v", "1", "-c:v", "libvpx-vp9", "-f", "ivf", "pipe:1"]);
  const frame = ivf.subarray(44, 44 + ivf.readUInt32LE(32));
  let i = 0;
  const timer = setInterval(() => {
    if (i >= FRAME_COUNT) {
      clearInterval(timer);
      return;
    }
    const packet = new RtpPacket(
      new RtpHeader({
        sequenceNumber: i,
        timestamp: i * 3000, // 90 kHz, ~33 ms per frame
        payloadType: track.codec?.payloadType ?? 96,
        marker: true, // one marker-bit packet per frame
        ssrc: 0x1234abcd,
      }),
      Buffer.concat([Buffer.from([0x0c]), frame]),
    );
    track.writeRtp(packet);
    framesSent++;
    i++;
  }, 20);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  pending = pending.then(() => handle(line)).catch((error) => {
    console.error(`fake-engine: ${String(error)}`);
    process.exit(1);
  });
});

async function handle(line: string): Promise<void> {
  if (line.trim() === "") return;
  const msg = JSON.parse(line) as { id?: number; method: string; params?: any };
  switch (msg.method) {
    case "hello":
      reply(msg.id ?? 0, { protocol: 2, engine: "desklink-host/fake", platform: "linux" });
      break;
    case "capabilities":
      reply(msg.id ?? 0, {
        protocol: 2,
        engine: "desklink-host/fake",
        platform: "linux",
        session: { kind: "wayland" },
        capture: { mechanism: "fake", backends: ["fake"], formats: [], cursor: "embedded", audio: false },
        encode: { codecs: ["vp9"], hardware: false },
        input: { mechanism: "fake", pointer: false, wheel: false, keyboard: false, text: [], layout: "us", unavailable_reason: null, grant: "granted" },
        clipboard: { read: false, write: false, mime: [], maxBytes: 0 },
      });
      break;
    case "session.open": {
      if (msg.params.max_width !== 7680 || msg.params.max_height !== 4320) {
        throw new Error("source resolution bounds missing from session.open");
      }
      // Test hook: hang on consent so callers can prove their timeout cancels.
      if (process.env.FAKE_HANG_OPEN !== undefined) return;
      reply(msg.id ?? 0, {
        sessionId: SESSION,
        generation: 1,
        source: { kind: "monitor", width: 64, height: 64, origin: { x: 0, y: 0 } },
        geometry: {
          source: { width: 64, height: 64 },
          encoded: { width: 64, height: 64 },
          origin: { x: 0, y: 0 },
        },
      });
      send({ event: "session.restoreToken", params: { sessionId: SESSION, token: "fake-restore-token" } });
      const track = new MediaStreamTrack({ kind: "video" });
      pc.addTrack(track);
      await pc.setLocalDescription(await pc.createOffer());
      send({
        event: "session.description",
        params: {
          sessionId: SESSION,
          generation: 1,
          description: { type: "offer", sdp: pc.localDescription?.sdp ?? "" },
        },
      });
      pc.connectionStateChange.subscribe((state) => {
        if (state === "connected") setTimeout(() => pushFrames(track), Number(process.env.FAKE_DELAY_FRAMES_MS ?? 0));
      });
      break;
    }
    case "session.description":
      await pc.setRemoteDescription({ type: "answer", sdp: msg.params.description.sdp });
      reply(msg.id ?? 0, { accepted: true });
      break;
    case "session.candidate":
      // werift buffers pre-answer candidates and needs an m-line on flush.
      await pc
        .addIceCandidate({
          candidate: msg.params.candidate,
          sdpMid: msg.params.sdp_mid ?? "0",
          sdpMLineIndex: msg.params.sdp_m_line_index ?? 0,
        })
        .catch(() => undefined);
      reply(msg.id ?? 0, { accepted: true });
      break;
    case "session.metrics":
      reply(msg.id ?? 0, {
        captured_frames: framesSent,
        dropped_frames: 0,
        encoded_frames: framesSent,
        encoded_bytes: framesSent * 16,
        input_applied: 0,
        input_rejected: 0,
      });
      break;
    case "session.close":
      reply(msg.id ?? 0, { closed: true });
      break;
    case "shutdown":
      process.exit(0);
      break;
    default:
      send({
        id: msg.id ?? 0,
        error: { code: "malformed", message: `fake engine does not implement ${msg.method}` },
      });
  }
}
