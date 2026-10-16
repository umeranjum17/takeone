# takeone feature map

User-facing features of the takeone CLI, in README order. Each file tells you what the feature is, how a user reaches it, how to drive it with the takeone CLI from a shell, and what observable end state proves it works. Proofs drive these journeys; a proof that only exercises a convenient entry point is incomplete when the map lists others.

| # | Feature | Offline? | File |
|---|---|---|---|
| 1 | Render a demo without recording anything (synth take + `make --no-jev`) | yes | [offline-demo-render.md](offline-demo-render.md) |
| 2 | Plan and render a recorded take (`make`) | planning offline with `--no-jev`; Jev calls cost tokens | [plan-and-render-take.md](plan-and-render-take.md) |
| 3 | Tweak the look and rerender (`render --theme`/`--set`, `--aspect`/`--resolution`/`--format`) | yes — never calls the planner | [rerender-look-tweaks.md](rerender-look-tweaks.md) |
| 4 | Record a take (`record`/`stop`/list; desktop, `--android`, `--ios-sim`) | no — needs capture hardware | [record-a-take.md](record-a-take.md) |
| 5 | Motion films from screens (`motion`) | yes after one shell install | [motion-films.md](motion-films.md) |
| 6 | Drawn vector cursor on a cursor-free take | yes | [vector-cursor.md](vector-cursor.md) |

The done-done visual journey ([operations](operations.md), `scripts/verification/visual-pass.sh`) renders features 1, 3 and 5 in phone, 4:5, desktop and large-font cells, dark and light, and fails on stretched, blank, clipped, off-screen or covered content.

Run from the repository root after `npm ci`, with ffmpeg/ffprobe and the pinned headless shell available. Use task-owned takes/state and the assigned heavy lock; set `TAKEONE_GATE` to the assigned memory gate, and bound CPU affinity to eight allowed CPUs. The scripts run heavy checks serially. Missing tools or model access block proof; they never mean PASS.

- `done-done run checks`: floor guard, typecheck and existing tests.
- `done-done run offline-render`: rebuild, synthetic make, decoded-pixel checks, still, probe and hashes.
- On the baseline: `done-done run visual-reference`. Preserve its run directory and `work/` as the reference; never run another checkout from this worktree.
- On the candidate: `TAKEONE_VISUAL_REF=<reference-directory> done-done verify visual --outcome "All ten visual cells pass pixel and design checks against the approved reference"`. This spending journey parks before execution (`awaiting_approval`, exit 4); follow the approval procedure below. All ten cells and the design step are required. `visual-desktop` is only a two-cell exploratory slice, not acceptance.
- `TAKEONE_VISUAL_REF=<reference-directory> TAKEONE_VISUAL_WORK=<reference-directory>/work done-done run visual-controls`: corrupt the good films; all eight controls must fail with their named defects. For an approved letterboxing-take control, open a done-done run and drive `bash scripts/verification/visual-controls.sh <reference> <opened-evidence-directory> --work <reference-work> --letterbox-take <approved-take>`, then close the run.
- `TAKEONE_VISUAL_PASS=<candidate-directory> TAKEONE_VISUAL_REF=<reference-directory> done-done verify visual-design --outcome "All candidate cropped-screen design comparisons pass against the approved reference"`: rerun the cropped-screen design comparisons on the approved `answerer:opencode` judge route (live-model probe, exit 4 JUDGE UNAVAILABLE with no verdicts counted when no approved model answers). This also parks for spending approval. Failed, unsure or judge-unavailable judgments fail acceptance.

For `visual` and `visual-design`, `done-done run` (including `run --open`) intentionally refuses execution with exit 2 because they declare `spends`. Keep that guard; do not use a custom `run -- <command>` to bypass it. Use the `verify` commands above with the configured judge available; on a detached HEAD, also pass `--claim-id <claim-name>`. Read `done-done status --run <run-id>` and obtain the user's approval for that run's model spending before answering its spend gate:

```sh
# Only after the user approves spending for this run:
# Keep TAKEONE_VISUAL_REF, TAKEONE_VISUAL_PASS (for visual-design),
# TAKEONE_GATE, CPU affinity and the assigned heavy lock in effect when resuming.
done-done respond --run <run-id> --action approve --reason "<who approved this run's spending>"
```

Approval resumes execution, so hold the assigned heavy lock and memory gate for it, not just for the initial parked `verify`. Each new run needs approval again. If spending is not approved, answer `--action skip --reason "<why>"`; nothing runs and the result is failure, not acceptance. Spend approval is not design approval: unavailable models, failed or unsure judgments still block acceptance.

For the feature recipes below, use `done-done run --open <feature-name>`, drive the documented public CLI into that run's evidence folder, then `done-done run --close <run-id>` and `done-done check --outcome "<observable result>" --claim-id <feature-name> <evidence-files>`. Rebuild first and preserve inputs, outputs and hashes. Aspect/format/cut/speed recipes remain in [rerender-look-tweaks.md](rerender-look-tweaks.md); hardware and paid-planner recipes are conditional on explicit authority and prerequisites, not claimed as passed by offline runs.

The sign-off migration card's MP4 and PNG are not tracked in the repo; only their filename, hash and size receipts in `.sign-off/decisions.json` are versioned. They are historical proof only, not acceptance of the current candidate; the card's recorded hashes, sizes and producing commit remain unchanged.

Supporting surface, not mapped separately: `takeone doctor` (read-only environment report), `takeone key set` (BYOKit secret store), and the `takeone capture` verbs (`hello`/`record`/`stop`/`make`) implementing the BYOKit recorder protocol — drive those only when the change touches them.
