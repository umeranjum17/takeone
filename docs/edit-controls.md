# Output aspect and format

Run `takeone render <take-dir>` on an already planned recording. Rendering
reads the saved analysis locally and does not call the planner.

`render` accepts `--aspect landscape|portrait|square`, which selects 1920×1080,
1080×1920, or 1080×1080 output. Without this option, portrait source video
defaults to 1080×1920 portrait output and other sources to 1920×1080 landscape,
unless `--set out_w=...` or `--set out_h=...` supplies custom dimensions.
`--resolution 4k` selects 3840×2160 landscape, 2160×3840 portrait, or
3840×3840 square output. Without `--aspect`, 4K orientation follows the source.
Source orientation uses `take.json`'s `stream.w` / `stream.h` when present,
otherwise its `width` / `height`; this also determines the default output size.
Explicit `--set out_w=...` / `--set out_h=...` dimensions are overridden by
these presets.

`--format mp4|gif|webm|prores4444` selects the output container/encoding and
defaults to `mp4`. GIF output is encoded at 15 fps and scaled to at most 1080
pixels on each axis, preserving aspect ratio without upscaling the rendered
MP4; WebM uses VP9, and `prores4444` writes a ProRes 4444 `.mov` file.
These three formats are transcoded from the rendered MP4, which is retained;
ProRes cannot restore detail or chroma discarded by that intermediate.
WebM and 4K MP4 exports carry BT.709 colour tags.
For example:

```sh
takeone render ~/Videos/takeone/<id> --aspect portrait --format gif
takeone render ~/Videos/takeone/<id> --aspect square --resolution 4k --format webm
takeone render ~/Videos/takeone/<id> --set out_w=320 --set out_h=180 --format gif
```

These options apply to recorded takes; motion takes rerender from their saved
`storyboard.json` and reject render options.
