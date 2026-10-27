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
2. **Measure.** The loop extracts three single frames (a settled page, the click moment, the final shot) and measures the page area share, pointer track, drawn cursor, click emphasis, camera zoom at the click, caption size, beat count, longest actionless span (and where it sits: the opening shot, between two actions, or the closing shot; a resting pointer is not an action), the share of the click's result region in the last frame, and frame count.
3. **Judge.** One model call per scored round, to Claude Haiku through the signed-in Claude CLI's subscription (see "The judge route"). The judge receives the written rubric, the measurements and the frame list, plus up to three frames; it is a separate pass from the builder. When the judge splits an item evenly between two levels, BYOKit abstains with a tie; the loop takes the lower tied level instead of failing the round.
4. **Improve.** Up to two changes for the weakest weighted items, best first, are made to the build inputs. Each change is checked before a round is spent on it, and one that would leave the film as it is falls through to the next-best item: `stage_margin` (straight to 0) for page size, `cursor_free` and cursor/ripple settings for the pointer, shot padding a third wider when less than half of the click's result is in the last frame (so the push-in takes in what the click changed, not the control alone), a manual camera zoom around the click when there is no push-in, `caption_size` for drawn type, faster `idle_speed` and a shorter `idle_keep` for pacing (only when that measurably shortens the longest actionless span), a later `trim_start` when that span is the opening (the take then starts half an establishing hold plus one push-in move before its first action, and keeps at least the 3 s the rubric asks of a film; a hold on the result, or an opening this does not shorten, is recorded as a limitation instead), and a single-pass render for determinism. When the take has no pointer track or no drawn text, the loop records the missing capability in `out/score.json` instead of inventing it.

   The checks, with the least change each must make:

   | Change | Checked by | Kept when |
   |---|---|---|
   | Smaller stage margin | the stage geometry | the page covers at least 1 point more of the frame |
   | Drawn cursor | the measured round | the round drew no cursor and the take has a pointer track |
   | Wider shot padding | solving the camera path with and without it, no render | at least 5 points more of the click's result is in the last frame |
   | Manual zoom at the click | solving the camera path with it, no render | the solved zoom at the click is at least 1.1x |
   | Larger caption type | the take | the take has captions under 34px |
   | Idle squeeze or opening trim | the pacing warp | the longest actionless span is at least 0.1 s shorter |
   | Single-pass render | the render settings | the render ran in more than one segment |

   A change under its bar is recorded in `limitations` as `no change: ...` with the measured numbers, and no round is spent on it.
5. **Stop** when the score reaches the target, when a round gains less than 0.2, when no change is left that measurably changes the film (`no gain left`, stop reason `no-improvement`), or at `--max-rounds`.

## The judge route

- **Default:** Claude Haiku through the installed Claude CLI's own subscription sign-in, the same account route the planner discovers first. The model is the CLI's `haiku` family alias, resolved to the current Haiku at the moment of the call, so no model id is stored in TakeOne. No API key and no extra credits are used; an API-key or cloud-provider Claude login is refused.
- **Own route:** save `judge.json` next to `planner.json` (`~/.config/takeone/judge.json`) in the same shapes `planner.json` takes (for example `{"backend":"pi","bin":"/abs/path/to/pi","model":"<model>"}`). When it exists it replaces the default.
- **Different from the builder:** the default Haiku differs from the planner's default model. If you point the planner and the judge at the same model, the judge is still a separate pass.
- **Unavailable:** if the route cannot serve (no Claude CLI, not signed in, an API-key login, or the call is refused), the loop says `score judge: unavailable - ...` and exits 3 before rendering. A refusal mid-loop stops with `judge-unavailable` and the report; no score is ever invented.

## Output

- The film: `out/<id>.mp4`, the best-scoring round.
- The report: `out/score.json` with the per-round score, every item's score and measured note, the actions taken, the frame paths, the model route, the call count, the remaining defects and `limitations`. A limitation is a capability the loop could not add without changing the product, such as a requested push-in that the render still measures at under 1.1x; it is recorded once instead of being attempted again every round.
- Single frames: `out/score/round-N-{page,click,end}.png`; the end frame is the last one before the fade out.

## Cost and time

- **One judge call per scored round.** A full loop of four rounds makes at most **four judge calls**, and `--max-rounds` is the hard cap. Round one still makes the builder's normal planner calls (none with `--no-ai`); later rounds make none.
- One extra render at round one measures determinism. The loop therefore renders at most `max-rounds + 1` times.
- Frame extraction and measurement use local ffmpeg only. No image or measurement leaves the machine except through the configured judge route.
- Determinism tolerance: at least **99.5%** of decoded frames must be byte-identical on the second render.
