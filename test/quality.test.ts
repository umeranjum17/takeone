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

test('golden comparison executes ffmpeg and flags visibly degraded frames', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdirSync, mkdtempSync, rmSync } = await import('node:fs');
  const { resolve, join } = await import('node:path');
  const { compare } = await import('../scripts/quality.ts');
  mkdirSync(resolve('tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('tmp/quality-test-'));
  try {
    for (const colour of ['black', 'white']) execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `color=${colour}:s=64x64:r=60:d=0.2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, `${colour}.mp4`)]);
    const black = join(dir, 'black.mp4'), white = join(dir, 'white.mp4');
    const identical = compare(black, black, dir, false);
    assert.equal(identical.minSSIM, 1);
    assert.deepEqual(identical.framesBelow095, []);
    const degraded = compare(white, black, dir, false);
    assert.ok(degraded.minSSIM < 0.95);
    assert.equal(degraded.framesBelow095.length, 12);
    assert.equal(degraded.vmaf, null);
    assert.ok(degraded.mode.includes('SSIM only'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
