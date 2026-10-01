# Camera motion blur

Camera exposures use a centred half-frame shutter at `motion_blur=1`; lower values shorten the shutter, and `0` keeps the original single-warp path. Only exposures with more than 2 output pixels of stage movement need subframes. Each fast frame uses the minimum sample count meeting a 1.9 px spacing target, reserving room for subpixel expression approximation. Captions are composited after the exposure. Every exposure holds one source image, so adjacent UI changes never mix.

The ffmpeg graph duplicates frames by reference, removes unused samples before warping, and averages each exposure with runtime weights. Samples from earlier exposures receive zero weight. A spare zero-weight history slot avoids the equal-weight running-sum shortcut while intermediate mixing is disabled. The graph remains one chronological stream rather than buffering separate velocity branches.

## Synthetic render measurements

Measured locally on the 44 s fixture from `scripts/synth-take.ts`, planned with `make --no-jev`, at standard quality, 1920×1080, 60 fps and the default slow encoder preset. Timing includes the complete `renderTake` call (camera solve, stage generation, caption measurement and final encoding), excluding source generation and planning. The quality harness had not landed on main, so worktree-local measurement scripts were used.

| Measurement | Result |
| --- | --- |
| Render, blur off | 49.227 s |
| Render, blur on | 97.197 s |
| Render-time ratio | 1.974× |
| Output frames | 1,941 |
| Frames receiving blur | 265 (13.7%) |
| Peak samples per exposure | 22 |
| Maximum adjacent sample spacing, including expression approximation | 1.899 px |
| Estimated warp work versus blur off | 1.726× |
| Frames with SSIM below 0.95 versus blur off | 0 |
| Encode | H.264, 1920×1080, 60/1, limited-range bt709 |

The wall-time ratio depends on machine load and the fraction of fast camera movement; it is not a universal 2× guarantee. A deliberately pan-heavy proof take costs more than the mostly stationary synthetic take.

## Output proof and checks

Proof uses the fictional Tidewater board in `scripts/e2e/scene.html`, captured headlessly at its native 2560×1440 size. The only demo person is Umer. A 10 s proof take moves between task cards and the activity feed, with idle compression disabled. Before/after crops at frame 304 (5.067 s) retain 100% output scale. The paired clip labels blur off/on, and a contact sheet covers the complete output. No desktop or device was captured.

Executable tests check centred exposure timing, pan/zoom/diagonal spacing, strength validation, exact output frame counts, no mixing of alternating source images, identical decoded rerenders, a continuous thin-line streak, and unchanged sharp holds. All 308 tests and typecheck pass.

The first full suite run encountered temporary-storage quota errors. A subsequent worktree-local run had one Unix-socket pathname-length failure; that fixture passes with a shorter temporary directory, and the full 308-test suite then passed. These are environment failures rather than render regressions.
