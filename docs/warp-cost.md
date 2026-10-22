# What the camera warp costs, measured on take A

The camera warp (`v360`) is the render's most expensive filter. This page
records what it actually costs, and what a cheaper warp would cost in quality,
because the render profile's first version of these numbers was wrong.

Take A throughout: 43.1 s, 3840x2160 at 60 fps, 2 470 source frames, exported
at 1470x826. Every ffmpeg run went through the host's memory gate, one at a
time, and every number below is a real product render (`takeone render`), not a
filter-graph estimate.

## The frame count: 1.12x the source frames, not 6x

The profile quoted the warp's input as "6 x the source frames (14 820)". That
number is the `fps=360` filter's duplication factor, not the frames that reach
the warp: the shutter tier `select` runs before the warp and drops the
duplicates no exposure needs.

| | frames |
|---|---:|
| source frames | 2 470 |
| frames the fps filter duplicates (`frames x samples`) | 14 820 (6x) |
| frames the tier select keeps | 2 763 |
| **frames that reach the warp** | **2 763 (1.12x the source)** |

`motion-blur.json` reports the same split: 2 357 frames need one shutter
sample, 75 need three, 13 need four, 21 need five and 4 need six. The warp
resamples one frame per sample, so its work is 2 763 resamples, not 14 820.

`test/motion-warp.test.ts` locks this: it counts the frames that really reach
the warp (a frame counter in front of `v360`) and requires that count to equal
the sum of the tier counts, for the full graph and for a render segment.

## The cost: the warp is about two thirds of the render

A scale-and-translate warp (an integer crop plus a scale, instead of `v360`'s
perspective remap) was built and rendered through the product, on the same take
and the same camera path, to price the warp properly.

| Render path | Warp | CPU | Wall | Peak RSS |
|---|---|---:|---:|---:|
| single pass | `v360` (today) | 843.4 CPU-s | 129.6 s | 1 538 MB |
| single pass | crop + scale | 295.1 CPU-s | 48.7 s | 1 409 MB |
| 4 segments | `v360` (today) | 1 167.4 CPU-s | 105.0 s (longest part) | 1 527 MB |
| 4 segments | crop + scale | 527.4 CPU-s | 61.7 s (longest part) | 1 371 MB |

The single-pass render gets 548.3 CPU-s cheaper, 65.0 % of its CPU, at 2.9x the
speed. The segmented path saves 640.0 CPU-s, 54.8 % of its CPU. The camera
solve and its frame decodes cost the same 102.5 CPU-s in both arms.

So the profile's conclusion ("the warp is the cost") holds and its share is
about 65 % of the product's single-pass render, not 18 % and not 70 % of a
6x frame count.

The segmented path costs more total CPU than the single pass in both arms
(1 167 vs 843 CPU-s today): every segment decodes the source from the start
again. Its output is also not frame-identical to the single pass - 2 470 frames
against 2 469, with misplaced frames at 386, 817, 844 and 1 664 (minimum SSIM
0.69 against the single pass) in both arms, so that gap is in the product's
segmented render, not in the warp.

## The quality gate: the cheaper warp does not ship

The gate for replacing the warp was VMAF >= 95 against today's output on the
same take, per-frame SSIM during motion, and a judder re-check at the
transition frames.

| Gate | Measured | Verdict |
|---|---:|---|
| VMAF vs today's output | 84.47 mean, 78.86 min, 95.37 max (2 466 of 2 469 frames below 95) | **fails** |
| per-frame SSIM | 0.98788 mean, 0.9696 min, 0 frames below 0.95 | passes |
| judder RMS at the frame centre | 0.1678 output px (0.2258 left edge, 0.2350 right edge) against a 0.15 bar | **fails** |
| transition frames (named) | #723 (t = 12.05 s) and #1 639 (t = 27.32 s) | - |

The geometry is not the limit: the crop-and-scale map matches `v360`'s map to
0.46 source px (horizontal) and 0.35 source px (vertical) RMS, and an
identical-chain control measures VMAF 97.43 / SSIM 1.0000 on the same
harness. What fails is the resampling: `v360` samples the stage with Lanczos
straight into export pixels, while a crop plus a scale resamples twice
(minification, then magnification) and lands at 84.5 VMAF.

So the warp is expensive and the cost is real, but this replacement cannot
carry the quality bar, and the numbers are reported rather than tuned. The
remaining lever is the resampling itself, not the transform: the same profile
measured a 1.5x proxy warp of `v360` at VMAF 93.2, also under the bar.

## Evidence

- The measured per-frame scores, the CPU logs, the camera graphs and the
  side-by-side clip (today's warp left, crop and scale right, 16.0-19.0 s of
  take A) live with the task that produced them, in the task workspace under
  `data/t1-subframe-warp/evidence/product/` (outside this repository).
- The regression that locks the frame count is
  `test/motion-warp.test.ts`.
