# Plan a take with the AI planner

Part of the takeone verification map. Source: `src/decide/planner.ts`, `src/decide/request.ts`, `src/decide/film.ts`, `src/decide/redact.ts`, `src/decide/ocr.ts`, `src/decide/prices.ts`, `src/decide/plan.ts`, `src/secrets.ts`, `src/token.ts`, `src/doctor.ts`, `src/make.ts`. Full recipe: `docs/verification/plan-and-render-take.md` (live planner runs), costs in `docs/cost.md`, discovery order in `docs/guide.md`.

## How to get to it (user POV)

A user with a stored planner key (`takeone key set --backend <name>`), a picked account in `planner.json`, or a signed-in Claude or Codex CLI account runs `takeone make <id>` without `--no-ai`, optionally with `--goal "<sentence>"` and `--style "<word>"`. The planner decides the judgement beats and the film's look, title and captions inside a token preflight (`--max-tokens`, default 40k per take minute); redacted screen words go with it unless `--no-screen-text`. Answers cache in `analysis/planner-cache.jsonl`, so a rerun costs nothing until `--replan`.

## Driving it

Harness: Shell (bash), ffmpeg/ffprobe, `fm-mem-gate.sh` for every render. Use the normal HOME so the product finds the user's installed, already signed-in CLI as it is; never copy or read that sign-in. Takes and state stay under a scratch folder.

1. `node bin/takeone.mjs doctor`: the `ai-planner` row names the planner `make` will use (for example `AI planner: found and using signed-in Claude account (default)`).
2. Free, no planner call: on a planned copy of the board take from [Plan and render a recorded take](plan-and-render-a-recorded-take.md), `node bin/takeone.mjs make <copy> --max-tokens 1` must exit 2 with `planned N tokens exceeds the cap of 1 (--max-tokens); use --no-ai or raise the cap`, and write no `analysis/planner-cache.jsonl` and no new MP4.
3. Billed, only with the user's approval for that run: `node bin/takeone.mjs make <copy> --goal "Creating a task and moving it across a board"`. Exit 0; `take.json` has `planner.mode: "ai"`, the backend and model, `planner.input_tokens` within the preflight and `planner.usd` (null means the price is unknown); `analysis/decisions.jsonl` has `decided_by: "ai"` on the asked beats; the film's title or captions come from the planner. A planner that cannot serve stops with exit 3 and the check to run, never a silent rules film.
4. Look at the planned film: a contact sheet of `out/<id>.mp4` and whole frames at the beats the planner pushed in on; the title and captions must be readable and inside the frame.
5. Capture: the doctor row and the refusal transcript to $DONE_DONE_EVIDENCE_ROOT/takeone-planner-after.txt; for a billed run, a still at a planner-chosen push-in to $DONE_DONE_EVIDENCE_ROOT/takeone-planner-after.png and `take.json` to $DONE_DONE_EVIDENCE_ROOT/takeone-planner-after.json.

The drive changes no repo file: note findings in the run's report.
