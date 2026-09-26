/** Minimal Hyprland IPC client: cursor position, active window, monitors. */

import { connect } from "node:net";
import { join } from "node:path";
import type { MonitorInfo } from "./mapping.js";

export interface HyprlandSockets {
  socket: string;
  socket2: string;
}

export function hyprlandSockets(
  env: NodeJS.ProcessEnv = process.env,
): HyprlandSockets | null {
  const sig = env.HYPRLAND_INSTANCE_SIGNATURE;
  const runtime = env.XDG_RUNTIME_DIR;
  if (sig === undefined || sig === "" || runtime === undefined || runtime === "") return null;
  const base = join(runtime, "hypr", sig);
  return { socket: join(base, ".socket.sock"), socket2: join(base, ".socket2.sock") };
}

/** One request/response exchange on the Hyprland control socket. */
export function hyprRequest(socket: string, command: string, timeoutMs = 1000): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = connect(socket);
    let data = "";
    const fail = (error: Error): void => {
      conn.destroy();
      reject(error);
    };
    conn.setTimeout(timeoutMs, () => fail(new Error(`hyprland ipc timeout: ${command}`)));
    conn.on("error", fail);
    conn.on("connect", () => {
      conn.write(command.endsWith("\n") ? command : `${command}\n`);
    });
    conn.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
    });
    conn.on("close", () => resolve(data));
    conn.on("end", () => resolve(data));
  });
}

export async function getCursorPos(socket: string): Promise<{ x: number; y: number } | null> {
  const out = await hyprRequest(socket, "j/cursorpos");
  const parts = out.trim().split(",");
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

export interface ActiveWindow {
  cls: string;
  title: string;
  rect: [number, number, number, number]; // logical x, y, w, h
  address: string;
}

interface RawWindow {
  class?: unknown;
  title?: unknown;
  at?: unknown;
  size?: unknown;
  address?: unknown;
}

export async function getActiveWindow(socket: string): Promise<ActiveWindow | null> {
  const out = await hyprRequest(socket, "j/activewindow");
  const text = out.trim();
  if (text === "" || text === "{}") return null;
  let raw: RawWindow;
  try {
    raw = JSON.parse(text) as RawWindow;
  } catch {
    return null;
  }
  const at = raw.at;
  const size = raw.size;
  if (
    typeof raw.class !== "string" ||
    typeof raw.title !== "string" ||
    typeof raw.address !== "string" ||
    !Array.isArray(at) ||
    !Array.isArray(size) ||
    typeof at[0] !== "number" ||
    typeof at[1] !== "number" ||
    typeof size[0] !== "number" ||
    typeof size[1] !== "number"
  ) {
    return null;
  }
  return {
    cls: raw.class,
    title: raw.title,
    rect: [at[0], at[1], size[0], size[1]],
    address: raw.address,
  };
}

interface RawMonitor {
  name?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
  scale?: unknown;
}

export async function getMonitors(socket: string): Promise<MonitorInfo[]> {
  const out = await hyprRequest(socket, "j/monitors");
  let raw: unknown;
  try {
    raw = JSON.parse(out);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const monitors: MonitorInfo[] = [];
  for (const item of raw) {
    const m = item as RawMonitor;
    if (
      typeof m.name === "string" &&
      typeof m.x === "number" &&
      typeof m.y === "number" &&
      typeof m.width === "number" &&
      typeof m.height === "number" &&
      typeof m.scale === "number"
    ) {
      monitors.push({ name: m.name, x: m.x, y: m.y, width: m.width, height: m.height, scale: m.scale });
    }
  }
  return monitors;
}
