// Ingest: turn the storyboard's source into screens (PNGs under sources/) and resolve selector regions.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { INGEST_CLOCK } from "./ingest-clock.ts";
import { launch, navigate } from "./cdp.ts";
import { pinnedShell } from "./shell.ts";
import type { StateOp, Storyboard } from "./types.ts";

export function validateStateNames(names: Iterable<string>): void {
  const seen = new Set<string>();
  for (const name of names) {
    const index = Number(name);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || (String(index) === name && Number.isInteger(index) && index >= 0 && index < 4294967295)) throw new Error(`state: invalid screen id ${name}; use a non-index name`);
    if (seen.has(name)) throw new Error(`state: duplicate screen id ${name}`);
    seen.add(name);
  }
}

export function imageSize(file: string): { width: number; height: number } {
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", file], { encoding: "utf8" })) as { streams: { width: number; height: number }[] };
  const s = probe.streams[0];
  if (!s) throw new Error(`${file}: not an image`);
  return { width: s.width, height: s.height };
}

/** Fill sb.screens from the source. Images are copied as-is; screen ids are S1..Sn in file order. */
export async function ingest(dir: string, sb: Storyboard): Promise<void> {
  const states = Object.entries(sb.source.states ?? {});
  validateStateNames(states.map(([id]) => id));
  const out = join(dir, "sources");
  mkdirSync(out, { recursive: true });
  if (sb.source.kind === "image") {
    (sb.source.files ?? []).forEach((f, i) => {
      const src = isAbsolute(f) ? f : resolve(dir, f);
      const name = `S${i + 1}${extname(src).toLowerCase() || ".png"}`;
      if (resolve(src) !== resolve(out, name)) copyFileSync(src, join(out, name));
      sb.screens[`S${i + 1}`] = { file: `sources/${name}`, ...imageSize(join(out, name)) };
    });
    return;
  }
  const [width, height] = sb.source.viewport ?? [2560, 1440];
  const dsf = sb.source.dsf ?? 1;
  const b = await launch((await pinnedShell()).path, { width, height, dsf, network: sb.source.kind === "url" });
  try {
    await b.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dsf, mobile: false });
    await b.send("Page.addScriptToEvaluateOnNewDocument", { source: INGEST_CLOCK });
    const url = sb.source.kind === "url" ? sb.source.url! : pathToFileURL(resolve(dir, sb.source.file!)).href;
    await navigate(b, url);
    await b.evaluate(`(async () => { await document.fonts.ready; await Promise.all([...document.images].map(i => i.decode()));
      const style = document.createElement('style'); style.textContent = '* { animation:none!important; transition:none!important; caret-color:transparent!important }'; document.head.append(style); })()`);
    const wait = async (ms: number) => {
      if (!Number.isFinite(ms) || ms < 0 || ms > 30000) throw new Error("state wait: expected 0..30000 ms");
      if (!ms) return;
      await b.evaluate(`__advanceIngest(${ms})`);
    };
    const point = async (selector: string) => b.evaluate<{ x: number; y: number }>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('missing selector'); const r = el.getBoundingClientRect(); return { x:r.x+r.width/2,y:r.y+Math.min(r.height/2,70) }; })()`);
    const mouse = (type: string, p: {x: number; y: number}, pressed = false) => b.send("Input.dispatchMouseEvent", { type, ...p, button: type === "mouseMoved" ? "none" : "left", buttons: pressed ? 1 : 0, clickCount: 1 });
    let held: {x: number; y: number} | undefined;
    for (const [id, ops] of states.length ? states : [["S1", []] as [string, (StateOp | string)[]]]) {
      for (const raw of ops) {
        const op = parseStateOp(raw);
        if (op[0] === "wait") await wait(op[1]);
        else if (op[0] === "drop") { if (!held) throw new Error("drop without drag"); await mouse("mouseReleased", held); held = undefined; }
        else if (op[0] === "click") { const p = await point(op[1]); await mouse("mouseMoved", p); await mouse("mousePressed", p, true); await mouse("mouseReleased", p); }
        else if (op[0] === "type") {
          await b.evaluate(`(() => { const el=document.querySelector(${JSON.stringify(op[1])}); if (!el || !('value' in el)) throw new Error('type target is not a field'); el.focus(); el.value=''; })()`);
          await b.send("Input.insertText", { text: op[2] });
        } else {
          const a = await point(op[1]), z = await point(op[2]), fraction = op[3]?.capture_at ?? 1;
          if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) throw new Error("drag capture_at: expected 0 < value <= 1");
          await mouse("mouseMoved", a); await mouse("mousePressed", a, true);
          for (let j=1; j<=20; j++) { const f = fraction*j/20; held = {x:a.x+(z.x-a.x)*f,y:a.y+(z.y-a.y)*f}; await mouse("mouseMoved", held, true); }
          if (fraction === 1) { await mouse("mouseReleased", held!); held = undefined; }
        }
      }
      // Advance timers deterministically (focus, removal, toast) rather than sleeping against wall time.
      await wait(100);
      await b.evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
      const shot = await b.send<{data: string}>("Page.captureScreenshot", { format:"png", optimizeForSpeed:true });
      writeFileSync(join(out, `${id}.png`), Buffer.from(shot.data, "base64"));
      sb.screens[id] = { file:`sources/${id}.png`, width:width*dsf, height:height*dsf };
      for (const region of sb.regions.filter(r => r.selector && r.screen === id)) {
        region.rect = await b.evaluate(`[...(() => { const el=document.querySelector(${JSON.stringify(region.selector)}); if (!el) throw new Error('missing region selector'); const r=el.getBoundingClientRect(); return [r.x,r.y,r.width,r.height].map(v=>v*${dsf}); })()]`);
        region.from = "dom";
      }
    }
  } finally { await b.close(); }
}

export function parseStateOp(raw: StateOp | string): StateOp {
  if (Array.isArray(raw)) {
    const [kind, a, b] = raw;
    if (kind === "drop" && raw.length === 1) return raw;
    if (kind === "wait" && typeof a === "number") return raw;
    if (kind === "click" && typeof a === "string") return raw;
    if ((kind === "type" || kind === "drag") && typeof a === "string" && typeof b === "string") return raw;
    throw new Error("state: invalid operation");
  }
  if (raw === "drop") return ["drop"];
  let m = /^wait (\d+)$/.exec(raw); if (m) return ["wait", Number(m[1])];
  m = /^click (.+)$/.exec(raw); if (m) return ["click", m[1]!];
  m = /^type (\S+) (".*")$/.exec(raw); if (m) return ["type", m[1]!, JSON.parse(m[2]!) as string];
  m = /^drag (\S+)(?: → | -> | +)(\S+)$/.exec(raw); if (m) return ["drag", m[1]!, m[2]!];
  throw new Error(`state: invalid operation ${raw}`);
}
