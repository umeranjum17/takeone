# t1-pm-4 real-take framing evidence

This committed package preserves the requested review artifacts. The two MP4s
for Acme are the reported baseline and current camera renders. The Tidewater
MP4 and strip are the reported real board take and drag sequence; the after-half
sheet shows Acme at 1 fps from 16 through 32 seconds.

## Reported outcomes

The source report states that Acme's retention thumb and cursor had zero crop
misses over 841 frames from 16–30 s. The beat table reports these results:

| Take | Beat | Frames | Before visible | After visible | Regressions | Drag frames | Drag clipped | Result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Acme | b1 | 197 | 197 | 197 | 0 | 0 | 0 | PASS |
| Acme | b2 | 166 | 2 | 2 | 0 | 0 | 0 | PASS |
| Acme | b3 | 577 | 577 | 577 | 0 | 0 | 0 | PASS |
| Acme | b4 | 676 | 0 | 676 | 0 | 222 | 0 | PASS |
| Acme | b5 | 209 | 181 | 209 | 0 | 0 | 0 | PASS |
| Tidewater | b1 | 166 | 166 | 166 | 0 | 0 | 0 | PASS |
| Tidewater | b2 | 1 | 0 | 0 | 0 | 0 | 0 | PASS |
| Tidewater | b3 | 191 | 136 | 136 | 0 | 0 | 0 | PASS |
| Tidewater | b4 | 339 | 339 | 339 | 0 | 0 | 0 | PASS |
| Tidewater | b5 | 1 | 0 | 0 | 0 | 0 | 0 | PASS |
| Tidewater | b6 | 908 | 850 | 908 | 0 | 117 | 0 | PASS |
| Tidewater | b7 | 270 | 270 | 270 | 0 | 0 | 0 | PASS |
| Tidewater | b8 | 3 | 0 | 0 | 0 | 0 | 0 | PASS |
| Tidewater | b9 | 145 | 94 | 145 | 0 | 0 | 0 | PASS |
| Tidewater | b10 | 124 | 124 | 124 | 0 | 0 | 0 | PASS |

## Provenance and reproduction status

`output-report.txt` identifies Tidewater as a scored headless board take
originating from `scripts/e2e/scene.html`, with native 3840×2160, 60 fps input,
rendered at 1920×1080, 60 fps, H.264 CRF 18. It reports the drag at
16.65–18.583333 s (117 output frames), with zero cursor/object misses, and
identifies the first changed region footprint as `[476,288,800,280]` source
pixels. The report names base main `9baea61a62b08fa464d6a578e6f3c0ac74ded592`
and candidate `97328b4`.

This evidence was supplied from
`/home/umer/.treehouse/takeone-9abf5c/11/takeone/tmp/evidence/t1-pm-4`. Its
cited raw Tidewater source directory
`/home/umer/.treehouse/takeone-9abf5c/11/takeone/tmp/headless-run-a` is absent.
The supplied candidate identifier also differs from this package's candidate
(`63368ac21267553a51c324a46b90387bfa8898f4`, based on
`684fb6c4f6b1216c5b2aab1f5ebfc35a16569bf3`). Therefore the original render
cannot be independently regenerated from the supplied source or certified as
rendered by this exact candidate. The committed MP4s, sheets, strip, and report
preserve the visual evidence and reported measurements, but do not resolve that
provenance gap.

Verify the committed artifact bytes from the repository root with:

```sh
(cd docs/quality-evidence/t1-pm-4 && sha256sum -c SHA256SUMS)
ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height,avg_frame_rate,nb_frames,duration,codec_name \
  -of default=noprint_wrappers=1 docs/quality-evidence/t1-pm-4/tidewater-real-after.mp4
```

The Tidewater render reports H.264, 1920×1080, 60 fps, 2396 frames, and
39.933333 s. Re-rendering and rerunning the per-beat comparison require the
missing raw Tidewater take and its before/after camera JSON; those inputs were
not present in the supplied evidence directory. No synthetic fixture is used
as a substitute for this real-take proof.

## Artifacts

- `acme-after-half-sheet.png`: 1 fps Acme after sheet, 16–32 s.
- `acme-before.mp4`, `acme-after.mp4`: Acme baseline and current camera renders.
- `tidewater-real-strip.png`: real-take drag strip through the drop.
- `tidewater-real-after.mp4`: rendered Tidewater real take.
- `beat-results.txt`: original per-beat before/after visibility table.
- `output-report.txt`: source provenance and output-review report.
- `SHA256SUMS`: integrity hashes for every artifact above.
