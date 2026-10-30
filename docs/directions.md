# Directions, pick and polish

One take, two or three distinct cuts, one pick, then an independent judge refines the picked cut round by round until it
scores 9/10. This is first-draft's directions-then-polish loop (first-draft PR 105, `polish chosen.html`) applied to a
demo film: the same rules for feedback, rejection and stopping, with the film's own builder and rubric.

```sh
takeone directions <take> [--count 2|3] [--goal "<sentence>"] [--board .sign-off/decisions.json]
takeone pick <take> b                       # or no letter: read the owner's pick from the board
takeone pick <take> r2                      # ship round 2 of the latest polish run instead
takeone polish <take> [--max-rounds 5] [--feedback "hold the result longer"] [--board .sign-off/decisions.json]
takeone polish-feedback <take> "make the click easier to see"   # while a polish run is going
```

## Directions

- The take is planned once (beats, camera decisions, captions) and every direction renders that same plan; no
  direction re-plans the beats.
- A direction is a **look** (one of the [themes](look.md)), a **pacing** (brisk, quick, steady or calm: the hold
  multiplier, how fast idle footage plays (at most 5x) and the opening hold) and a **camera motion** (follows the action, holds each
  framing, or pushes in closer and quicker). Each is a theme plus a handful of `--set` pairs.
- One planner call proposes the directions. Rules keep them distinct: no two share a theme, and no two share both
  pacing and motion. A repeat takes the next most probable theme the planner gave, and a field the planner abstained on
  takes the fixed table's value (midnight/quick/follow, paper/calm/hold, aurora/brisk/close); `directions.json` marks
  every field as the planner's (`ai`) or a rule's (`rule`).
- There is no `--no-ai` mode: every option is judged, and `directions` and `polish` refuse the flag.
- Each direction is a real render: `directions/<a|b|c>.mp4`. The first is rendered twice to measure determinism.
- The judge scores each cut once (the [score loop's rubric](score-loop.md#the-rubric), without the baseline item) and
  the highest score is recommended. The report is `directions/directions.json`.
- The planner and judge routes are checked before anything is planned or rendered. A run that fails puts the earlier
  pick back on the take.

## Pick

`takeone pick <take> <a|b|c>` saves the direction on `take.json` (`direction`: id, name, theme and its pairs) and copies
its cut to `out/<id>.mp4`. From then on `render` and `make` keep that look and pacing the way they keep a typed `--theme`
and `--set`: the film call never replaces them. With no letter, pick reads the owner's answer from the board card.

`takeone pick <take> r<N>` ships round N of the latest polish run (its film to `out/`, its settings to the take) when the
owner prefers it to the round the loop chose. With no letter, an answer on the latest polish card is read first, then the
directions card.

## Polish

The loop follows first-draft's polish:

- **Round 0 is the picked cut**, rendered again (that second render is the determinism check against the picked one)
  and judged. Refinements are rounds 1 to `--max-rounds` (default and most: 5).
- A refinement starts from the **seed**, the latest accepted round. The score loop's measured changes run first (each
  checked before a render is spent on it), then one builder call (the planner route) picks changes from a fixed set of
  knobs: pacing, zoom closeness, move speed, opening hold, ending (including ending sooner), cursor size, click
  emphasis, page size, caption size and motion blur, each with "keep". It never touches the theme or the camera motion.
  It reads the owner's feedback (cumulative, with priority, never undone), the judge's gaps, and the seed's score against
  the 9/10 target with every rubric item under it.
- **The judge** answers the rubric and every piece of owner feedback (met or not, with a reason) in one call. Items
  under 9 come back with a reason; those are the next round's gaps.
- **A round is rejected** when it misses any feedback or leaves the picked look; the next round builds on the last
  accepted one.
- **Stops** at 9/10 with every piece of feedback met and none arriving during the round (`target_reached`), after two
  rounds whose accepted score is not higher than the round before (`no_improvement_two_rounds`), at the cap
  (`round_cap`), or when no build input is left to change (`no_change_left`). A judge failure records the round and
  stops the run (`error`); no score is invented.
- **Ships** the best-scored accepted round (the latest on a tie): `out/<id>.mp4`, and `take.json`'s direction gets that
  round's pairs and `polished`. A page ships its latest accepted round in first-draft; a film ships its best one. Below
  9 the run says `BELOW TARGET` with the score. A run that fails part way still ships its best accepted round.
- Idle footage never plays faster than 5x in a round: the score loop's "squeeze idle footage" change is skipped past it.
  On the 43 s 4K proof take the camera solve took 192-220 s at 4x and 5x and ran for over an hour at 6x.
- `--set` pairs are part of round 0's settings; refinements build on them and may change them like any other setting.
  A later polish run starts from the round the last one shipped, and its round 0 is checked against that round's film.
- Everything is kept in `polish/<run>/`: `run.json`, `round-N.mp4`, `round-N.json` (score, items, gaps, feedback
  checks, changes, settings), the judged frames, and `feedback/`.

`polish-feedback` adds a note to the running polish; the next round reads it. A round judged while a note arrived cannot
end the run.

## The judge is independent

The judge is the [score judge route](score-loop.md#the-judge-route) (Claude Haiku on the signed-in Claude CLI by
default, or `judge.json`). Directions and polish refuse to run when the judge is the same backend and model as the
planner that proposes directions and builds rounds.

## On the sign-off board

With `--board <decisions.json>` (or `TAKEONE_BOARD`), every option and every round goes to a
[sign-off](https://github.com/umeranjum17/sign-off) board as a design pick:

- `directions` posts one card, one option per direction. Each option's page plays the cut in place (phone and desktop,
  no full-screen takeover on iPhone) beside its score, rubric and why it was chosen; the board opens it full screen.
- `polish` posts a card from round 1 on, one option per round so far (at most six), the best or final round
  recommended, with each round's score, rubric, feedback checks and changes. The previous round's card moves to the
  board's archive as replaced.
- A note the owner leaves on a card (when picking, or on a round's card, including the last card of the previous polish
  run) becomes polish feedback. A note over 2,000 characters keeps its first 2,000.
- Without `--board`, a re-run of `directions` and every `polish` post to the board the directions went to.
- A card goes up under the first key the board does not hold yet, so a take captured again under the same name never
  collides with an archived card.
- The board serves a file beside a page up to 5 MB, so each cut goes up as an H.264 board copy that steps down in size
  (1280 px first) until it fits, with a poster still. The page was designed with first-draft.
- `TAKEONE_SIGN_OFF` names the sign-off CLI (default `sign-off-axi`).

## Cost

Per take, whatever its length, for the directions and polish steps themselves:

| Step | Model calls | Renders |
| --- | --- | --- |
| directions (3) | 1 planner call, 3 judge calls | 4 (one per direction, one determinism re-render) |
| polish | 1 judge call per round, 1 builder call per refinement | 1 per round |
| polish at its cap (5 refinements) | 6 judge calls, 5 builder calls | 6 |

A judge answer served from `analysis/judge-cache.jsonl` is not counted as a call.

The judge never sees the whole film. Each judged round extracts **three single frames** (the page at rest, the first
click, the final shot) and measures the film locally with ffmpeg; on an image-capable judge route those three frames
go to the judge blurred past reading. The default route (Claude CLI) is text-only and judges the measured facts from the
same three frames. So a judge call's size does not grow with the film's length: the frames are three whatever the
length, and only the planner's timeline (capped at 40 lines in the directions call) grows with the number of beats.
Model calls are capped per take, and the cap is enforced. One count belongs to the take: `calls` in `take.json`
(`cap`, `used`, `by_workflow`). Every phase opens that count (`CallBudget` in `src/decide/budget.ts`) and draws it down:
`make`'s film and beat planning, the directions ask, the judge, the score loop and the motion recipes and gauntlet. A
phase run inside another (directions planning an unplanned take, score making then judging) shares the one object; a
phase run by a later command starts from the saved count. Nothing restarts it, so a retry, a re-ask of a chunk,
prerequisite planning and a second command are each counted once, in one place (`askChunk`, immediately before a
request is sent). A judge or planner answer served from a cache sends nothing and spends nothing.

The cap is 150 calls over a take's whole life (`MAX_CALLS_PER_TAKE`). It is sized from a measured run, not chosen: planning
a 400 s take at the planner's densest, 30 beats a minute, is 54 requests (4 film, 50 beat), so planning it twice
(`--replan`) is 108, and the 42 left cover what else a take does: directions (1 planner call and 3 judge calls, plus
retries), up to 4 score rounds, and a motion recipe or gauntlet. A take that plans in more than the 150 less what it has
spent is refused by `make` before it sends anything. The next request past the cap is never sent: the run stops with
`the <workflow> workflow hit the cap of 150 model calls per take after 150 calls`, naming `film planner`, `beat planner`,
`directions planner`, `judge` or a `motion` workflow. The count is written on every spend, so a stopped run still shows
what it spent. A take's directions need one planner call and three judge calls for a three-way pick; on a take not
planned yet (or with `--replan`) `directions` first runs `make`'s planning (see [cost](cost.md)), which spends from the
same count. There is no per-take override: raising the cap is a change to the constant.
Measured on a real 43 s take: see [the proof run](#measured).

## Measured

A real Tidewater board take (`scripts/headless-scene.mjs`: 4K, 43 s, 2,585 frames), captured fresh and driven end to
end in one sealed done-done run on a shared, heavily loaded machine:

| Step | Result | Model calls | Renders | Wall time |
| --- | --- | --- | --- | --- |
| directions (3) | A Midnight/quick/follow 6.2, B Sand/calm/hold 5.8, C Aurora/brisk/close 5.8; A recommended; A re-rendered with 2,469/2,469 frames identical | 1 planner, 3 judge | 4 | 49 min |
| pick on the board | A, with the note "Keep the cursor easy to follow through every click." | 0 | 0 | - |
| polish round 0 | 6.2; the note not met (no cursor drawn) | 1 judge | 1 | |
| polish round 1 | 8.4, accepted; the note met; drew the cursor, enlarged the page, ended the film sooner (outro 1.6 s to 1.0 s) | 1 judge, 1 builder | 1 | 20 min for both rounds |

The run stopped after round 1: one refinement was the scope allowed for this proof, so it ships 8.4/10, **below the
9/10 target**, and does not show the plateau or round-cap stops on a real take (the tests cover them). Seven model calls
for a 43 s take; each judge call carries three frames' measured facts whatever the length. Board copies were 0.6-1.2 MB
at 1280 px. An earlier run on a capture of the same scene, before the builder saw the score and the items under target, stopped at
8.4 with `no_change_left` after the builder kept every knob.
