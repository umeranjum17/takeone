# Manual edit seams: no camera jump on a real take (t1-pm-19)

Proof only; no production code changes. Outcome: on a real 43.1 s take, a cut and a
2x speed region render with no camera jump at any seam.

## Take and edits

Read-only source take: `data/takes/headless-run-a` (Tidewater headless demo,
3840x2160 @ 60 fps, `screen.webm` sha256
`bfe7d750c092c13db9db04781d927b7f5d711e7b2a91b10be0d825dfe497cfc7`). It was copied
into worktree scratch; the original was never written.

Edits added to the copy's `take.json` (the documented `cuts` / `speed` fields):

- `cuts: [{t0: 2.1, t1: 2.6}]` - 0.5 s removed from the opening travel, so the join
  lands mid-pan.
- `speed: [{t0: 6.0, t1: 6.6, rate: 2}]` - a 2x region across the beat-4 establish
  move; both boundaries land mid-pan.

Both seams are placed where the camera is moving, per the brief. The applied
ffmpeg clock is in `takeone-seams-after-camera-cmd.txt`:
`select='not(gte(t,2.1)*lt(t,2.6))'` removes the cut interval and
`setpts='(T-(1*clip(T-2.1,0,0.5)+0.5*clip(T-6,0,0.6)+...))/TB'` warps the 2x region
and the idle squeezes on one clock.

## Renders

`render <take> --aspect landscape --set preset=veryfast`, through `fm-mem-gate.sh`,
one at a time. `preset` is the only changed dimension; camera solver and edit code
are unmodified from `aff860e`.

| Render | Duration | 1920x1080 MP4 sha256 |
| --- | --- | --- |
| before (no cuts/speed) | 41.1333 s | `21e199767b2c9990f0af7ec8509a1e05c6385e9645e91dec0dd45dec01f436f8` |
| after (cut + 2x speed) | 40.3167 s | `5ca23b277270ffeaa628ec6ee31b17c69296b13d83a8790cbb3c6d98cc672e2a` |

The 0.8167 s output delta matches the 0.5 s cut plus 0.3 s saved by the 0.6 s 2x region.

## Camera continuity at each seam

Per-frame camera rects from the after render's `camera.json` (60 fps). Motion is
`|d centre| / w + |ln(w_i / w_{i-1})|` between adjacent output frames.

| Seam | Output time / frame | Seam motion | Neighbour max | Ratio |
| --- | --- | --- | --- | --- |
| cut join (2.1-2.6 removed) | 2.100 s / f126 | 0.01190 | 0.01200 | 0.99 |
| speed entry (1x -> 2x) | 5.500 s / f330 | 0.01339 | 0.01600 | 0.84 |
| speed exit (2x -> 1x) | 5.800 s / f348 | 0.01165 | 0.01518 | 0.77 |

Every seam moves no more than its neighbouring frames (ratios <= 1.00), and the
seam value sits inside the local ramp - no step. Full table:
`takeone-seams-camera-metrics.txt`.

## Frame strips (5 frames either side of each seam)

- cut: `takeone-seams-cut-strip-before.png`, `takeone-seams-cut-strip-after.png`
- speed entry: `takeone-seams-speed-entry-strip-before.png`, `...-after.png`
- speed exit: `takeone-seams-speed-exit-strip-before.png`, `...-after.png`

Each strip is 11 consecutive output frames centred on the seam. The framing pans
continuously across the join; no jump.

## Clips

- `takeone-seams-raw-vs-render.mp4` - raw `screen.webm` (left) vs the after render
  (right), first 8 s.
- `takeone-seams-before-vs-after.mp4` - before render (left) vs after render
  (right), first 8 s; the after side is visibly ahead after the cut and 2x region.

## Reproduction

```
cp -r <source take> tmp/t1-pm-19/{before,after}
# edit after/take.json: cuts=[{t0:2.1,t1:2.6}], speed=[{t0:6.0,t1:6.6,rate:2}]
fm-mem-gate.sh taskset -c 0-7 node bin/takeone.mjs render <abs>/before --aspect landscape --set preset=veryfast
fm-mem-gate.sh taskset -c 0-7 node bin/takeone.mjs render <abs>/after  --aspect landscape --set preset=veryfast
python3 tmp/t1-pm-19/camcheck.py <abs>/after 2.1 5.5 5.8
```

After render: `takeone-seams-after-camera.json` (sha256
`d9342656e27a306eaeb7a9db7f9cb144a09199bd340765ff6dd8e59d3652eda6`). The full
before/after MP4s live with the task evidence, not in this public repo.
