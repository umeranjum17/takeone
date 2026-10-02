# t1-pm-4 historical output evidence and validation handoff

The real Tidewater take and Acme fixture were rendered from reviewed candidate
`8f8cf08903046cf9fb258dc4eb84dfb70b3fb27e`, git tree
`b4daccbb8e8a609ac7a6b733728de99eedf8c4d2`, based on main
`684fb6c4f6b1216c5b2aab1f5ebfc35a16569bf3`. The output-source digest and
render configurations are recorded in [candidate-output-report.txt](candidate-output-report.txt)
so later evidence-only commits can be compared without claiming they rendered
themselves.

## Historical output from renderer 8f8cf089

- [Tidewater candidate MP4](tidewater-candidate-after.mp4)
- [Tidewater drag strip](tidewater-candidate-strip.png), sampled 15.5–19 s at
  0.5 s intervals, including lead-in and post-drop frames.
- [Acme candidate after-half sheet](acme-candidate-after-half-sheet.png), 1 fps
  for output times 16–32 s.
- [Acme candidate MP4](acme-candidate-after.mp4)
- [Acme 16–30 s frame check](acme-detail-visibility.json): 841 frames, zero
  cursor misses, zero retention-thumb misses.
- [Per-beat before/after results](candidate-beat-results.txt)
- [Rendered source provenance and hashes](candidate-output-report.txt)

For renderer `8f8cf089`, the Tidewater strip was visually inspected at full resolution. The dragged
card remains visible while crossing the board, at release, and after drop. Its
recorded drag spans 16.65–18.583333 s; all 117 drag frames keep both the card
footprint and cursor inside the candidate camera crop. The recorded main-`684fb6c4`
comparison has zero acted-on region regressions across all ten beats.

For renderer `8f8cf089`, the Acme sheet shows the retention slider from before its dialog opens through
the drag and drop. The rendered-crop check uses the candidate camera frames
after `stageFrames`, maps each output frame back through the output time warp,
and checks both cursor and thumb footprints on every frame from 16 through 30
s. All 841 frames pass.

All linked media, camera paths, visibility records, and beat tables above are
historical evidence bound to renderer `8f8cf089`, not the rebased candidate.
The original README and receipts are preserved byte-for-byte in
[previous-8f8-receipts](previous-8f8-receipts/). The renderer-`87d4717` evidence
remains in [previous-87d-render](previous-87d-render/). The root-level
`acme-after-half-sheet.png`, `acme-after.mp4`, `acme-before.mp4`,
`tidewater-real-after.mp4`, `tidewater-real-strip.png`, `output-report.txt`, and
`beat-results.txt` are also historical and retain their original bindings.

## Rebased candidate: validation pending

At review starting HEAD `d2fe04c4933ef5e55302d7beeb61d3dff86b05b2`, the recorded
digest command produces
`75c8b3e25b2dd105e9676bfd5579537f7cd6fafebd1309d24df8b8fbadbcec6a`, not the
historical renderer digest
`090109f3eeaa7d54a7dd233b94343ca7536ccc8ceffc8919f6fc11cc3e7debe3`.
Output-affecting changes include caption-band composition, `max_upscale`
1.5 to 1.0, and standard encoding CRF 18 to 12. Historical PASS results do not
establish acceptance for this candidate. No fresh render or output inspection
was performed in this review phase.

The outer executor's assigned validation phase must regenerate and inspect all
five scenarios through the current public CLI, then publish source-bound
results. Automated tests and historical media do not substitute for this work.

| Required scenario | Current-candidate status |
| --- | --- |
| Fresh Acme render: retention thumb and cursor visible on every frame 16–30 s | Pending |
| Fresh before/after comparison: every beat retains each acted-on region whenever the before crop did | Pending |
| Fresh real Tidewater render: whole dragged card and cursor visible for the full drag through release/drop | Pending |
| Fresh Acme after-half sheet: 1 fps, output times 16–32 s, visually inspected | Pending |
| Actual framing CLI: nonzero trim-relative camera times aligned to output-clock beats, and no-match beat rejected with expected exit status | Pending |

## Validation phase handoff

Preserve every historical artifact and receipt. Write fresh outputs and their
reports to a separate worktree-local directory, and add links here only after
inspection. Retain the original full-drag whole-element, slider, and
no-regression criteria; keep stored numerical quality limits at least as strict
as both accepted histories.

The retained real input is
`/home/umer/.treehouse/takeone-9abf5c/11/takeone/tmp/real/screen.webm`, with
SHA-256 `bfe7d750c092c13db9db04781d927b7f5d711e7b2a91b10be0d825dfe497cfc7`.
Copy it into the worktree with the committed `tidewater-plan/` bundle; keep the
real Umer/Tidewater recording and plans. The Acme fixture producer is
`scripts/synth-take.ts`; retain the committed `acme-plan/` for historical
comparison. If a retained input is inaccessible, record the exact refusal and
leave its scenario pending; do not substitute a synthetic real take.

Build the current CLI within the worktree, then use `node bin/takeone.mjs render
<worktree-local-tidewater-dir>` and `node bin/takeone.mjs make <acme-id> --no-jev
--set fps=60 --set "caption_font=Liberation Sans"`. Set `TAKEONE_DIR` to a
worktree-local directory for `make`. Do not invoke new Jev calls. Serialize each
heavy build, render, test, or ffmpeg command and all its children under the
existing shared lock
`/home/umer/.treehouse/firstmate-8bf1b0/1/firstmate/state/takeone-heavy.lock`;
keep AXI control calls outside the lock.

Use freshly produced camera paths and output-clock beats with
`node scripts/check-framing.ts <beats.json> <trim-start-seconds>
<before-camera.json> <after-camera.json>`. Include a nonzero-trim run and a
no-match run with its captured exit status. The fresh frame-visibility checks
must account for the current rendered composition, including the caption band,
and inspect the actual MP4s, sheet, and strip.

Record exact source commit/tree, the output-source digest command from the
historical report, dependency lock, runtime, CLI commands and configurations,
input/plan/output hashes, per-frame and per-beat results, and visual inspection
conclusions from those fresh results. Refresh `SHA256SUMS` after publication.
Its current entries cover the preserved package and corrected documentation,
not proof that the rebased renderer has passed.
