# Directions and pick

One take, two or three distinct cuts, one pick. Each cut is a real render of the same planned take, scored by an
independent judge; the pick saves one on the take and copies its film to `out/`.

```sh
takeone directions <take> [--count 2|3] [--goal "<sentence>"] [--style "<word>"] [--replan] [--set key=value] [--board .sign-off/decisions.json]
takeone pick <take> b                       # or no letter: read the owner's pick from the board
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
- There is no `--no-ai` mode: every option is judged, and `directions` refuses the flag.
- Each direction is a real render: `directions/<a|b|c>.mp4`. The first is rendered twice to measure determinism.
- The judge scores each cut once (the [score loop's rubric](score-loop.md#the-rubric), without the baseline item) and
  the highest score is recommended. The report is `directions/directions.json`.
- The planner and judge routes are checked before anything is planned or rendered. A run that fails puts the earlier
  pick back on the take.

## Pick

`takeone pick <take> <a|b|c>` saves the direction on `take.json` (`direction`: id, name, theme and its pairs) and copies
its cut to `out/<id>.mp4`. From then on `render` and `make` keep that look and pacing the way they keep a typed `--theme`
and `--set`: the film call never replaces them. With no letter, pick reads the owner's answer from the board card.

## The judge is independent

The judge is the [score judge route](score-loop.md#the-judge-route) (Claude Haiku on the signed-in Claude CLI by
default, or `judge.json`). Directions refuse to run when the judge is the same backend and model as the planner that
proposes directions.

## On the sign-off board

With `--board <decisions.json>` (or `TAKEONE_BOARD`), every option goes to a
[sign-off](https://github.com/umeranjum17/sign-off) board as a design pick:

- `directions` posts one card, one option per direction. Each option's page plays the cut in place (phone and desktop,
  no full-screen takeover on iPhone) beside its score, rubric and why it was chosen; the board opens it full screen.
- Without `--board`, a re-run of `directions` posts to the board the last directions went to, and the older card goes to
  the board's archive as replaced.
- A card goes up under the first key the board does not hold yet, so a take captured again under the same name never
  collides with an archived card.
- The board serves a file beside a page up to 5 MB, so each cut goes up as an H.264 board copy that steps down in size
  (1280 px first) until it fits, with a poster still. The page was designed with first-draft.
- `TAKEONE_SIGN_OFF` names the sign-off CLI (default `sign-off-axi`).

## Cost

Per take, whatever its length, for the directions step itself:

| Step | Model calls | Renders |
| --- | --- | --- |
| directions (3) | 1 planner call, 3 judge calls | 4 (one per direction, one determinism re-render) |

A judge answer served from `analysis/judge-cache.jsonl` is not counted as a call.

The judge never sees the whole film. Each judged cut extracts **three single frames** (the page at rest, the first
click, the final shot) and measures the film locally with ffmpeg; on an image-capable judge route those three frames
go to the judge blurred past reading. The default route (Claude CLI) is text-only and judges the measured facts from the
same three frames. So a judge call's size does not grow with the film's length: the frames are three whatever the
length, and only the planner's timeline (capped at 40 lines in the directions call) grows with the number of beats.
The directions calls per take are therefore bounded at one planner call and three judge calls, four model calls for a
three-way pick, and their cost per minute of video falls as takes get longer. That ceiling does not count planning
the take: on a take not planned yet (or with `--replan`), `directions` first runs `make`'s planning once (the film call
and the beat calls, which grow with the take and are chunked, see [cost](cost.md)); a take already made adds none.
Bringing that planning under one per-take ceiling is separate follow-up work, not part of this command yet.
