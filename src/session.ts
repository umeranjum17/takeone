/**
 * The capture path: desklink engine + werift WebRTC receiver.
 *
 * takeone consumes desklink unchanged and writes no capture code of its own:
 * it spawns `desklink-host serve`, opens a view-only portal session, answers
 * the engine's SDP offer with werift, and writes the received VP9 track into
 * screen.webm (werift's MediaRecorder, no re-encode) while logging one
 * `rtp_ts<TAB>recv_mono_ns` line per frame (marker-bit packets) to frames.tsv.
 */

import { createWriteStream } from "node:fs";
import { chmod, stat } from "node:fs/promises";
import { finished } from "node:stream/promises";
import type { WriteStream } from "node:fs";
import { RTCPeerConnection, useVP9 } from "werift";
import { MediaRecorder } from "werift/nonstandard";
import {
  EngineClient,
  EngineRefused,
  type EngineEvent,
  type OpenedSession,
  type ResolvedEngine,
  type SessionMetrics,
} from "@desklink/host";
import { saveToken } from "./token.js";
import type { FrameSample } from "./clock.js";
import type { SurfaceGeometry } from "./mapping.js";

export const DEFAULT_FPS = 30;
export const DEFAULT_BITRATE_KBPS = 40000;
/** A track that never arrives is a negotiation failure (design section 12). */
export const TRACK_WATCHDOG_MS = 10_000;
/** A portal open may wait on a person at the computer. */
export const CONSENT_TIMEOUT_MS = 120_000;

export class RecordError extends Error {
  readonly code: string;
  readonly hint: string;
  constructor(code: string, message: string, hint: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

function openRefused(error: unknown): RecordError {
  if (error instanceof EngineRefused) {
    if (/cancel/i.test(error.message)) {
      return new RecordError(
        "consent-cancelled",
        "the screen-share consent dialog was cancelled",
        "run `takeone record` again and approve the dialog; consent is never retried or bypassed",
      );
    }
    return new RecordError(
      `session-open-refused:${error.code}`,
      error.message,
      "run `takeone doctor` and inspect the desklink engine's answer",
    );
  }
  return new RecordError(
    "session-open-failed",
    error instanceof Error ? error.message : String(error),
    "run `takeone doctor` to check the desklink engine",
  );
}

export interface CaptureOptions {
  engine: ResolvedEngine;
  takeDir: string;
  stateDir: string;
  fps: number;
  bitrateKbps: number;
  savedToken: string | null;
  /** Resolves when a stop is requested while still waiting on consent. */
  interrupted?: Promise<unknown>;
  /** Test hook: shrink the consent deadline. */
  consentTimeoutMs?: number;
}

export interface Capture {
  startedNs: bigint;
  geometry: SurfaceGeometry;
  sessionId: string;
  /** The engine session, for take.json's session record. */
  opened: OpenedSession;
  /** From the handshake capabilities, e.g. "desklink-host/0.1.0". */
  engineVersion: string;
  /** Resolves when the video track exists; rejects on the watchdog. */
  ready: Promise<void>;
  frames(): FrameSample[];
  /** Graceful shutdown; resolves with the engine's final metrics. */
  stop(): Promise<SessionMetrics | null>;
}

export async function startCapture(options: CaptureOptions): Promise<Capture> {
  const { engine, takeDir, stateDir, fps, bitrateKbps, savedToken } = options;
  const startedNs = process.hrtime.bigint();

  const offer = promiseWithCallbacks<{ sdp: string; sessionId: string; generation: number }>();
  const engineCandidates: Extract<EngineEvent, { event: "session.candidate" }>[] = [];
  const tokenWrites: Promise<void>[] = [];
  let peerConnection: RTCPeerConnection | null = null;

  const client = await EngineClient.start(engine.command, engine.args, {
    onEvent: (event) => {
      if (event.event === "session.description") {
        offer.resolve({
          sdp: event.params.description.sdp,
          sessionId: event.params.sessionId,
          generation: event.params.generation,
        });
      } else if (event.event === "session.restoreToken") {
        // Single-use: persist every replacement atomically, in arrival order.
        tokenWrites.push(saveToken(stateDir, event.params.token));
      } else if (event.event === "session.candidate") {
        if (peerConnection === null) engineCandidates.push(event);
        else void addEngineCandidate(peerConnection, event);
      }
    },
  }).catch((error: unknown) => {
    throw new RecordError(
      "engine-start-failed",
      error instanceof Error ? error.message : String(error),
      "run `takeone doctor` to check the desklink engine binary",
    );
  });

  let opened: OpenedSession;
  let engineVersion = "desklink-host";
  try {
    // Our own deadline governs, so a timeout cancels via a clean engine
    // shutdown (stdin EOF -> engine exit -> the portal request's sender leaves
    // the session bus -> the prompt is withdrawn). The client's own, later
    // timeout would SIGKILL instead, which can leave the picker on screen.
    const consentTimeoutMs = options.consentTimeoutMs ?? CONSENT_TIMEOUT_MS;
    const openPromise = client.openSession(
      {
        source: { kind: "portal" },
        permissions: ["view"], // takeone never asks for input authority
        maxFps: fps,
        maxWidth: 7680,
        maxHeight: 4320,
        bitrateKbps,
        iceServers: [], // loopback only
        ...(savedToken === null ? {} : { restoreToken: savedToken }),
      },
      consentTimeoutMs + 30_000,
    );
    let cancelDeadline = (): void => undefined;
    const deadline = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new RecordError(
              "consent-timeout",
              `nobody approved the screen-share dialog within ${consentTimeoutMs / 1000}s; the portal request was cancelled and the picker withdrawn`,
              "if a screen-share picker is still visible it is stale and can be closed; run `takeone record` again when the desktop is free",
            ),
          ),
        consentTimeoutMs,
      );
      cancelDeadline = (): void => clearTimeout(timer);
    });
    const interrupted =
      options.interrupted === undefined
        ? null
        : options.interrupted.then((): never => {
            throw new RecordError(
              "consent-cancelled",
              "takeone stop arrived while waiting for screen-share consent",
              "run `takeone record` again to try once more",
            );
          });
    try {
      opened = await Promise.race(
        interrupted === null
          ? [openPromise, deadline]
          : [openPromise, deadline, interrupted],
      );
    } catch (error) {
      cancelDeadline();
      // Cancel the portal request: shut the engine down cleanly so its DBus
      // session-bus connection closes and the compositor withdraws the prompt.
      await client.stop().catch(() => undefined);
      throw error;
    }
    cancelDeadline();
  } catch (error) {
    await client.stop().catch(() => undefined);
    if (error instanceof RecordError) throw error; // already structured
    throw openRefused(error);
  }
  try {
    // Safe after the handshake and before any capture ask: no portal here.
    engineVersion = (await client.capabilities()).engine;
  } catch {
    // the engine string stays generic; capture itself is unaffected
  }

  const interrupted = options.interrupted?.then((): never => {
    throw new RecordError("capture-stopped", "recording stopped during negotiation", "run `takeone record` again");
  });
  const whileActive = <T>(promise: Promise<T>): Promise<T> =>
    interrupted === undefined ? promise : Promise.race([promise, interrupted]);
  let description: Awaited<typeof offer.promise>;
  let offerTimer: NodeJS.Timeout | undefined;
  try {
    description = await whileActive(Promise.race([
      offer.promise,
      new Promise<never>((_, reject) => { offerTimer = setTimeout(() => reject(new RecordError(
        "no-offer", "no session description arrived within 10s", "run `takeone doctor` and check desklink negotiation",
      )), TRACK_WATCHDOG_MS); }),
    ]));
  } catch (error) {
    await client.closeSession(opened.sessionId).catch(() => undefined);
    await client.stop().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(offerTimer);
  }

  const framesStream: WriteStream = createWriteStream(`${takeDir}/frames.tsv`, { flags: "w", mode: 0o600 });
  const framesDone = finished(framesStream);
  void framesDone.catch(() => undefined);
  const frames: FrameSample[] = [];

  // desklink offers exactly one codec: VP9 (capabilities.encode.codecs).
  // werift's default peer would answer VP8 and negotiate nothing.
  const pc = new RTCPeerConnection({
    iceServers: [],
    codecs: { video: [useVP9()] },
  });
  peerConnection = pc;

  // werift's Event has no replay, so every subscription is in place before
  // setRemoteDescription: onTrack fires there, and host candidates are
  // gathered inside setLocalDescription.
  pc.onIceCandidate.subscribe((candidate) => {
    if (candidate?.candidate === undefined) return;
    void client
      .addCandidate(
        description.sessionId,
        description.generation,
        candidate.candidate,
        candidate.sdpMid ?? "0", // one video m-line
        candidate.sdpMLineIndex ?? 0,
      )
      .catch(() => undefined);
  });

  const trackReady = promiseWithCallbacks<true>();
  const firstPacket = (): void => trackReady.resolve(true);
  let recorder: MediaRecorder | null = null;
  let recorderError: Error | null = null;
  pc.onTrack.subscribe((track) => {
    recorder = new MediaRecorder({
      tracks: [track], path: `${takeDir}/screen.webm`,
      width: opened.geometry.encoded.width, height: opened.geometry.encoded.height,
      disableNtp: true, disableLipSync: true,
    });
    recorder.onError.subscribe((error) => { recorderError = error; });
    track.onReceiveRtp.subscribe((packet) => {
      firstPacket();
      if (!packet.header.marker) return; // one marker-bit packet per frame
      const recvNs = process.hrtime.bigint();
      frames.push({ rtpTs: packet.header.timestamp, recvMs: Number(recvNs / 1000n) / 1000 });
      framesStream.write(`${packet.header.timestamp}\t${recvNs}\n`);
    });
  });

  void trackReady.promise.catch(() => undefined);
  const watchdog = setTimeout(() => {
    trackReady.reject(
      new RecordError(
        "no-track",
        `no video track arrived within ${TRACK_WATCHDOG_MS / 1000}s of answering the engine's offer`,
        "werift may not interoperate with this desklink build; run `takeone doctor`, then report it",
      ),
    );
  }, TRACK_WATCHDOG_MS);

  try {
  await whileActive(pc.setRemoteDescription({ type: "offer", sdp: description.sdp }));
  await whileActive(pc.setLocalDescription(await whileActive(pc.createAnswer())));
  const answerSdp = pc.localDescription?.sdp;
  if (answerSdp === undefined) {
    throw new RecordError(
      "answer-failed",
      "werift produced no SDP answer for the engine's offer",
      "this is a werift/desklink interoperability failure; report it",
    );
  }
  await whileActive(client.acceptAnswer(description.sessionId, description.generation, answerSdp));

  // Candidates the engine sent while the answer was being prepared.
  for (const buffered of engineCandidates.splice(0)) void addEngineCandidate(pc, buffered);

  await whileActive(trackReady.promise);
  } catch (error) {
    clearTimeout(watchdog);
    if (recorder !== null) await recorder.stop().catch(() => undefined);
    await chmod(`${takeDir}/screen.webm`, 0o600).catch(() => undefined);
    await pc.close().catch(() => undefined);
    await client.closeSession(opened.sessionId).catch(() => undefined);
    await client.stop().catch(() => undefined);
    await Promise.allSettled(tokenWrites);
    framesStream.end();
    await framesDone.catch(() => undefined);
    throw error;
  }
  clearTimeout(watchdog);

  let stopped = false;
  return {
    startedNs,
    geometry: opened.geometry,
    sessionId: opened.sessionId,
    opened,
    engineVersion,
    ready: Promise.resolve(),
    frames: () => frames,
    async stop(): Promise<SessionMetrics | null> {
      if (stopped) return null;
      stopped = true;
      let finalMetrics: SessionMetrics | null = null;
      try {
        finalMetrics = await client.metrics();
      } catch {
        // metrics are best-effort; the take is still written
      }
      let videoError: unknown = null;
      try {
        if (recorder !== null) {
          await recorder.stop();
          if ((recorder.writer as { ended?: boolean }).ended !== true) throw new Error("screen.webm was not finalized");
        }
      } catch (error) { videoError = error; }
      try {
        const videoPath = `${takeDir}/screen.webm`;
        const video = await stat(videoPath);
        if (!video.isFile()) throw new Error("screen.webm is not a file");
        await chmod(videoPath, 0o600);
        if (video.size === 0) throw new Error("screen.webm is empty");
      } catch (error) {
        videoError ??= error;
      }
      await pc.close().catch(() => undefined);
      await client.closeSession(opened.sessionId).catch(() => undefined);
      await client.stop().catch(() => undefined);
      await Promise.allSettled(tokenWrites);
      framesStream.end();
      let frameError: unknown = null;
      try { await framesDone; } catch (error) { frameError = error; }
      if (recorderError !== null || videoError !== null) throw new RecordError("recorder-failed", String(recorderError ?? videoError), "check disk space and record again");
      if (frameError !== null) throw new RecordError("frames-write-failed", String(frameError), "check disk space and record again");
      return finalMetrics;
    },
  };
}

function addEngineCandidate(
  pc: RTCPeerConnection,
  event: Extract<EngineEvent, { event: "session.candidate" }>,
): Promise<void> {
  const init = {
    candidate: event.params.candidate,
    // werift rejects candidates without an m-line index; the stream is the
    // session's single video m-line.
    sdpMid: event.params.sdpMid ?? "0",
    sdpMLineIndex: event.params.sdpMLineIndex ?? 0,
  };
  return pc.addIceCandidate(init).catch(() => undefined);
}

interface PromiseWithCallbacks<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function promiseWithCallbacks<T>(): PromiseWithCallbacks<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
