# Score loop: render, judge, improve

`takeone make` can score its own film against a written rubric and re-render until it reaches a target. The loop is opt-in: pass `--target-score` (with or without a number) or `--max-rounds`, and `make` builds the film, judges it, adjusts the build inputs and renders again. Without either flag, `make` behaves exactly as before.

```sh
takeone make <take-id> --target-score 9 --max-rounds 4
```

- `--target-score N` — target on a 10-point scale; default 9. `--target-score` without a number uses 9.
- `--max-rounds M` — hard cap on rounds and model calls; default 4 (integer 1–20).
- The exit code is 3 when the judge could not score a round; the film that was already built is kept. A scored film that stays below target exits 0 with an explicit `BELOW TARGET` line.

## The rubric

The judge scores six items. The weights are parts of 100.

| Item | Weight | What it asks |
|---|---|---|
| Real page size in frame | 20 | The captured page is large enough to read, not a small window on a stage. |
| Visible click and camera push-in | 20 | A viewer can see the click or cursor, and the camera moves in on the interaction. |
| Legible text, nothing cut off | 20 | Drawn text is readable and the render's safe-area check passes. |
| Purposeful pacing | 15 | No dead air and no rushed beat; a short source is not penalised for its length alone. |
| Deterministic re-render | 15 | A second render reproduces the same frames within the stated tolerance. |
| Better than the plain baseline | 10 | Set beside round one's film, the weak items measurably improved. Not scored in round one. |

Round one is the plain baseline. From round two, the judge sees the round-one measurements beside the current ones.

## One round

1. **Build and render.** Round one runs `make` as usual. Later rounds re-render from the saved plan with the adjusted build inputs; they do not re-plan the take.
2. **Measure.** The loop extracts three single frames (a settled page, the click moment, the final shot) and measures the page area share, pointer track, drawn cursor, click emphasis, camera zoom at the click, caption size, beat count, longest actionless span and frame count.
3. **Judge.** One model call through the same BYOKit route the planner uses. The judge receives the written rubric, the measurements and the frame list; when the route reads images, it also receives up to three frames. On a text-only route it scores the measured facts. The judge is a separate pass, and a different route is used when the configured planner offers one; on a single free route it stays a separate pass.
4. **Improve.** Up to two of the weakest weighted items are fixed by changing build inputs: `stage_margin` for page size, `cursor_free` and cursor/ripple settings for the pointer, a manual camera zoom around the click for the push-in, `caption_size` for drawn type, `idle_speed` for pacing, and a single-pass render for determinism. When the take has no pointer track or no drawn text, the loop records the missing capability in `out/score.json` instead of inventing it.
5. **Stop** when the score reaches the target, when a round gains less than 0.2, when there is nothing left to change, or at `--max-rounds`.

## Output

- The film: `out/<id>.mp4`, the best-scoring round.
- The report: `out/score.json` with the per-round score, every item's score and measured note, the actions taken, the frame paths, the model route, the call count, the remaining defects and `limitations`. A limitation is a capability the loop could not add without changing the product, such as a requested push-in that the render still measures at under 1.1x; it is recorded once instead of being attempted again every round.
- Single frames: `out/score/round-N-{page,click,end}.png`.

## Cost and time

- **One judge call per scored round.** A full loop of four rounds makes at most **four judge calls**, and `--max-rounds` is the hard cap. Round one still makes the builder's normal planner calls (none with `--no-ai`); later rounds make none.
- One extra render at round one measures determinism. The loop therefore renders at most `max-rounds + 1` times.
- Frame extraction and measurement use local ffmpeg only. No image or measurement leaves the machine except through the configured judge route.
- Determinism tolerance: at least **99.5%** of decoded frames must be byte-identical on the second render.
