import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { checkedShell, CACHE } from './shell.mjs';

export async function launchBrowser() {
  const binary = await checkedShell();
  const profile = await mkdtemp(join(CACHE, 'profile-'));
  const child = spawn(binary, [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking',
    '--disable-threaded-animation', '--disable-threaded-scrolling', '--disable-features=Translate',
    '--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb', '--force-device-scale-factor=2',
    // Full-layer raster on every invalidation: partial raster re-rasters only dirty
    // tiles, and Skia's tile-clipped coverage differs by a few levels from the full
    // raster on 1px rounded borders, so two captures could decode to different frames.
    '--disable-partial-raster',
    '--run-all-compositor-stages-before-draw', '--hide-scrollbars', '--window-size=1920,1080',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let failure, stderr = '', socket;
  child.on('error', error => { failure = error; });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
  let id = 0;
  const pending = new Map();
  const rejectPending = error => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  const close = async () => {
    rejectPending(new Error('Browser closed')); socket?.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) await delay(20);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL'); await new Promise(resolve => child.once('close', resolve));
      }
    }
    await rm(profile, { recursive: true, force: true });
  };
  try {
    let port;
    for (let i = 0; i < 200; i++) {
      if (failure) throw failure;
      if (child.exitCode !== null) throw new Error(`Headless shell exited: ${stderr}`);
      try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await delay(50); }
    }
    if (!port) throw new Error(`Headless shell startup timed out: ${stderr}`);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
    const page = targets.find(target => target.type === 'page');
    if (!page) throw new Error('Headless shell has no page target');
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connection timed out')), 5000);
      socket.onopen = () => { clearTimeout(timer); resolve(); };
      socket.onerror = () => { clearTimeout(timer); reject(new Error('CDP connection failed')); };
    });
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    };
    socket.onclose = () => rejectPending(new Error('CDP disconnected'));
    socket.onerror = () => rejectPending(new Error('CDP socket error'));
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const seq = ++id;
      const timer = setTimeout(() => { pending.delete(seq); reject(new Error(`CDP timeout: ${method}`)); }, 30_000);
      pending.set(seq, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: seq, method, params }));
    });
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(`Scene script failed: ${JSON.stringify(result.exceptionDetails)}`);
      return result.result.value;
    };
    return { send, evaluate, close };
  } catch (error) { await close(); throw error; }
}
