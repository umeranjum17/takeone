// The exact shell used for deterministic demo capture (Linux x86_64).
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '151.0.7922.34';
export const ARCHIVE_SHA256 = '3cfc2bd00d1bafcf8a68dc74c9c92bb7150ddc8d26ade948a776316e1cec4f14';
export const BINARY_SHA256 = 'e11fc9ce65c96313476f7ee9844b6fb6a9220fb048693cfe9eee00acf4170a9f';
export const CACHE = fileURLToPath(new URL('../../.cache/headless-shell/', import.meta.url));
export const SHELL = join(CACHE, VERSION, 'chrome-headless-shell-linux64/chrome-headless-shell');
export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const data of createReadStream(path)) hash.update(data);
  return hash.digest('hex');
}
export async function checkedShell() {
  try { await access(SHELL); }
  catch { throw new Error('Pinned headless shell missing; run node scripts/install-headless-shell.mjs'); }
  if (await sha256(SHELL) !== BINARY_SHA256) throw new Error('Headless shell checksum mismatch; reinstall the pinned shell');
  const version = execFileSync(SHELL, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
  if (!version.endsWith(VERSION)) throw new Error(`Unexpected headless shell: ${version}`);
  return SHELL;
}
export async function installShell() {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Demo shell requires Linux x86_64');
  try { return await checkedShell(); } catch { /* download a verified replacement */ }
  await mkdir(CACHE, { recursive: true });
  const temp = await mkdtemp(join(CACHE, '.install-'));
  try {
    const archive = join(temp, 'shell.zip');
    const url = `https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/linux64/chrome-headless-shell-linux64.zip`;
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Headless shell download failed: HTTP ${response.status}`);
    // Stream the archive to disk rather than retaining the whole download in RAM.
    const { pipeline } = await import('node:stream/promises');
    const { Readable } = await import('node:stream');
    const { createWriteStream } = await import('node:fs');
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
    if (await sha256(archive) !== ARCHIVE_SHA256) throw new Error('Headless shell archive checksum mismatch');
    execFileSync('unzip', ['-q', archive, '-d', join(temp, 'unpacked')]);
    await rm(join(CACHE, VERSION), { recursive: true, force: true });
    await rename(join(temp, 'unpacked'), join(CACHE, VERSION));
    return await checkedShell();
  } finally { await rm(temp, { recursive: true, force: true }); }
}
