import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cameraMetrics, edgePosition, regressions, reversals, widestRun, type Metrics } from '../scripts/quality.ts';

test('ratchet preserves goals, rejects regression and missing measurements', () => {
  const baseline: Metrics = {
    pan: { value: 74084, target: 9000, direction: 'max', unit: 'px/s²', goalPassed: false },
    hold: { value: 0.3, target: 1.2, direction: 'min', unit: 's', goalPassed: false },
    speed: { value: 0.82, target: 1, direction: 'max', unit: 'ln/s', goalPassed: true },
  };
  const candidate = structuredClone(baseline);
  candidate.pan!.value = 50000; candidate.hold!.value = 0.6; candidate.speed!.value = 0.95;
  assert.deepEqual(regressions(candidate, baseline), []);
  candidate.pan!.value = 75000; candidate.hold!.value = 0.2; candidate.speed!.value = 1.1;
  assert.equal(regressions(candidate, baseline).length, 3);
  delete candidate.pan;
  assert.ok(regressions(candidate, baseline).some(s => s.includes('disappeared')));
  candidate.speed!.value = NaN;
  assert.ok(regressions(candidate, baseline).some(s => s.includes('invalid')));
  const tightened = structuredClone(baseline); tightened.pan!.value = 10000;
  assert.ok(regressions(baseline, tightened).some(s => s.startsWith('pan:')));
});

test('camera gates distinguish a smooth move, an impulse and an unheld reversal', () => {
  const frames = Array.from({ length: 120 }, (_, i) => ({ t: i / 60, x: i, y: 0, w: 1920, h: 1080 }));
  const smooth = cameraMetrics(frames, 60, 1920, 1080, 1.2);
  assert.equal(smooth.pan_acceleration!.value, 0);
  assert.equal(smooth.pan_bounce!.value, 0);
  assert.equal(smooth.pan_acceleration!.goalPassed, true);
  const spike = structuredClone(frames); spike[60]!.x += 100;
  const bad = cameraMetrics(spike, 60, 1920, 1080, 1.2);
  assert.ok(bad.pan_acceleration!.value > 9000);
  assert.equal(bad.pan_acceleration!.goalPassed, false);
  assert.ok(bad.pan_bounce!.value > 0);
  assert.deepEqual(reversals([1, 1, 0, 0, -1], 10, 0.005), [0.2]);
  assert.throws(() => cameraMetrics([], 60, 1920, 1080, 1.2));
});

test('decoded pixel gates measure flat runs and subpixel edges', () => {
  assert.equal(widestRun(Uint8Array.from([1, 1, 1, 2, 2, 3])), 3);
  const row = Uint8Array.from([0, 0, 0, 0, 50, 100, 100, 100, 100, 100]);
  assert.equal(edgePosition(row, 4), 4);
  assert.equal(edgePosition(new Uint8Array(10), 4), null);
});

test('golden comparison executes ffmpeg and flags visibly degraded frames', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const { mkdirSync, mkdtempSync, rmSync } = await import('node:fs');
  const { resolve, join } = await import('node:path');
  const { compare } = await import('../scripts/quality.ts');
  mkdirSync(resolve('tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('tmp/quality-test-'));
  try {
    const reference = join(dir, 'reference.mp4'), coarse = join(dir, 'coarse.mp4');
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=60:d=0.2',
      '-frames:v', '12', '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv420p', reference]);
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', reference, '-vf', 'scale=20:16,scale=320:240:flags=neighbor',
      '-frames:v', '12', '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv420p', coarse]);
    const identical = compare(reference, reference, dir, false);
    assert.equal(identical.candidateFrames, 12);
    assert.equal(identical.goldenFrames, 12);
    assert.equal(identical.minSSIM, 1);
    assert.deepEqual(identical.framesBelow095, []);
    const degraded = compare(coarse, reference, dir, false);
    assert.ok(degraded.minSSIM < 0.95);
    assert.equal(degraded.framesBelow095.length, 12);
    assert.equal(degraded.vmaf, null);
    assert.ok(degraded.mode.includes('SSIM only'));
    const filters = execFileSync('ffmpeg',['-filters'],{encoding:'utf8',stdio:['ignore','pipe','ignore']});
    if (filters.includes('libvmaf')) {
      const selfVmaf = compare(reference,reference,dir,true);
      const degradedVmaf = compare(coarse,reference,dir,true);
      t.diagnostic(`reference VMAF ${selfVmaf.vmaf}; degraded VMAF ${degradedVmaf.vmaf}; flagged frames ${degradedVmaf.framesBelow095.length}`);
      assert.ok(selfVmaf.vmaf! >= 95, `reference VMAF ${selfVmaf.vmaf}`);
      assert.ok(degradedVmaf.vmaf! < 95, `degraded VMAF ${degradedVmaf.vmaf}`);
      assert.equal(degradedVmaf.framesBelow095.length, 12);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('native Tidewater text stays sharp through the camera and both production encoders', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdirSync, mkdtempSync, rmSync } = await import('node:fs');
  const { resolve, join } = await import('node:path');
  const { zoomSharpness, zoomAcceptance, lumaStats } = await import('../scripts/quality.ts');
  mkdirSync(resolve('tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('tmp/sharpness-test-'));
  try {
    const results = zoomSharpness(resolve('scripts/quality-baseline/tidewater-4k.png'), dir);
    assert.ok(results.every(m => m.passed), JSON.stringify(results));
    const ff = (args: string[]) => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', ...args]);
    const ref = ff(['-i', resolve('scripts/quality-baseline/tidewater-4k.png'), '-vf', 'crop=800:160:530:310:exact=1', '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-']);
    const crop = (video: string, bounds: string) => ff(['-i', video, '-vf', `crop=${bounds}:exact=1`, '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-']);
    const decoded = crop(results[0]!.video, '800:160:10:40');
    const flat = results[0]!.flat;
    const softVideo = join(dir, 'deliberately-soft.mp4');
    const grainVideo = join(dir, 'deliberately-grainy.mp4');
    ff(['-y', '-i', results[0]!.video, '-vf', 'gblur=sigma=1.5', '-c:v', 'libx264', '-crf', '12', softVideo]);
    ff(['-y', '-i', results[0]!.flatVideo, '-vf', 'noise=alls=8:allf=u:all_seed=7', '-c:v', 'libx264', '-crf', '12', grainVideo]);
    const soft = zoomAcceptance(ref, crop(softVideo, '800:160:10:40'), results[0]!.flatReference, flat);
    const grain = zoomAcceptance(ref, decoded, results[0]!.flatReference, lumaStats(crop(grainVideo, '160:30:850:450')));
    assert.equal(soft.sharpnessPassed, false, 'a deliberately soft encoded render must fail');
    assert.equal(soft.passed, false);
    assert.equal(grain.flatPassed, false, 'a deliberately grainy encoded render must fail');
    assert.equal(grain.passed, false);

  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('golden comparison pairs frames across container timestamp precision', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdirSync, mkdtempSync, rmSync } = await import('node:fs');
  const { resolve, join } = await import('node:path');
  const { compare } = await import('../scripts/quality.ts');
  mkdirSync(resolve('tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('tmp/quality-test-'));
  try {
    const video = join(dir, 'alternating.mp4'), reference = join(dir, 'reference.mkv');
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
      "nullsrc=s=64x64:r=60:d=0.2,geq=lum='if(mod(N,2),220,20)':cb=128:cr=128",
      '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv420p', video]);
    // FFV1 preserves decoded pixels but Matroska rounds frame timestamps to milliseconds.
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', video, '-c:v', 'ffv1', reference]);
    const result = compare(video, reference, dir, false);
    assert.equal(result.candidateFrames, 12);
    assert.equal(result.goldenFrames, 12);
    assert.equal(result.minSSIM, 1);
    assert.deepEqual(result.framesBelow095, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
