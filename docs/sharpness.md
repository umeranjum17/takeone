# Native-pixel export sharpness

A 3840×2160 Tidewater browser capture at device scale factor 2 reproduces the
soft zoom. The scene has a fixed 2560×1440 CSS layout; a 0.75 page zoom fits it
in the 1920×1080 CSS viewport. Chromium rasterizes the page at its final size;
the captured PNG is native 3840×2160, not an enlarged screenshot. The proof take
uses lossless VP9 4:4:4 to isolate export loss from recording compression.

## Cause and measurements

The old standard graph first scaled the entire native stage to 1920×1080,
then used a cubic perspective warp to enlarge the region of interest. With a
4K source the stage is 4262×2398: the initial scale retained only 45.05% of its
linear resolution (20.3% of its pixel count). Zoom could not recover that detail.
The old master tier first scaled to 3840×2160, so it largely avoided this loss
on this particular 4K fixture, but not on higher-resolution sources.

The old default allowed 1.5 output pixels per source pixel: a 1280×720 crop
could fill a 1920×1080 export (2.25× area enlargement). The new default is 1.0:
the minimum viewport for a 1920×1080 export is 1920×1080 source pixels.
See [render settings](../README.md#render-an-existing-take) for the upscale
override. No framing rules, themes or overlays change.

The before/after proof holds the native 1.0 cap constant to isolate the sampler;
the before export uses the old camera filter and CRF 18.

All scores below are decoded luma gradient energy divided by the exact native
800×160 text crop. The compared viewport is 1920×1080 source pixels, offset by
0.25/0.5 source pixels, so it tests subpixel sampling at 1:1. Ratios are not
percentages of OCR confidence or perceptual quality.

| Path | Energy / native reference |
| --- | ---: |
| Old draft: pre-scale, linear warp, CRF 23 | 0.344 |
| Old standard: pre-scale, cubic warp, CRF 18 | 0.489 |
| Old master: 2× pre-scale, cubic warp, Lanczos downscale, CRF 14 | 0.798 |
| Native perspective intermediate, final bilinear resize (unencoded) | 0.607 |
| Native perspective intermediate, final Lanczos resize (unencoded) | 0.799 |
| Native perspective intermediate, final spline resize (unencoded) | 0.781 |
| Direct flat transform, linear (unencoded) | 0.623 |
| Direct flat transform, cubic (unencoded) | 0.764 |
| Direct flat transform, Lanczos (unencoded) | 0.781 |
| Direct flat transform, spline16 (unencoded) | 0.802 |
| New standard: RGB16 direct Lanczos, CRF 12, animation tune | 0.777 |
| New master: RGB16 direct Lanczos, CRF 12, animation tune, 4:4:4 | 0.776 |

The final graph uses `v360` with flat input/output, no rotation, and independent
horizontal/vertical field of view and offsets. This is an affine camera crop,
not a spherical lens effect. It maps native source pixels directly into export
pixels in one Lanczos resample in a 16-bit RGB intermediate; draft uses linear.
Before each warp, `areaPrefilter` computes horizontal/vertical area coverage at
that frame's actual viewport-to-output scale, including retimed shutter samples.
Separable five-tap RGB16 row/column convolution uses symmetric nonnegative Q15
weights summing to 32768, avoiding 32-bit accumulation overflow. Coefficient
error is at most 2/32768; numerical output bounds are 4.5 RGB16 LSB per axis,
9 combined including rounding. Scales at or below one are exact identity;
scales above five are rejected rather than silently truncating support.
There is no fixed-ratio branch, pre-scale, intermediate upscale or final
dimensional resize. Numerical bounds do not qualify judder, VMAF or cost.
Colour-matrix conversion
still uses `scale` without changing dimensions. Frame commands preserve
fractional positions; updates fall between frame timestamps to avoid rounding
an update into the following frame.

Encoder sensitivity was isolated with the direct Lanczos path:

| Encoder | Energy / native reference |
| --- | ---: |
| CRF 18, slow, 4:2:0 | 0.778 |
| CRF 16, slow, 4:2:0 | 0.778 |
| CRF 16, slow, animation tune, 4:2:0 | 0.777 |
| CRF 16, veryfast, animation tune, 4:2:0 | 0.769 |
| CRF 12, slow, animation tune, 4:2:0 | 0.778 |
| CRF 12, slow, animation tune, 4:4:4 | 0.779 |

This isolates the dominant cause as early resolution loss, not CRF. Standard
and master now use CRF 12, both with the existing slow preset and animation
tune. Draft remains CRF 23. Standard/draft retain broadly compatible 4:2:0;
master retains 4:4:4 throughout the screen/card/encoder graph (H.264 High 4:4:4
Predictive, requiring a compatible player). In 4:2:0, chroma is sampled at
960×540 for a 1920×1080 export; in 4:4:4 it is 1920×1080. Luma scores alone do
not measure this coloured-text improvement. A 4:2:0 recording cannot regain
its lost chroma by exporting 4:4:4.

## Capture audit and limit

TakeOne requests up to 7680×4320 from the capture engine and writes the incoming
VP9 track to `screen.webm` without resizing or re-encoding. Recorded metadata
uses the engine's **encoded** width/height, not CSS dimensions. Default recording
is 30 fps at 40,000 kbps; this change does not alter those capture settings.

However, the bundled `@desklink/host` 0.1.0 engine computes portal encoder size
from the portal's **logical** `SelectedSource` size before negotiating PipeWire
buffers (`engine/src/session.rs`, portal branch). Its capture conversion can
therefore downscale physical buffers to logical dimensions on a scaled desktop.
For example, a 3840×2160 display at scale 2 may encode at 1920×1080 even though
PipeWire supplies 3840×2160. Merely requesting an 8K maximum in TakeOne cannot
correct that engine behavior. X11 uses framebuffer dimensions.

DPR-native portal recording is consequently **not confirmed** for scaled
compositors. That requires an upstream capture-engine fix and a real scaled
monitor recording qualification; changing the installed dependency locally
would not ship a reproducible fix. The 4K output proof uses the headless demo
capture and establishes export sharpness independently of this capture limit.

## Gate and evidence

The [output quality gates](quality.md#measurements) own the fixture requirements,
sharpness and flat-card limits, and CI evidence contract. The previous standard
renderer and deliberately blurred decoded output fail the sharpness gate.
Committed fixture pixels contain only the demo board.

Development evidence lives in `tmp/sharpness`: `source.png`, `calibration.json`,
`ablation.json`, `ablation-final.json`, the calibration recordings. Final product evidence is flat under
`tmp/evidence/t1-sharp`, named `takeone-sharpness-*`: native and 400% crops,
contrast-stretched flat patches, failing soft/grainy clips and reports, and
10-second before/after MP4s. The actual MP4 crops score 0.448 before and approximately 1.0 after against their native
reference (the held shot is at an integer source position, unlike the fractional
CI checkpoint). The comparison PNG stacks before above after without scaling
either crop. The MP4 is the real `renderTake` product
surface, with camera motion, stage and fades, rendered at 1920×1080/60 fps.

## Flat-card noise and motion qualification

An initial spline16 candidate produced faint speckle inside uniform white
cards. The source PNG, lossless recording and assembled stage each measured
zero variance on a 160×30 white patch. The raw spline16 warp measured 0.003115
luma variance from fixed-point kernel rounding; encoding amplified this to
0.49247 (range 252–255). Background dithering is confined to the generated
background and is not the cause. Lanczos normalizes kernel coefficients: the
raw patch and actual 10-second encoded export both measure zero variance.
The eight-bit Lanczos trial patch was uniformly 252 after colour conversion;
the final RGB16 export and native patch are both uniformly 255. The independent integer-crop flat gate measures 255 with zero variance
in both tiers. See the [flat-card noise gate](quality.md#measurements) for the
reference-relative variance and mean-drift limits.

The portrait motion comparison uses identical source footage, native cap 1.0,
byte-identical camera paths and the same decoded-edge centroid metric. Fixed
Gaussian blur is applied to both full decoded frames before measuring the
edge, with two filter steps. This tests whether sharper edges alone explain
the raw measurement change.

| Decoded preprocessing | Old sampler / CRF 18 | Lanczos / CRF 16 |
| --- | ---: | ---: |
| None | 0.618060 | 0.634334 |
| Gaussian sigma 0.5 px | 0.554979 | 0.575620 |
| Gaussian sigma 1.0 px | 0.481902 | 0.565225 |

Units are RMS px/frame². The blurred comparison is worse for this candidate;
the existing portrait judder baseline has **not** been relaxed. The initial
spline16 candidate measured 0.474241 at sigma 1.0, but its flat-card noise
failed visual review. A higher-precision spline trial removed that noise but
measured 0.506040 at sigma 1.0. RGB16 Lanczos at CRF 12 resolves both measurements: raw judder 0.581268,
banding 8, and matched sigma-1 judder 0.462027. CRF 16 on the same RGB16
intermediate still measured 0.660603 raw judder (sigma-1 0.453846), so the
production standard encoder uses CRF 12. No filter blend or second dimensional
resample is necessary with this precision/encoding combination.

## Additional source qualification

The 1920×1080 synthetic demo and real recorder take use a 1280×720 proof
export so a max-zoom shot can reach 1:1 source pixels without enlargement.
The normal quality harness independently tests default 1920×1080 exports.
At that default, a 1080p source has no resolution budget for a tighter native
zoom; the whole-screen shot still includes the existing stage margins.

The real recorder fixture was captured through `takeone capture record` on an
isolated Xvfb display (1920×1080, 192 DPI), with Chromium reporting DPR 2 and
960×484 CSS content pixels. The display contains only the demo board and the
browser's automation banner. TakeOne reports scale 1 because X11 exposes no
compositor scale mapping; the app's observed DPR and lab DPI are recorded
separately. This qualifies the real X11 recording/export path on a scale-2
lab surface, **not** the portal/scaled-compositor capture issue above. The
recording retains its original VP9 bytes, encoded dimensions and metadata.

The recorder's core white patch (120×10 at source 450,330) and both encoded
exports have mean 255 and variance 0. An earlier patch near the card's bottom
border measured variance 0.115556 in **both** old and new exports: every row
was uniform (13 rows at 254, two at 253), rather than speckle. The original
contrast-stretched border patches and measurements are retained beside the
core patches so that this pre-existing two-code-value edge shading is visible
in review. Tidewater and synth core white patches also retain variance 0.
