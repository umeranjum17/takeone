/**
 * Passive input event taps writing events.jsonl, stamped in ms since take
 * start. Everything here is read-only: Hyprland IPC queries and evdev reads
 * without EVIOCGRAB. Key presses are recorded as a class only; characters are
 * never recorded.
 */

import { promises as fs, constants as fsConstants, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { extractRecords, EV_SYN, EV_KEY, EV_REL, REL_WHEEL, REL_HWHEEL, REL_WHEEL_HI_RES, REL_HWHEEL_HI_RES, HI_RES_PER_DETENT, BUTTON_NAMES } from "./evdev.js";
import { classifyKeyEvent } from "./keyclass.js";
import { mapLogicalToStream, mapRectToStream, type MonitorInfo } from "./mapping.js";
import { getActiveWindow, getCursorPos, hyprlandSockets, type HyprlandSockets } from "./hyprland.js";

export interface TapEvent {
  t: number;
  k: "ptr" | "btn" | "wheel" | "key" | "win";
  [field: string]: unknown;
}

export interface TapOptions {
  eventsPath: string;
  /** Stream-pixel mapping; null runs in no-pointer mode. */
  mapping: { monitor: MonitorInfo; scale: number } | null;
  /** Monotonic take-start time from process.hrtime.bigint(). */
  t0ns: bigint;
  pollHz?: number;
  evdevPollHz?: number;
  deviceDir?: string;
}

export interface TapSummary {
  firstInputMs: number | null;
  lastEventMs: number | null;
}

export interface TapHandle {
  summary: TapSummary;
  pointerMode: "mapped" | "none";
  eventsMode: "on" | "none";
  warnings: string[];
  stop(): Promise<void>;
}

const DEVICE_DIR = "/dev/input/by-id";

interface EvdevDevice {
  path: string;
  fd: number;
  character: boolean;
}

/**
 * Open evdev devices non-blocking. Blocking reads (streams or threadpool
 * reads) on an idle character device park a libuv threadpool thread forever,
 * which starves every other fs operation in the process, so takeone polls
 * non-blocking fds instead.
 */
async function evdevDevices(dir: string): Promise<{ devices: EvdevDevice[]; missingGroup: boolean }> {
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return { devices: [], missingGroup: false };
  }
  const candidates = names
    .filter((n) => n.endsWith("-event-mouse") || n.endsWith("-event-kbd"))
    .sort()
    .map((n) => `${dir}/${n}`);
  const devices: EvdevDevice[] = [];
  let eacces = false;
  let unreadable = false;
  for (const path of candidates) {
    let fd: number | null = null;
    try {
      fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      devices.push({ path, fd, character: fstatSync(fd).isCharacterDevice() });
    } catch (error) {
      if (fd !== null) closeSync(fd);
      unreadable = true;
      if ((error as NodeJS.ErrnoException).code === "EACCES") eacces = true;
    }
  }
  if (unreadable) {
    for (const device of devices) closeSync(device.fd);
  }
  return { devices: unreadable ? [] : devices, missingGroup: eacces };
}

export async function startTaps(options: TapOptions): Promise<TapHandle> {
  const { eventsPath, mapping, t0ns } = options;
  const warnings: string[] = [];
  const summary: TapSummary = { firstInputMs: null, lastEventMs: null };
  const nowMs = (): number => {
    const delta = process.hrtime.bigint() - t0ns;
    return Math.round(Number(delta) / 100) / 10; // 0.1 ms resolution
  };

  let eventsMode: "on" | "none" = "on";
  let pointerMode: "mapped" | "none" = mapping !== null ? "mapped" : "none";

  const out = await fs.open(eventsPath, "a", 0o600);
  let writes = Promise.resolve();
  let writeError: unknown = null;
  let readError: Error | null = null;
  const emit = (event: TapEvent): void => {
    if (stopped) return;
    writes = writes.then(() => out.write(`${JSON.stringify(event)}\n`)).then(() => undefined).catch((error: unknown) => {
      writeError ??= error;
    });
  };
  const emitInput = (event: TapEvent): void => {
    if (summary.firstInputMs === null) summary.firstInputMs = event.t;
    summary.lastEventMs = event.t;
    emit(event);
  };

  const timers: NodeJS.Timeout[] = [];
  const evdevHandles: EvdevDevice[] = [];
  const polls = new Set<Promise<void>>();
  let stopped = false;
  const { devices, missingGroup } = await evdevDevices(options.deviceDir ?? DEVICE_DIR);
  // --- Hyprland pointer and window polling -------------------------------
  const hypr: HyprlandSockets | null = hyprlandSockets();
  if (hypr === null) {
    pointerMode = "none";
    warnings.push("hyprland ipc not found; pointer and window events disabled");
  } else if (mapping === null) {
    pointerMode = "none";
    warnings.push("no monitor matches the stream size; pointer events disabled");
  } else if (devices.length === 0) {
    pointerMode = "none";
  } else {
    const { monitor, scale } = mapping;
    let lastPos = "";
    let lastWin = "";
    const hz = options.pollHz ?? 60;
    const timer = setInterval(() => {
      const poll = (async () => {
        try {
          const pos = await getCursorPos(hypr.socket);
          if (pos !== null) {
            const key = `${pos.x},${pos.y}`;
            if (key !== lastPos) {
              lastPos = key;
              const stream = mapLogicalToStream(pos.x, pos.y, monitor, scale);
              emit({ t: nowMs(), k: "ptr", x: stream.x, y: stream.y });
            }
          }
          const win = await getActiveWindow(hypr.socket);
          const winKey = win === null ? "none" : `${win.address}|${win.title}|${win.rect.join(",")}`;
          if (winKey !== lastWin) {
            lastWin = winKey;
            emit({
              t: nowMs(),
              k: "win",
              cls: win?.cls ?? "",
              title: win?.title ?? "",
              rect: win === null ? null : mapRectToStream(win.rect, monitor, scale),
            });
          }
        } catch {
          // a single failed poll is not an error; the tap keeps running
        }
      })();
      polls.add(poll);
      void poll.finally(() => polls.delete(poll));
    }, Math.round(1000 / hz));
    timers.push(timer);
  }

  // --- evdev --------------------------------------------------------------
  evdevHandles.push(...devices);
  if (devices.length === 0) {
    eventsMode = "none";
    if (missingGroup) {
      warnings.push(
        "no evdev device readable (missing group 'input'); recording video only with events:'none'",
      );
    } else {
      warnings.push("no evdev mouse/keyboard devices found; recording video only with events:'none'");
    }
  } else {
    // Per-device state: carry-over partial record, wheel dedup, held mods.
    const states = devices.map((device) => ({
      device,
      carry: Buffer.alloc(0),
      hiresX: false,
      hiresY: false,
      coarseX: 0,
      coarseY: 0,
      wheelAccX: 0,
      wheelAccY: 0,
      mods: new Set<string>(),
    }));
    const chunk = Buffer.alloc(4096);

    const drain = (state: (typeof states)[number]): void => {
      if (readError !== null) return;
      const { device } = state;
      let bytesRead = 0;
      do {
        try {
          bytesRead = readSync(device.fd, chunk, 0, chunk.byteLength, null);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "EAGAIN" || code === "EINTR") return; // no data (or retry next tick)
          readError = new Error(`evdev read failed: ${device.path}: ${String(error)}`);
          return;
        }
        if (bytesRead === 0 && device.character) readError = new Error(`evdev device closed: ${device.path}`);
        if (bytesRead > 0) handleChunk(chunk.subarray(0, bytesRead), state);
      } while (bytesRead > 0);
    };

    const handleChunk = (data: Buffer, state: (typeof states)[number]): void => {
      const { records, rest } = extractRecords(data, state.carry);
      state.carry = Buffer.from(rest);
      for (const record of records) {
        if (stopped) return;
        if (record.type === EV_SYN && record.code === 0) {
          if (!state.hiresY && state.coarseY) emitInput({ t: nowMs(), k: "wheel", dy: state.coarseY, dx: 0 });
          if (!state.hiresX && state.coarseX) emitInput({ t: nowMs(), k: "wheel", dy: 0, dx: state.coarseX });
          state.coarseX = state.coarseY = 0;
        } else if (record.type === EV_REL) {
          const detent = (delta: number): number => Math.trunc(delta / HI_RES_PER_DETENT);
          if (record.code === REL_WHEEL) {
            state.coarseY += record.value;
          } else if (record.code === REL_HWHEEL) {
            state.coarseX += record.value;
          } else if (record.code === REL_WHEEL_HI_RES) {
            state.hiresY = true;
            state.wheelAccY += record.value;
            if (Math.abs(state.wheelAccY) >= HI_RES_PER_DETENT) {
              const dy = detent(state.wheelAccY);
              state.wheelAccY -= dy * HI_RES_PER_DETENT;
              emitInput({ t: nowMs(), k: "wheel", dy, dx: 0 });
            }
          } else if (record.code === REL_HWHEEL_HI_RES) {
            state.hiresX = true;
            state.wheelAccX += record.value;
            if (Math.abs(state.wheelAccX) >= HI_RES_PER_DETENT) {
              const dx = detent(state.wheelAccX);
              state.wheelAccX -= dx * HI_RES_PER_DETENT;
              emitInput({ t: nowMs(), k: "wheel", dy: 0, dx });
            }
          }
        } else if (record.type === EV_KEY && (record.value === 1 || record.value === 0)) {
          const down = record.value === 1;
          const t = nowMs();
          if (record.code >= 0x100) {
            const name = BUTTON_NAMES[record.code] ?? `btn${record.code}`;
            emitInput({ t, k: "btn", b: name, down });
          } else {
            const { record: keyRecord, modifier } = classifyKeyEvent(record.code, down, state.mods);
            if (modifier !== null) {
              if (down) state.mods.add(modifier);
              else state.mods.delete(modifier);
            }
            const event: TapEvent = { t, ...keyRecord };
            emitInput(event);
          }
        }
      }
    };

    // Poll all devices ~125 Hz: a non-blocking read costs a syscall when idle,
    // and input events are stamped within 8 ms — far under one frame.
    const evdevTimer = setInterval(() => {
      for (const state of states) drain(state);
    }, Math.round(1000 / (options.evdevPollHz ?? 125)));
    timers.push(evdevTimer);
  }

  return {
    summary,
    pointerMode,
    eventsMode,
    warnings,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      for (const timer of timers) clearInterval(timer);
      for (const device of evdevHandles.splice(0)) closeSync(device.fd);
      await Promise.all(polls);
      await writes;
      await out.close();
      if (writeError !== null) throw writeError;
      if (readError !== null) throw readError;
    },
  };
}
