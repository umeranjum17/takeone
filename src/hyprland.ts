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
    const finish = (): void => {
      try {
        JSON.parse(data);
        resolve(data);
      } catch {
        reject(new Error(`invalid hyprland ipc response: ${command}`));
      }
    };
    conn.on("close", finish);
    conn.on("end", finish);
  });
}

export async function getCursorPos(socket: string): Promise<{ x: number; y: number }> {
  const raw = JSON.parse(await hyprRequest(socket, "j/cursorpos")) as { x?: unknown; y?: unknown } | null;
  if (raw !== null && typeof raw === "object" &&
    typeof raw.x === "number" && typeof raw.y === "number" && Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
    return { x: raw.x, y: raw.y };
  }
  throw new Error("invalid hyprland cursor response");
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
  const raw = JSON.parse(out) as RawWindow | null;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length === 0) return null;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid hyprland window response");
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
    throw new Error("invalid hyprland window response");
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
  const raw: unknown = JSON.parse(out);
  if (!Array.isArray(raw)) throw new Error("invalid hyprland monitors response");
  const monitors: MonitorInfo[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid hyprland monitors response");
    const m = item as RawMonitor;
    if (
      typeof m.name !== "string" ||
      typeof m.x !== "number" ||
      typeof m.y !== "number" ||
      typeof m.width !== "number" ||
      typeof m.height !== "number" ||
      typeof m.scale !== "number"
    ) throw new Error("invalid hyprland monitors response");
    monitors.push({ name: m.name, x: m.x, y: m.y, width: m.width, height: m.height, scale: m.scale });
  }
  return monitors;
}
