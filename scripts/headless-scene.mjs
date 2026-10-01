#!/usr/bin/env node
// Offline demo take producer. No portal, display server, input device or account.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchBrowser } from './headless/browser.mjs';
import { VERSION, BINARY_SHA256 } from './headless/shell.mjs';
import { choreography, inputEvents, frameClock, FPS, CSS_SCALE } from './headless/drive.mjs';

export async function captureScene(output) {
  const { steps, frames } = choreography();
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
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 2, mobile: false });
    await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: await readFile(new URL('./headless/clock.js', import.meta.url), 'utf8') });
    const url = new URL('./e2e/scene.html', import.meta.url); url.searchParams.set('headless', '1');
    await browser.send('Page.navigate', { url: url.href });
    // Poll document readiness without advancing the virtual clock.
    for (let i = 0; ; i++) {
      if (await browser.evaluate("document.readyState === 'complete' && typeof window.__takeoneTick === 'function'")) break;
      if (i >= 100) throw new Error('Scene failed to load');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await browser.evaluate(`document.fonts.ready.then(() => {
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
        const x = action.x * CSS_SCALE, y = action.y * CSS_SCALE;
        if (action.k === 'move' || action.k === 'button') {
          await browser.send('Input.dispatchMouseEvent', { type: action.k === 'move' ? 'mouseMoved' : action.down ? 'mousePressed' : 'mouseReleased',
            x, y, ...(action.k === 'button' ? { button: 'left', clickCount: 1 } : {}) });
          if (action.k === 'move') await browser.evaluate(`Object.assign(document.getElementById('takeoneCursor').style, {left:'${action.x}px',top:'${action.y}px'})`);
        } else if (action.k === 'key') {
          await browser.send('Input.dispatchKeyEvent', { type: action.down ? 'keyDown' : 'keyUp', key: action.ch,
            ...(action.down ? { text: action.ch } : {}) });
        } else if (action.k === 'wheel') {
          // Synchronous fixture scrolling avoids the browser's asynchronous wheel queue.
          await browser.evaluate(`document.getElementById('feed').scrollTop += ${action.dy}`);
        }
      }
      await browser.evaluate('window.__takeonePaint()');
      const { data } = await browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
      await new Promise((resolve, reject) => encoder.stdin.write(Buffer.from(data, 'base64'), error => error ? reject(error) : resolve()));
      if (frame % 300 === 0) console.log(`headless scene: ${frame}/${frames} frames`);
    }
    encoder.stdin.end(); await encoding;
    if (cancelled) throw new Error('Headless capture interrupted');
    const events = inputEvents(steps, frames);
    await writeFile(join(dir, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
    await writeFile(join(dir, 'frames.tsv'), frameClock(frames));
    await writeFile(join(dir, 'take.json'), JSON.stringify({
      id: 'headless-demo', stream: { w: 3840, h: 2160 }, scale: 2, offset_ms: 0, fps: FPS,
      started_at: '2026-01-01T00:00:00.000Z', stopped_at: new Date(Date.UTC(2026,0,1) + frames * 1000 / FPS).toISOString(),
      pointer: 'mapped', events: 'on', monitor: null, warnings: [],
      clock: { offsetMs: 0, medianMs: 0, spreadMs: 0, frames },
      source: { kind: 'headless-demo', css: { w: 1920, h: 1080 }, browser: VERSION, sha256: BINARY_SHA256 },
      title: 'From idea to launch',
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
  if (!output || extra.length) { console.error('usage: node scripts/headless-scene.mjs <new-output-dir>'); process.exitCode = 2; }
  else try { console.log(await captureScene(output)); } catch (error) { console.error(error); process.exitCode = 1; }
}
