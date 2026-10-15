#!/usr/bin/env node
// Offline demo take producer. No portal, display server, input device or account.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchBrowser } from './headless/browser.mjs';
import { VERSION, BINARY_SHA256 } from './headless/shell.mjs';
import { choreography, inputEvents, frameClock, fit, FPS, LAYOUTS } from './headless/drive.mjs';

// Every visible text line, editable field and the open dialog, in stream px. render projects
// them through the final camera and fails when any crosses the output's 5% safe area.
const TEXT_BOXES = `(() => {
  const out = [], k = devicePixelRatio, seen = el => el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  const clip = (el, r) => { for (let a = el.parentElement; a; a = a.parentElement) if (getComputedStyle(a).overflowY !== 'visible' && a !== document.body && a !== document.documentElement) {
    const c = a.getBoundingClientRect(); r = { l: Math.max(r.l, c.left), t: Math.max(r.t, c.top), r: Math.min(r.r, c.right), b: Math.min(r.b, c.bottom) }; } return r; };
  const add = (el, rect, label) => { const r = clip(el, { l: rect.left, t: rect.top, r: rect.right, b: rect.bottom });
    if (r.r > r.l && r.b > r.t) out.push([r.l * k, r.t * k, (r.r - r.l) * k, (r.b - r.t) * k, label].map(v => typeof v === 'number' ? Math.round(v * 10) / 10 : v)); };
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walk.nextNode());) { const text = n.textContent.trim(); if (!text || !seen(n.parentElement)) continue;
    const range = document.createRange(); range.selectNodeContents(n); for (const rect of range.getClientRects()) add(n.parentElement, rect, text.slice(0, 40)); }
  for (const el of document.querySelectorAll('input, textarea, #modal')) if (seen(el)) add(el, el.getBoundingClientRect(), el.id);
  return JSON.stringify(out);
})()`;

export async function captureScene(output, { cursorHidden = false, aspect = 'landscape', title = true } = {}) {
  // Each aspect captures its own layout at its own viewport, so a same-aspect render needs no crop.
  const layout = LAYOUTS[aspect];
  if (!layout) throw new Error(`unknown aspect ${aspect}; use ${Object.keys(LAYOUTS).join(', ')}`);
  const [cssW, cssH] = layout.css, { s, ox, oy } = fit(layout);
  const { steps, frames } = choreography(layout);
  const boxes = [];
  // Refuse to overwrite existing data. Metadata is published only after encoding.
  const dir = resolve(output);
  await mkdir(dirname(dir), { recursive: true });
  await mkdir(dir, { recursive: false });
  let browser, encoder, encoding, succeeded = false, cancelled = false;
  const cancel = () => { cancelled = true; };
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    browser = await launchBrowser();
    await browser.send('Page.enable');
    await browser.send('Emulation.setDeviceMetricsOverride', { width: cssW, height: cssH, deviceScaleFactor: 2, mobile: false });
    await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: await readFile(new URL('./headless/clock.js', import.meta.url), 'utf8') });
    const url = new URL('./e2e/scene.html', import.meta.url); url.searchParams.set('headless', '1');
    if (aspect !== 'landscape') url.searchParams.set('layout', aspect);
    await browser.send('Page.navigate', { url: url.href });
    // Poll document readiness without advancing the virtual clock.
    for (let i = 0; ; i++) {
      if (await browser.evaluate("document.readyState === 'complete' && typeof window.__takeoneTick === 'function'")) break;
      if (i >= 100) throw new Error('Scene failed to load');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    // --cursor=hidden paints no cursor: the pointer track is still logged, and
    // the take is marked cursor_free so the render draws its own vector cursor.
    if (!cursorHidden) await browser.evaluate(`document.fonts.ready.then(() => {
      const cursor = document.createElement('div'); cursor.id = 'takeoneCursor';
      cursor.style.cssText = 'position:fixed;left:1500px;top:900px;z-index:100;pointer-events:none;width:24px;height:32px';
      cursor.innerHTML = '<svg width="24" height="32" viewBox="0 0 24 32"><path d="M1 1 L1 23 L7 18 L11 27 L15 25 L11 17 L19 17 Z" fill="white" stroke="#202328" stroke-width="1.5" stroke-linejoin="round"/></svg>';
      document.body.append(cursor);
    })`);
    encoder = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-vcodec', 'png', '-i', '-',
      '-an', '-c:v', 'libvpx-vp9', '-lossless', '1', '-deadline', 'realtime', '-cpu-used', '8', '-threads', '2',
      '-pix_fmt', 'yuv420p', '-r', String(FPS), join(dir, 'screen.webm')], { stdio: ['pipe', 'ignore', 'pipe'] });
    let errors = '';
    encoder.stderr.on('data', data => { errors = (errors + data).slice(-4000); });
    encoding = new Promise((resolve, reject) => {
      encoder.once('error', reject);
      encoder.once('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${errors}`)));
    });
    encoding.catch(() => {}); // A failed encoder is rethrown below, after cleanup.
    encoder.stdin.on('error', () => {});
    await new Promise((resolve, reject) => { encoder.once('spawn', resolve); encoder.once('error', reject); });
    for (let frame = 0; frame < frames; frame++) {
      if (cancelled) throw new Error('Headless capture interrupted');
      const t = frame * 1000 / FPS;
      await browser.evaluate(`window.__takeoneTick(${t})`);
      for (const action of steps.get(frame) ?? []) {
        const x = ox + action.x * s, y = oy + action.y * s;
        if (action.k === 'move' || action.k === 'button') {
          await browser.send('Input.dispatchMouseEvent', { type: action.k === 'move' ? 'mouseMoved' : action.down ? 'mousePressed' : 'mouseReleased',
            x, y, ...(action.k === 'button' ? { button: 'left', clickCount: 1 } : {}) });
          if (action.k === 'move' && !cursorHidden) await browser.evaluate(`Object.assign(document.getElementById('takeoneCursor').style, {left:'${action.x}px',top:'${action.y}px'})`);
        } else if (action.k === 'key') {
          await browser.send('Input.dispatchKeyEvent', { type: action.down ? 'keyDown' : 'keyUp', key: action.ch,
            ...(action.down ? { text: action.ch } : {}) });
        } else if (action.k === 'wheel') {
          // Synchronous fixture scrolling avoids the browser's asynchronous wheel queue.
          await browser.evaluate(`document.getElementById('feed').scrollTop += ${action.dy}`);
        }
      }
      await browser.evaluate('window.__takeonePaint()');
      // Text boxes on the video clock, kept only when they change.
      const current = await browser.evaluate(TEXT_BOXES);
      if (boxes.at(-1)?.json !== current) boxes.push({ t: frame / FPS, json: current });
      const { data } = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
      await new Promise((resolve, reject) => encoder.stdin.write(Buffer.from(data, 'base64'), error => error ? reject(error) : resolve()));
      if (frame % 300 === 0) console.log(`headless scene: ${frame}/${frames} frames`);
    }
    encoder.stdin.end(); await encoding;
    if (cancelled) throw new Error('Headless capture interrupted');
    const events = inputEvents(steps, frames, layout);
    await writeFile(join(dir, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
    await writeFile(join(dir, 'frames.tsv'), frameClock(frames));
    await writeFile(join(dir, 'text-boxes.json'), JSON.stringify({ space: 'stream px', clock: 'video s',
      samples: boxes.map(({ t, json }) => ({ t, boxes: JSON.parse(json) })) }) + '\n');
    await writeFile(join(dir, 'take.json'), JSON.stringify({
      id: 'headless-demo', stream: { w: cssW * 2, h: cssH * 2 }, scale: 2, offset_ms: 0, fps: FPS,
      started_at: '2026-01-01T00:00:00.000Z', stopped_at: new Date(Date.UTC(2026,0,1) + frames * 1000 / FPS).toISOString(),
      pointer: 'mapped', events: 'on', monitor: null, warnings: [],
      cursor_free: cursorHidden,
      clock: { offsetMs: 0, medianMs: 0, spreadMs: 0, frames },
      source: { kind: 'headless-demo', css: { w: cssW, h: cssH }, browser: VERSION, sha256: BINARY_SHA256 },
      ...(title ? { title: 'From idea to launch' } : {}),
    }, null, 2) + '\n');
    succeeded = true;
    return { dir, frames };
  } finally {
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
    if (encoder && encoder.exitCode === null && encoder.signalCode === null) {
      encoder.stdin.destroy(); encoder.kill('SIGKILL'); await encoding.catch(() => {});
    }
    await browser?.close();
    if (!succeeded) await rm(dir, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [output, ...extra] = process.argv.slice(2);
  const cursorHidden = extra.includes('--cursor=hidden');
  const title = !extra.includes('--no-title');
  const aspect = extra.find(flag => flag.startsWith('--aspect='))?.slice(9) ?? 'landscape';
  if (!output || !LAYOUTS[aspect] || extra.some(flag => !['--cursor=hidden', '--no-title'].includes(flag) && !flag.startsWith('--aspect='))) {
    console.error('usage: node scripts/headless-scene.mjs <new-output-dir> [--cursor=hidden] [--no-title] [--aspect=landscape|portrait|square]');
    process.exitCode = 2;
  }
  else try { console.log(await captureScene(output, { cursorHidden, aspect, title })); } catch (error) { console.error(error); process.exitCode = 1; }
}
