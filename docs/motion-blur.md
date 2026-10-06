# Camera motion blur

Camera exposures use a centred half-frame shutter at `motion_blur=1`; lower values shorten the shutter, and `0` keeps the original single-warp path. Exposures with more than 2 output pixels of total path movement use subframes. The planner chooses the minimum count from that path length, then increases it as needed to keep adjacent samples at or below 2 px. Captions are composited after the exposure. Every exposure holds one source image, so adjacent UI changes never mix.

The ffmpeg graph duplicates frames by reference, removes unused samples before warping, and averages each exposure with runtime weights. Samples from earlier exposures receive zero weight. A spare zero-weight history slot avoids the equal-weight running-sum shortcut while intermediate mixing is disabled. The graph remains one chronological stream rather than buffering separate velocity branches.

## Synthetic render measurements

Provenance: every figure below was measured on 2026-10-06 at commit `e451778` on the 44 s fixture from `scripts/synth-take.ts`, planned with `make --no-jev`, at standard quality, 1920×1080, 60 fps and the default slow encoder preset. Timing is the complete `renderTake` wall clock (camera solve, stage generation, caption measurement and final encoding), excluding source generation and planning. The blur counts, peak samples, spacing and warp-work figures are the `motion-blur.json` metrics the render itself writes, and the SSIM row uses the `compare()` path from `scripts/quality.ts`; no ad-hoc estimator. Since PR #45 capped `max_upscale` at 1.0, this same-resolution fixture holds the full stage, so no exposure exceeds the 2 px shutter span and the blur graph reduces to the single-warp path. No sentence outside this table depends on these numbers, and none of them is restated or re-derived elsewhere in this repository.

| Measurement | Result |
| --- | --- |
| Render, blur off | 50.079 s |
| Render, blur on | 74.845 s |
| Render-time ratio | 1.495× |
| Output frames | 1,878 |
| Frames receiving blur | 0 (0.0%) |
| Peak samples per exposure | 1 |
| Maximum adjacent sample spacing, including expression approximation | 0 px (every exposure is a single sample) |
| Estimated warp work versus blur off | 1× |
| Frames with SSIM below 0.95 versus blur off | 0 (minimum SSIM 1.0: decoded outputs identical) |
| Encode | H.264, 1920×1080, 60/1, limited-range bt709 |

The wall-time ratio depends on machine load and the fraction of fast camera movement; it is not a universal guarantee. On this fully stationary take the blur-off and blur-on graphs are identical, so the measured ratio is load alone. A deliberately pan-heavy proof take costs more than the stationary synthetic take.

## Output proof and checks

Proof uses the fictional Tidewater board in `scripts/e2e/scene.html`, captured headlessly at its native 2560×1440 size. The only demo person is Umer. A 10 s proof take moves between task cards and the activity feed, with idle compression disabled. Before/after crops at frame 304 (5.067 s) retain 100% output scale. The paired clip labels blur off/on, and a contact sheet covers the complete output. No desktop or device was captured.

Executable tests check centred exposure timing, pan/zoom/diagonal spacing, strength validation, exact output frame counts, no mixing of alternating source images, identical decoded rerenders, a continuous thin-line streak, and unchanged sharp holds.

The first full suite run encountered temporary-storage quota errors. A subsequent worktree-local run had one Unix-socket pathname-length failure; that fixture passes with a shorter temporary directory, and the full 308-test suite then passed. These are environment failures rather than render regressions.
