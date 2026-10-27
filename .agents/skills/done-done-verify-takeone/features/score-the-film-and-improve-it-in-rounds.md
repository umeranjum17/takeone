# Score the film and let it improve in rounds

Part of the takeone verification map. Source: `bin/takeone.ts`, `src/cli.ts`, `src/score/rubric.ts`, `src/score/loop.ts`, `src/score/judge.ts`, `src/score/measure.ts`, `src/score/improve.ts`, `src/score/run.ts`, `test/score-loop.test.ts`, `docs/score-loop.md`. Full recipe and gotchas: `docs/score-loop.md`.

## How to get to it (user POV)

After recording a take, the user runs `takeone make <id> --target-score 9 [--max-rounds 4]`. The builder renders round one, a judge scores it against the written rubric, the loop changes the weakest build inputs and renders again, and it stops at the target, at a round that gains less than 0.2, when nothing is left to change, or at the round cap. `--no-ai` keeps the builder local; the judge is a separate pass, Claude Haiku through the signed-in Claude CLI subscription by default (`judge.json` overrides it). The final film is the best round in `out/<id>.mp4`, and `out/score.json` carries every round, the measured facts, the actions and the limitations.

## Driving it

Harness: Shell (bash), ffmpeg/ffprobe, and `fm-mem-gate.sh` around every render and ffmpeg command. A take with no pointer track can only prove the recorded-limitation path: use a real recorded take that has pointer samples and a click.

1. The default judge needs the signed-in `claude` CLI (subscription login, never a key); leave `HOME` as is. To prove another route, put `judge.json` in `$XDG_CONFIG_HOME/takeone/`. A route that cannot answer makes the loop exit 3 instead of guessing.
2. Run `node bin/takeone.mjs make <take> --no-ai --target-score 9 --max-rounds 3` (optionally with the theme and `--set` values under test). Exit 0 whether it reaches the target or prints `BELOW TARGET`; exit 3 only when the judge could not score a round.
3. Read `out/score.json`: it must have scored rounds, `modelCalls.total <= maxRounds`, the determinism ratio at or above the tolerance, and `limitations` for any capability the loop could not add without changing the product. Round one must flag the weak items; a later round must show a higher best score and the actions that raised it.
4. Look at whole frames, not the score alone: decode the round-one and best-round click frames. The after frame must show the larger page and the drawn cursor or click that the measurements claim. If the camera push-in is named in `limitations`, the after frame must still show the page and pointer, not a fabricated zoom.
5. Capture to the run folder: `takeone-score-loop-before.png`, `takeone-score-loop-after.png`, `takeone-score-loop-score.json`, the best-round MP4 and the terminal transcript. Probe the MP4 with ffprobe (duration, size, width, height, codec) and hash the frames and film.
6. Stop what you started; the take and its `out/` stay under scratch.

The drive changes no repo file: note findings in the run's report.
