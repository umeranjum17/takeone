# Temporary-space quota

This host's `/tmp` carries a per-user quota: the disk can show tens of gigabytes free while every write fails with "Disk quota exceeded". Stale scratch is what fills it.

## Sweep

```
node scripts/tmp-sweep.ts --dry-run    # list what would be removed, remove nothing
node scripts/tmp-sweep.ts              # remove it; print bytes reclaimed and free space before/after
node scripts/tmp-sweep.ts --min-age-hours 8
```

Only `puppeteer_dev_chrome_profile-*`, `org.chromium.Chromium.*`, `fhl.*`, `fdpack.*`, `npmprobe2.*` and `tmp.*` directly under `/tmp` are considered, and only when the entry

- was last touched (anywhere in its tree) more than 4 hours ago,
- is a plain directory owned by the current user (symlinks and other users' or root's entries are skipped),
- is not named by a running process: its working directory, open files, command line or environment.

An entry the OS refuses to remove (for example content the user does not own) is listed as skipped and left in place. `/tmp/claude-1000` and `/tmp/opencode` are never touched. The sweep records what it reclaimed under `$TAKEONE_STATE_DIR` (default `~/.local/state/takeone/tmp-sweep.json`), since `/tmp` cannot be written to when it is out of quota.

## When a run hits the quota

Scratch directories (`src/tmpspace.ts`) and the ffmpeg runner report an out-of-quota failure in plain words instead of the raw `mkdtemp` or ffmpeg error: the temporary space is out of quota, what the last sweep freed, what a sweep would free now, and the command to run. `quotaFailure` is the one detection point.
