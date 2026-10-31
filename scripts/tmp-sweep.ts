/**
 * Sweep stale per-user scratch under /tmp (the host's per-user quota fills with it).
 *
 *   node scripts/tmp-sweep.ts --dry-run       list what would go, remove nothing
 *   node scripts/tmp-sweep.ts                 remove it, print reclaimed bytes and free space
 *   node scripts/tmp-sweep.ts --min-age-hours 8
 *
 * The root is always /tmp. Only these shapes are touched: puppeteer_dev_chrome_profile-*,
 * org.chromium.Chromium.*, fhl.*, fdpack.*, npmprobe2.* and tmp.*, when older than the
 * floor, ours, a plain directory, and not held by a running process. Everything else
 * (other users' files, root-owned paths, /tmp/claude-1000, /tmp/opencode) is left alone.
 */

import { DEFAULT_MIN_AGE_HOURS, human, plan, sweep } from "../src/tmpsweep.ts";
import { recordSweep } from "../src/tmpspace.ts";

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const at = args.indexOf("--min-age-hours");
const minAgeHours = at >= 0 ? Number(args[at + 1]) : DEFAULT_MIN_AGE_HOURS;
if (!(minAgeHours >= 0)) { console.error("tmp-sweep: --min-age-hours needs a number"); process.exit(2); }
const unknown = args.filter((a, i) => a !== "--dry-run" && a !== "--min-age-hours" && args[i - 1] !== "--min-age-hours");
if (unknown.length) { console.error(`tmp-sweep: unknown argument ${unknown[0]}`); process.exit(2); }

const skippedLine = (s: { path: string; reason: string }) => `  skip   ${s.path}  (${s.reason})`;

function printSkipped(skipped: { path: string; reason: string }[]): void {
  // Thousands of young entries are normal; show each unusual skip, summarise the rest.
  const young = skipped.filter(s => s.reason.startsWith("touched"));
  for (const s of skipped.filter(s => !s.reason.startsWith("touched"))) console.log(skippedLine(s));
  if (young.length) console.log(`  skip   ${young.length} entries touched within the ${minAgeHours} h floor`);
}

if (dry) {
  const p = plan({ minAgeHours });
  console.log(`tmp-sweep dry run: ${p.root}, entries older than ${minAgeHours} h, nothing removed`);
  for (const e of p.remove) console.log(`  would remove  ${e.path}  ${human(e.bytes)}  ${e.ageHours.toFixed(1)} h old`);
  printSkipped(p.skipped);
  const total = p.remove.reduce((n, e) => n + e.bytes, 0);
  console.log(`swept shapes now: ${human(p.shapeBytes)}; would remove ${p.remove.length} entries, ${human(total)}; after: ${human(p.shapeBytes - total)}`);
} else {
  const r = sweep({ minAgeHours });
  console.log(`tmp-sweep: ${r.root}, entries older than ${minAgeHours} h`);
  for (const e of r.removed) console.log(`  removed  ${e.path}  ${human(e.bytes)}`);
  for (const s of r.refused) console.log(skippedLine(s));
  printSkipped(r.skipped);
  const total = r.removed.reduce((n, e) => n + e.bytes, 0);
  recordSweep(total);
  console.log(`swept shapes before: ${human(r.shapeBytes)}, after: ${human(r.shapeBytesAfter)}; reclaimed ${total} bytes (${human(total)}) in ${r.removed.length} entries`);
  console.log(`free space on ${r.root}: before ${human(r.freeBefore)}, after ${human(r.freeAfter)}`);
}
