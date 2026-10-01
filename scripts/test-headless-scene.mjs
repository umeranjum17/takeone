#!/usr/bin/env node
// Executable acceptance gate: full takes, decoded pixels, clocks and real make.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { captureScene } from './headless-scene.mjs';
import { choreography, FPS } from './headless/drive.mjs';

const root = resolve(process.argv[2] ?? 'tmp/headless-validation');
await mkdir(root, { recursive: true });
const run = await mkdtemp(join(root, 'run-'));
const a = join(run, 'a');
const b = join(run, 'b');
await captureScene(a);
await captureScene(b);
const expected = choreography().frames;
const decode = dir => execFileSync('ffmpeg', ['-v','error','-i',join(dir,'screen.webm'),'-f','framemd5','-'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const probe = dir => JSON.parse(execFileSync('ffprobe', ['-v','error','-select_streams','v:0','-count_frames',
  '-show_entries','stream=width,height,r_frame_rate,avg_frame_rate,nb_read_frames:frame=best_effort_timestamp_time',
  '-of','json',join(dir,'screen.webm')], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
for (const dir of [a,b]) {
  const info = probe(dir), stream = info.streams[0];
  assert.equal(stream.width,3840); assert.equal(stream.height,2160);
  assert.equal(stream.r_frame_rate,'60/1'); assert.equal(stream.avg_frame_rate,'60/1');
  assert.equal(Number(stream.nb_read_frames),expected);
  assert.equal(info.frames.length,expected);
  // WebM's 1 ms timebase quantizes 60 Hz timestamps; accept only that rounding.
  for (const [i, frame] of info.frames.entries()) assert.ok(Math.abs(Number(frame.best_effort_timestamp_time) - i/FPS) <= .000501, `frame ${i} timestamp`);
  const rows = (await readFile(join(dir,'frames.tsv'),'utf8')).trim().split('\n');
  assert.equal(rows.length,expected);
  rows.forEach((row,i) => {
    const [rtp,recv] = row.split('\t').map(Number);
    assert.equal(rtp,i*1500); assert.equal(recv,Math.round(i*1_000_000_000/FPS));
  });
  const events = (await readFile(join(dir,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  let last = -1;
  for (const e of events) {
    assert.ok(e.t >= last && e.t >= 0 && e.t < expected * 1000 / FPS); last = e.t;
    assert.ok(['ptr','btn','key','win','wheel'].includes(e.k));
    if (e.k === 'ptr') assert.ok(e.x >= 0 && e.x < 3840 && e.y >= 0 && e.y < 2160);
    if (e.k === 'key') {
      assert.deepEqual(Object.keys(e).sort(),['cls','down','k','t']);
      assert.ok(['char','space'].includes(e.cls)); assert.equal(typeof e.down,'boolean');
    }
  }
  assert.equal(events.filter(e => e.k === 'ptr').length,expected);
  const wheelEvents = events.filter(e => e.k === 'wheel');
  assert.ok(wheelEvents.length > 0);
  assert.ok(wheelEvents.some(e => e.dy < 0), 'downward feed movement must serialize as negative wheel delta');
  assert.ok(wheelEvents.some(e => e.dy > 0), 'upward feed movement must serialize as positive wheel delta');
}
const md5A = decode(a), md5B = decode(b);
const decodedHash = text => createHash('sha256').update(text).digest('hex');
assert.equal(decodedHash(md5A),decodedHash(md5B),'decoded frames differ across captures');
assert.ok(new Set(md5A.split('\n').filter(line => !line.startsWith('#') && line.trim()).map(line => line.split(',').at(-1).trim())).size > 300, 'scene must contain real visual interactions');
assert.equal(await readFile(join(a,'events.jsonl'),'utf8'),await readFile(join(b,'events.jsonl'),'utf8'),'input logs differ');
assert.equal(await readFile(join(a,'frames.tsv'),'utf8'),await readFile(join(b,'frames.tsv'),'utf8'),'frame clocks differ');
// This executes the existing CLI and render pipeline without changing it.
execFileSync(process.execPath, ['bin/takeone.mjs','make',a,'--no-jev','--set','fps=60','--set','preset=ultrafast'], { stdio:'inherit', timeout: 600_000 });
const beats = JSON.parse(await readFile(join(a,'analysis/beats.json'),'utf8'));
for (const kind of ['click','drag','type']) assert.ok(beats.some(beat => beat.kind === kind), `make must plan a ${kind} beat`);
const video = join(a,'out/headless-demo.mp4');
const duration = Number(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',video],{encoding:'utf8'}).trim());
const contact = join(run,'takeone-headless-scene-after.png');
execFileSync('ffmpeg',['-v','error','-y','-i',video,'-vf',`fps=${16/duration},scale=480:270,tile=4x4`,'-frames:v','1',contact],{stdio:'inherit',timeout:120_000});
const metrics = { width:3840, height:2160, fps:FPS, frames:expected, decoded_frames_identical:true,
  events_identical:true, framemd5_sha256:decodedHash(md5A), contact_sheet:contact, beat_kinds:[...new Set(beats.map(beat=>beat.kind))], take:a };
await writeFile(join(run,'metrics.json'),JSON.stringify(metrics,null,2)+'\n');
await writeFile(join(run,'frames.framemd5'),md5A);
console.log(JSON.stringify({ ...metrics, evidence:run },null,2));
