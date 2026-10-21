/** `takeone doctor`: what the recorder needs on this machine, and what's missing. */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { explainMissingEngine, resolveEngine, EngineClient } from "@desklink/host";
import { listInputCandidates, type InputCandidate } from "./evdev.js";
import { hyprlandSockets, getMonitors } from "./hyprland.js";
import { parseBootedDevices } from "./ios/record.js";
import { plannerStatus } from "./decide/planner.js";
import { toonTable } from "./toon.js";

export interface DoctorCheck {
  check: string;
  ok: boolean;
  detail: string;
}

/**
 * Which capture route needs each check. "all" marks a check every route needs:
 * only those gate the exit code. The other values name the one route (or optional
 * feature) that uses the row, so a false row on another route does not fail the install.
 */
const NEEDED_BY: Record<string, string> = {
  ffmpeg: "all",
  "state-dir": "all",
  "takes-root": "all",
  engine: "linux-desktop",
  "engine-protocol": "linux-desktop",
  hyprland: "linux-desktop",
  evdev: "linux-desktop",
  "screen-recording": "linux-desktop",
  xcrun: "ios-simulator",
  "motion-shell": "motion",
  "ai-planner": "planner",
};

export function neededBy(check: string): string {
  return NEEDED_BY[check] ?? "all";
}

/** Exit 1 only when a check every capture route needs fails. */
export function doctorExitCode(checks: DoctorCheck[]): number {
  return checks.some((c) => !c.ok && neededBy(c.check) === "all") ? 1 : 0;
}

export function formatDoctor(checks: DoctorCheck[]): string {
  return toonTable(
    "doctor",
    ["check", "ok", "needed_by", "detail"],
    checks.map((c) => [c.check, c.ok, neededBy(c.check), c.detail]),
  );
}

async function execFirstLine(cmd: string, args: string[], timeout: number): Promise<string | null> {
  return new Promise((resolveP) => {
    execFile(cmd, args, { timeout, maxBuffer: 1_048_576 }, (error, stdout) => {
      if (error !== null) return resolveP(null);
      resolveP(String(stdout).split("\n")[0]?.trim() || null);
    });
  });
}

async function ffmpegVersion(): Promise<string | null> {
  return execFirstLine("ffmpeg", ["-version"], 5000);
}

/** macOS only: xcrun presence gates iOS Simulator recording; a booted Simulator is transient state, so it is reported, not gated. */
export async function xcrunProbe(): Promise<DoctorCheck> {
  const version = await execFirstLine("xcrun", ["--version"], 5000);
  if (version === null) {
    return { check: "xcrun", ok: false, detail: "not found; install Xcode command line tools for iOS Simulator recording" };
  }
  const list = await new Promise<string | null>((resolveP) => {
    execFile("xcrun", ["simctl", "list", "devices", "-j"], { timeout: 10000, maxBuffer: 8_388_608 }, (error, stdout) => {
      if (error !== null) return resolveP(null);
      resolveP(String(stdout));
    });
  });
  const booted = list === null ? null : parseBootedDevices(list);
  return {
    check: "xcrun",
    ok: true,
    detail: booted === null
      ? `${version}; simctl device list unavailable`
      : booted.length > 0
        ? `${version}; ${booted.length} booted simulator(s)`
        : `${version}; no booted simulator (boot one with \`xcrun simctl boot <device>\` or open the Simulator app)`,
  };
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

export async function runDoctor(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // Engine binary
  const engine = resolveEngine();
  if (engine === null) {
    checks.push({ check: "engine", ok: false, detail: explainMissingEngine() ?? "not found" });
  } else {
    checks.push({ check: "engine", ok: true, detail: `${engine.command} (${engine.origin})` });
    // Protocol handshake + capabilities; safe, opens no portal.
    // The handshake in EngineClient.start already refused an incompatible
    // engine, so a successful capabilities() round-trip means this machine's
    // pinned engine works: report the protocol it speaks rather than gating
    // on a stale literal. (@desklink/host exposes PROTOCOL_VERSION for the
    // client's hello, not the engine's caps value, so it cannot serve as the
    // expected number here.)
    try {
      const client = await EngineClient.start(engine.command, engine.args);
      try {
        const caps = await client.capabilities();
        checks.push({
          check: "engine-protocol",
          ok: true,
          detail: `protocol ${caps.protocol}, ${caps.session.kind}, ${caps.capture.mechanism}, encode ${caps.encode.codecs.join("/")} ${caps.encode.hardware ? "hw" : "sw"}`,
        });
        // macOS engines preflight Screen Recording without prompting (Linux
        // caps carry no grant field, so the row only appears where it exists).
        if (caps.capture.grant !== undefined) {
          const main = caps.capture.displays?.find((d) => d.main) ?? caps.capture.displays?.[0];
          checks.push({
            check: "screen-recording",
            ok: caps.capture.grant === "granted",
            detail:
              caps.capture.grant === "granted"
                ? main !== undefined
                  ? `granted; main display ${main.width}x${main.height}@${main.scale}x`
                  : "granted; no active display"
                : caps.capture.unavailable_reason?.remedy ?? "grant Screen Recording in System Settings",
          });
        }
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

  // AI planner: presence only, never the credential itself. Absent means
  // planned films fall back to local rules; the row is informational and does
  // not change the exit code.
  const planner = await plannerStatus();
  checks.push({ check: "ai-planner", ok: planner.available, detail: planner.detail });

  // Hyprland IPC (Linux only)
  if (process.platform === "linux") {
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

    // evdev (Linux only)
    checks.push(await evdevProbe());
  }

  // xcrun / iOS Simulator (macOS only)
  if (process.platform === "darwin") {
    checks.push(await xcrunProbe());
  }

  // ffmpeg
  const ffmpeg = await ffmpegVersion();
  checks.push({ check: "ffmpeg", ok: ffmpeg !== null, detail: ffmpeg ?? "not found" });

  // Pinned headless shell for motion renders (version and sha256)
  try {
    const { pinnedShell } = await import("./motion/shell.ts");
    const shell = await pinnedShell();
    checks.push({ check: "motion-shell", ok: true, detail: `chrome-headless-shell ${shell.version} sha256 ${shell.sha256} ${shell.path}` });
  } catch (error) {
    checks.push({ check: "motion-shell", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }

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

  return checks;
}
