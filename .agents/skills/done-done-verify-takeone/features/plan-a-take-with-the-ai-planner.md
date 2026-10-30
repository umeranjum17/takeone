# Plan a take with the AI planner

Part of the takeone verification map. Source: `src/decide/planner.ts`, `src/decide/request.ts`, `src/decide/film.ts`, `src/decide/redact.ts`, `src/decide/ocr.ts`, `src/decide/prices.ts`, `src/decide/plan.ts`, `src/secrets.ts`, `src/token.ts`, `src/doctor.ts`, `src/make.ts`. Full recipe: `docs/verification/plan-and-render-take.md` (live planner runs), costs in `docs/cost.md`, discovery order in `docs/guide.md`.

## How to get to it (user POV)

A user with an already signed-in BYOKit plan account, a signed-in Claude or Codex CLI account, or a saved planner key runs `takeone make <id>`, optionally with `--goal "<sentence>"` and `--style "<word>"`. With no engine, make exits 3 before writing analysis or a film and prints one sign-in line. The planner decides the judgement beats and the film's look inside a token preflight (`--max-tokens`, default 40k per take minute); redacted screen words go with it unless `--no-screen-text`. A planner that returns free text also writes the film's title and captions; the Jev default answers choices only, so its film has no planner title or captions (`plannerAnswersText`). Answers cache in `analysis/planner-cache.jsonl`, so a rerun costs nothing until `--replan`.

## Driving it

Harness: Shell (bash), ffmpeg/ffprobe, `fm-mem-gate.sh` for every render. Use the normal HOME so the product finds the user's installed, already signed-in CLI as it is; never copy or read that sign-in. Takes and state stay under a scratch folder.

1. `node bin/takeone.mjs doctor`: the `ai-planner` row names the planner `make` will use (for example `AI planner: found and using signed-in Claude account (default)`). On a fresh take with clean `HOME`, isolated `XDG_CONFIG_HOME` and `TAKEONE_NO_KEYRING=1`, `node bin/takeone.mjs make <copy>` exits 3 with one `takeone needs an AI engine` sign-in line and no analysis or film. Do not copy credential files into the isolated home.
2. Free, no planner call: on a planned copy of the board take from [Plan and render a recorded take](plan-and-render-a-recorded-take.md), `node bin/takeone.mjs make <copy> --max-tokens 1` must exit 2 with a token-cap refusal, and write no `analysis/planner-cache.jsonl` and no new MP4.
3. Billed, only with the user's approval for that run: `node bin/takeone.mjs make <copy> --goal "Creating a task and moving it across a board"`. Exit 0; `take.json` has `planner.mode: "ai"`, the backend and model, `planner.input_tokens` within the preflight and `planner.usd` (null means the price is unknown); `analysis/decisions.jsonl` has `decided_by: "ai"` on the asked beats; with a free-text planner (not Jev) the film's title or captions come from the planner, and each caption stays on screen for the seconds the planner chose (up to 8), floored by its reading time (`film.captions[].d` in `take.json`; the encoded film drops the caption pill at the `captions.ass` end time). A planner that cannot serve stops with exit 3 and the check to run, never a silent rules film.
4. Look at the planned film: a contact sheet of `out/<id>.mp4` and whole frames at the beats the planner pushed in on; the title and captions must be readable and inside the frame.
5. Capture: the doctor row and the clean-home refusal transcript to $DONE_DONE_EVIDENCE_ROOT/takeone-no-ai-fallback-after.txt; for a billed run, one large decoded film frame at a planner-chosen push-in to $DONE_DONE_EVIDENCE_ROOT/takeone-no-ai-fallback-after.png and the engine named in `take.json`. Never use a text screenshot as the visual proof.

The drive changes no repo file: note findings in the run's report.
