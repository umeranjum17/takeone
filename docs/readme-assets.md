# Dogfood asset set (A1-A10)

One command rebuilds every approved demo asset from fictional demo data and writes a manifest:

```sh
node scripts/install-headless-shell.mjs      # once
npm run build && npm run readme-assets       # or: node scripts/readme-assets.ts [out-dir]
```

The default output is `tmp/readme-assets/`. It needs ffmpeg, ffprobe, the pinned headless shell and no desktop,
account or network. Work takes well over an hour on a loaded host; run it through your usual render limits.

| # | Files | Built from |
|---|---|---|
| A1 | `hero.mp4`, `hero-poster.jpg` | headless board scene at 3840x2160, `make --no-ai --set fps=60` |
| A2 | `synth-demo.mp4` | `scripts/synth-take.ts` |
| A3 | `portrait.mp4` | board scene `--aspect=portrait` |
| A4 | `square.mp4` | board scene `--aspect=square`, `paper` |
| A5 | `motion-hero.mp4` | `takeone motion --recipe launch --theme aurora` on the Tidewater screenshot |
| A6 | `motion-callouts.mp4` | `--recipe feature --theme paper`, three labelled regions |
| A7 | `motion-scroll.mp4` | portrait `scroll-through` in `mono` |
| A8 | `before-after.mp4` | A1's raw capture (paced as the render paced it) beside A1's render |
| A9 | `themes.png` | `scripts/theme-proof.ts` fixture grid, every theme |
| A10 | `stills/*.webp`, `*.jpg` | four fixed fractions of A1 and of A2, 1600x900 |

Each MP4 is a delivery encode (crf 24) of the take's render. Every command rebuilds all A1-A10 assets in order;
A8 uses the A1 take and A10 uses the A1 and A2 outputs from that same run. The manifest contains only files built
by that run.

`manifest.json` records the revision, tool versions, and for every file its sha256, size, recipe, ffprobe facts and
gates: size <= 8 MB, <= 8 Mbit/s, exact dimensions, 60 fps with a matching frame count, H.264 High yuv420p,
bt709 tagging and the duration range, plus a 25 MB total. `passed` is false, and the command exits 1, when any gate
fails. Rows with a `note` carry a known deviation from the studio plan. Measured on one host over separate full builds: the board-scene assets (A1, A3, A4, A8, A9, A10) came out byte-identical; the
motion films (A5-A7) are HyperFrames renders and are not bit-exact (see motion.md), so compare those by gates.
