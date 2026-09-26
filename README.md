# takeone

Turn a raw screen recording into a polished demo.

You record yourself using an app as you normally would. The camera work — where it
zooms, when it pans, when it holds still — is decided afterwards, frame by frame,
rather than asked of you while you are trying to demonstrate something.

Private. Runs on your own machine.

## Render an existing take

The current slice provides `render` only; recording and planning are not yet
available here. With a Node.js version supporting TypeScript stripping and
ffmpeg on PATH, prepare a take directory containing `screen.webm`, `take.json`
(at least `width` and `height` in source pixels), `analysis/beats.json`, and
`analysis/decisions.jsonl`. Each beat needs a matching decision whose A (and
optional B) names refer to that beat's zones.

```sh
node --experimental-strip-types src/cli.ts render /path/to/take
node --experimental-strip-types src/cli.ts render /path/to/take --set fps=24
```

`--set key=value` overrides camera settings defined in `src/camera/defaults.ts`;
rerendering does not call the planner. Render writes `camera.json`, `camera.cmd`,
and a silent H.264 MP4 at `out/<id>.mp4` inside the take directory (default
1920×1080 at 30 fps). Whole-screen shots of non-16:9 sources are centred
with padding in the export background (`#202124` by default) rather than cropped;
zooming can crop the screen. Set the padding colour with
`--set background=#RRGGBB`. If `take.json` omits `id`, the directory name is
used; if it omits `trim_end`, the latest beat end is used.
