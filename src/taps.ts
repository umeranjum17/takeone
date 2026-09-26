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
  mapping?: { monitor: MonitorInfo; scale: number } | null;
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
  setMapping(mapping: { monitor: MonitorInfo; scale: number } | null): void;
  confirmConsent(): Promise<void>;
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
  } catch (error) {
    return { devices: [], missingGroup: (error as NodeJS.ErrnoException).code === "EACCES" };
  }
  const candidates = names
    .filter((n) => n.endsWith("-event-mouse") || n.endsWith("-event-kbd"))
    .sort()
    .map((n) => `${dir}/${n}`);
  const complete = candidates.some((path) => path.endsWith("-event-mouse")) && candidates.some((path) => path.endsWith("-event-kbd"));
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
  if (unreadable || !complete) {
    for (const device of devices) closeSync(device.fd);
  }
  return { devices: unreadable || !complete ? [] : devices, missingGroup: eacces };
}

export async function startTaps(options: TapOptions): Promise<TapHandle> {
  const { eventsPath, t0ns } = options;
  const warnings: string[] = [];
  const summary: TapSummary = { firstInputMs: null, lastEventMs: null };
  const nowMs = (): number => {
    const delta = process.hrtime.bigint() - t0ns;
    return Math.round(Number(delta) / 100) / 10; // 0.1 ms resolution
  };

  let eventsMode: "on" | "none" = "on";
  let pointerMode: "mapped" | "none" = "none";

  let out: Awaited<ReturnType<typeof fs.open>> | null = null;
  const pending: string[] = [];
  let writes = Promise.resolve();
  let writeError: unknown = null;
  let readError: Error | null = null;
  const write = (line: string): void => {
    writes = writes.then(() => out!.write(line)).then(() => undefined).catch((error: unknown) => {
      writeError ??= error;
    });
  };
  const emit = (event: TapEvent): void => {
    if (stopped) return;
    const line = `${JSON.stringify(event)}\n`;
    if (out === null) pending.push(line);
    else write(line);
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
  const hypr: HyprlandSockets | null = hyprlandSockets();
  let pointerTimer: NodeJS.Timeout | null = null;
  const setMapping = (mapping: { monitor: MonitorInfo; scale: number } | null): void => {
    if (stopped) return;
    if (pointerTimer !== null) clearInterval(pointerTimer);
    pointerTimer = null;
    pointerMode = "none";
    if (hypr === null) {
      warnings.push("hyprland ipc not found; pointer and window events disabled");
      return;
    }
    if (mapping === null) {
      warnings.push("no monitor matches the stream size; pointer events disabled");
      return;
    }
    if (devices.length === 0) return;
    pointerMode = "mapped";
    const { monitor, scale } = mapping;
    let lastPos = "";
    let lastWin = "";
    const hz = options.pollHz ?? 60;
    const timer = setInterval(() => {
      if (polls.size !== 0) return;
      const poll = (async () => {
        try {
          const pos = await getCursorPos(hypr.socket);
          if (pointerMode !== "mapped" || pointerTimer !== timer) return;
          const key = `${pos.x},${pos.y}`;
          if (key !== lastPos) {
            lastPos = key;
            const stream = mapLogicalToStream(pos.x, pos.y, monitor, scale);
            emit({ t: nowMs(), k: "ptr", x: stream.x, y: stream.y });
          }
          const win = await getActiveWindow(hypr.socket);
          if (pointerMode !== "mapped" || pointerTimer !== timer) return;
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
          if (pointerMode === "mapped" && pointerTimer === timer) {
            pointerMode = "none";
            warnings.push("hyprland ipc unavailable; pointer and window events disabled");
            if (pointerTimer !== null) clearInterval(pointerTimer);
            pointerTimer = null;
          }
        }
      })();
      polls.add(poll);
      void poll.finally(() => polls.delete(poll));
    }, Math.round(1000 / hz));
    pointerTimer = timer;
  };
  if (options.mapping !== undefined) setMapping(options.mapping);

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
    const heldMods = new Map<string, string>();
    const held = { has: (name: string): boolean => [...heldMods.values()].includes(name) };
    // Per-device state: carry-over partial record, wheel dedup.
    const states = devices.map((device) => ({
      device,
      carry: Buffer.alloc(0),
      hiresX: false,
      hiresY: false,
      coarseX: 0,
      coarseY: 0,
      wheelAccX: 0,
      wheelAccY: 0,
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
            const { record: keyRecord, modifier } = classifyKeyEvent(record.code, down, held);
            if (modifier !== null) {
              const key = `${state.device.path}:${record.code}`;
              if (down) heldMods.set(key, modifier);
              else heldMods.delete(key);
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
    get pointerMode() { return pointerMode; },
    eventsMode,
    warnings,
    setMapping,
    async confirmConsent(): Promise<void> {
      if (out !== null || stopped) return;
      const opened = await fs.open(eventsPath, "a", 0o600);
      if (stopped) { await opened.close(); return; }
      out = opened;
      for (const line of pending.splice(0)) write(line);
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      for (const timer of timers) clearInterval(timer);
      if (pointerTimer !== null) clearInterval(pointerTimer);
      for (const device of evdevHandles.splice(0)) closeSync(device.fd);
      await Promise.all(polls);
      await writes;
      pending.length = 0;
      if (out !== null) await out.close();
      if (writeError !== null) throw writeError;
      if (readError !== null) throw readError;
    },
  };
}
