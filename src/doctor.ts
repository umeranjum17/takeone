/** `takeone doctor`: what the recorder needs on this machine, and what's missing. */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { explainMissingEngine, resolveEngine, EngineClient } from "@desklink/host";
import { listInputCandidates, type InputCandidate } from "./evdev.js";
import { hyprlandSockets, getMonitors } from "./hyprland.js";
import { keyStatus, type KeyOptions } from "./secrets.ts";
import { toonTable } from "./toon.js";

export interface DoctorCheck {
  check: string;
  ok: boolean;
  detail: string;
}

export function formatDoctor(checks: DoctorCheck[]): string {
  return toonTable(
    "doctor",
    ["check", "ok", "detail"],
    checks.map((c) => [c.check, c.ok, c.detail]),
  );
}

async function ffmpegVersion(): Promise<string | null> {
  return new Promise((resolveP) => {
    execFile("ffmpeg", ["-version"], { timeout: 5000 }, (error, stdout) => {
      if (error !== null) return resolveP(null);
      resolveP(String(stdout).split("\n")[0] ?? null);
    });
  });
}

export async function evdevProbe(dir?: string): Promise<DoctorCheck> {
  let candidates: InputCandidate[];
  try {
    candidates = await listInputCandidates(dir);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EACCES"
      ? { check: "evdev", ok: false, detail: "cannot read the input device list; add the user to group 'input' and log in again" }
      : { check: "evdev", ok: false, detail: `${dir ?? "/proc/bus/input/devices"} missing` };
  }
  let readable = 0;
  let eacces = false;
  for (const { path } of candidates) {
    try {
      const handle = await fs.open(path, "r");
      await handle.close();
      readable++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EACCES") eacces = true;
    }
  }
  if (readable === candidates.length && candidates.some((c) => c.mouse) && candidates.some((c) => c.kbd)) {
    return { check: "evdev", ok: true, detail: `${readable} readable device(s)` };
  }
  return eacces
    ? { check: "evdev", ok: false, detail: "not all devices readable; add the user to group 'input' and log in again" }
    : { check: "evdev", ok: false, detail: candidates.length === 0 ? "no mouse or keyboard devices" : readable === candidates.length ? "both a mouse and a keyboard device required" : "some evdev devices are unreadable" };
}

export async function runDoctor(keys: KeyOptions = {}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // Engine binary
  const engine = resolveEngine();
  if (engine === null) {
    checks.push({ check: "engine", ok: false, detail: explainMissingEngine() ?? "not found" });
  } else {
    checks.push({ check: "engine", ok: true, detail: `${engine.command} (${engine.origin})` });
    // Protocol handshake + capabilities; safe, opens no portal.
    try {
      const client = await EngineClient.start(engine.command, engine.args);
      try {
        const caps = await client.capabilities();
        checks.push({
          check: "engine-protocol",
          ok: caps.protocol === 2,
          detail: `protocol ${caps.protocol}, ${caps.session.kind}, ${caps.capture.mechanism}, encode ${caps.encode.codecs.join("/")} ${caps.encode.hardware ? "hw" : "sw"}`,
        });
      } finally {
        await client.stop();
      }
    } catch (error) {
      checks.push({
        check: "engine-protocol",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Hyprland IPC
  const hypr = hyprlandSockets();
  if (hypr === null) {
    checks.push({
      check: "hyprland",
      ok: false,
      detail: "HYPRLAND_INSTANCE_SIGNATURE or XDG_RUNTIME_DIR missing; pointer events disabled",
    });
  } else {
    try {
      const monitors = await getMonitors(hypr.socket);
      const names = monitors.map((m) => `${m.name} ${m.width}x${m.height}@${m.scale}`).join(", ");
      checks.push({ check: "hyprland", ok: monitors.length > 0, detail: `${monitors.length} monitor(s): ${names}` });
    } catch (error) {
      checks.push({
        check: "hyprland",
        ok: false,
        detail: `ipc unreachable: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  // evdev
  checks.push(await evdevProbe());

  // ffmpeg
  const ffmpeg = await ffmpegVersion();
  checks.push({ check: "ffmpeg", ok: ffmpeg !== null, detail: ffmpeg ?? "not found" });

  // Writable state dir
  const state = process.env.TAKEONE_STATE_DIR ?? join(homedir(), ".local", "state", "takeone");
  try {
    await fs.mkdir(state, { recursive: true, mode: 0o700 });
    const probe = join(state, `.doctor-probe-${randomUUID()}`);
    const handle = await fs.open(probe, "wx", 0o600);
    try {
      await handle.close();
    } finally {
      await fs.rm(probe, { force: true });
    }
    checks.push({ check: "state-dir", ok: true, detail: state });
  } catch (error) {
    checks.push({
      check: "state-dir",
      ok: false,
      detail: `${state}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // Takes root
  const root = process.env.TAKEONE_DIR ?? join(homedir(), "Videos", "takeone");
  try {
    await fs.mkdir(root, { recursive: true });
    checks.push({ check: "takes-root", ok: true, detail: root });
  } catch (error) {
    checks.push({
      check: "takes-root",
      ok: false,
      detail: `${root}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const jev = await keyStatus(keys);
  checks.push({ check: "jev-key", ok: jev.available, detail: jev.detail });

  return checks;
}
