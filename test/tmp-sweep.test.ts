import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runFfmpeg } from "../src/render/ffmpeg.ts";
import { human, plan, sweep } from "../src/tmpsweep.ts";
import { TmpQuotaError, isQuotaError, quotaFailure, recordSweep, scratchDirSync } from "../src/tmpspace.ts";

const HOUR = 3_600_000;

/** A fake /tmp: entries aged by hours, each holding one 64 KB file. */
function fakeTmp(entries: Record<string, number>): string {
  const root = mkdtempSync(join(tmpdir(), "takeone-sweep-test-"));
  for (const [name, hours] of Object.entries(entries)) {
    const dir = join(root, name);
    mkdirSync(dir);
    const file = join(dir, "data.bin");
    writeFileSync(file, Buffer.alloc(65536, 1));
    const t = new Date(Date.now() - hours * HOUR);
    utimesSync(file, t, t);
    utimesSync(dir, t, t);
  }
  return root;
}

test("a sweep removes old entries of the swept shapes and nothing else", () => {
  const root = fakeTmp({
    "puppeteer_dev_chrome_profile-aaa": 30, "org.chromium.Chromium.bbb": 30, "fhl.ccc": 30, "fdpack.ddd": 30, "npmprobe2.eee": 30, "tmp.fff": 30,
    "tmp.young": 1, "unrelated": 30, "claude-1000": 30, "opencode": 30,
  });
  try {
    const dry = plan({ root, inUse: [] });
    assert.deepEqual(dry.remove.map(e => e.path.slice(root.length + 1)).sort(), ["fdpack.ddd", "fhl.ccc", "npmprobe2.eee", "org.chromium.Chromium.bbb", "puppeteer_dev_chrome_profile-aaa", "tmp.fff"]);
    assert.ok(existsSync(join(root, "tmp.fff")), "plan removes nothing");
    assert.match(dry.skipped.map(s => s.reason).join("\n"), /under the 4 h floor/);

    const done = sweep({ root, inUse: [] });
    assert.equal(done.removed.length, 6);
    assert.ok(done.removed.every(e => e.bytes >= 65536));
    assert.ok(done.shapeBytesAfter < done.shapeBytes);
    for (const keep of ["tmp.young", "unrelated", "claude-1000", "opencode"]) assert.ok(existsSync(join(root, keep)), keep);
    assert.ok(!existsSync(join(root, "tmp.fff")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a sweep skips what a live process holds, another user's entries, and symlinks", () => {
  const root = fakeTmp({ "fhl.held": 30, "fhl.cwd": 30, "fhl.env": 30, "fhl.free": 30 });
  try {
    symlinkSync(join(root, "fhl.free"), join(root, "fhl.link"));
    const inUse = [`--user-data-dir=${root}/fhl.held/Default`, join(root, "fhl.cwd"), `TMPDIR=${root}/fhl.env`];
    const p = plan({ root, inUse, uid: process.getuid!() });
    assert.deepEqual(p.remove.map(e => e.path.slice(root.length + 1)), ["fhl.free"]);
    const reasons = Object.fromEntries(p.skipped.map(s => [s.path.slice(root.length + 1), s.reason]));
    assert.match(reasons["fhl.held"] ?? "", /running process/);
    assert.match(reasons["fhl.cwd"] ?? "", /running process/);
    assert.match(reasons["fhl.env"] ?? "", /running process/);
    assert.match(reasons["fhl.link"] ?? "", /not a plain directory/);

    const other = plan({ root, inUse: [], uid: process.getuid!() + 1 });
    assert.equal(other.remove.length, 0);
    assert.match(other.skipped[0]?.reason ?? "", /not ours/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an entry the OS refuses to remove is reported, not retried", { skip: process.getuid?.() === 0 }, () => {
  const root = fakeTmp({ "fhl.locked": 30 });
  try {
    chmodSync(join(root, "fhl.locked"), 0o500);
    const r = sweep({ root, inUse: [] });
    assert.equal(r.removed.length, 0);
    assert.match(r.refused[0]?.reason ?? "", /refused/);
  } finally { chmodSync(join(root, "fhl.locked"), 0o700); rmSync(root, { recursive: true, force: true }); }
});

test("human sizes", () => {
  assert.equal(human(512), "512 B");
  assert.equal(human(1536), "1.5 KB");
});

test("EDQUOT is recognised by code and by the ffmpeg tail", () => {
  assert.ok(isQuotaError(Object.assign(new Error("EDQUOT: quota exceeded, mkdtemp '/tmp/x'"), { code: "EDQUOT" })));
  assert.ok(isQuotaError(new Error("ffmpeg exited 1\nError writing: Disk quota exceeded")));
  assert.ok(!isQuotaError(new Error("ffmpeg exited 1\nNo such file")));
  const plain = new Error("boom");
  assert.equal(quotaFailure(plain), plain);
});

test("a forced EDQUOT says the temporary space is out of quota, what a sweep freed, and what to run", async () => {
  const state = mkdtempSync(join(tmpdir(), "takeone-quota-state-"));
  const prior = process.env.TAKEONE_STATE_DIR;
  process.env.TAKEONE_STATE_DIR = state;
  try {
    recordSweep(3 * 1024 ** 3, Date.UTC(2026, 9, 31));
    const e = quotaFailure(Object.assign(new Error("EDQUOT"), { code: "EDQUOT" }));
    assert.ok(e instanceof TmpQuotaError);
    assert.match(e.message, /temporary space \(\/tmp\) is out of quota/);
    assert.match(e.message, /last sweep freed 3\.0 GB/);
    assert.match(e.message, /node scripts\/tmp-sweep\.ts/);
    assert.doesNotMatch(e.message, /printf|mkdtemp/);

    // ffmpeg ending in "Disk quota exceeded" arrives as the same plain error.
    const bin = join(state, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "ffmpeg"), "#!/bin/sh\necho 'Error writing trailer: Disk quota exceeded' >&2\nexit 1\n", { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try { await assert.rejects(runFfmpeg(["-i", "x"]), (err: Error) => err instanceof TmpQuotaError && /out of quota/.test(err.message)); }
    finally { process.env.PATH = path; }
  } finally {
    if (prior === undefined) delete process.env.TAKEONE_STATE_DIR; else process.env.TAKEONE_STATE_DIR = prior;
    rmSync(state, { recursive: true, force: true });
  }
});

test("scratchDirSync creates a directory under the temp dir when there is room", () => {
  const dir = scratchDirSync("takeone-sweep-probe-");
  try { assert.ok(existsSync(dir)); } finally { rmSync(dir, { recursive: true, force: true }); }
});
