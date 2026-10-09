# Output aspect and format

Run `takeone render <take-dir>` on an already planned recording. Rendering
reads the saved analysis locally and does not call the planner.

`render` accepts `--aspect landscape|portrait|square|4:5`, which selects
1920×1080, 1080×1920, 1080×1080, or 1080×1350 output; the ratio spellings
`16:9`, `9:16` and `1:1` are aliases for `landscape`, `portrait` and `square`.
Without this option, portrait source video defaults to 1080×1920 portrait output
and other sources to 1920×1080 landscape, unless `--set out_w=...` or
`--set out_h=...` supplies custom dimensions. `--resolution 4k` selects
3840×2160 landscape, 2160×3840 portrait, 3840×3840 square, or 3072×3840 for
`4:5` output (the 3840-pixel long edge is kept for every orientation). Without
`--aspect`, 4K orientation follows the source.
Source orientation uses `take.json`'s `stream.w` / `stream.h` when present,
otherwise its `width` / `height`; this also determines the default output size.
Explicit `--set out_w=...` / `--set out_h=...` dimensions are overridden by
these presets. When the output is narrower than the source (for example a 9:16,
1:1 or 4:5 export of a 16:9 capture), the camera crops in to fill the frame —
centred on each shot's subject — so the screen is never scaled down into a
letterboxed strip; the app fills the whole frame.

`--format mp4|gif|webm|prores4444` selects the output container/encoding and
defaults to `mp4`. GIF output is encoded at 15 fps and scaled to at most 1080
pixels on each axis, preserving aspect ratio without upscaling the rendered
MP4; WebM uses VP9, and `prores4444` writes a ProRes 4444 `.mov` file.
These three formats are transcoded from the rendered MP4, which is retained;
ProRes cannot restore detail or chroma discarded by that intermediate.
The MP4, WebM and ProRes exports carry BT.709 colour tags; GIF is palette-based
and has no colour tags.
For example:

```sh
takeone render ~/Videos/takeone/<id> --aspect portrait --format gif
takeone render ~/Videos/takeone/<id> --aspect square --resolution 4k --format webm
takeone render ~/Videos/takeone/<id> --set out_w=320 --set out_h=180 --format gif
```

These options apply to recorded takes; motion takes rerender from their saved
`storyboard.json` and reject render options.

## Speed

`take.json`'s `speed[]` entries change playback rate. Rates from `0.1` to `16`
are accepted: `2` doubles the speed, `0.5` halves it. Source-second intervals are
half-open (`t0` included, `t1` excluded) and are clipped to the trim.

A timed region plays one interval at that rate:

```json
{ "speed": [ { "t0": 8, "t1": 12, "rate": 2 } ] }
```

A `rate: 1` region disables automatic idle compression there. To apply a rate to
the whole video, cover its full source interval with one region.

A single untimed `type_speed` entry speeds up every detected typing burst in the
take, derived from its recorded key events; it needs no timestamps:

```json
{ "speed": [ { "kind": "type_speed", "rate": 3 } ] }
```

With no typing events `type_speed` has no effect, and `render` says so once.

Precedence is cuts, timed speed, typing speed, then automatic idle speed: a
timed region overrides a typing burst it overlaps. Footage, camera, clicks and
caption starts all move on the one source-to-output clock; caption durations
stay output seconds, so speed-up never reduces reading time. Timed regions may
touch but must not overlap; unsorted intervals work; invalid entries name their
field (for example `speed[0].rate (0.1..16)`).
