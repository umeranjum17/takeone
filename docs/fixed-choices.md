# Fixed choices

Which choices in TakeOne are still decided by a fixed rule, and why. A choice stays fixed
for one of five limits: **format** (a container, codec or layout the output must obey),
**physics** (motion and legibility the eye needs), **privacy** (what may leave the machine),
**cost** (a token, call or size bound) or **measurement** (a perception threshold, not a
judgement). Anything else is a taste decision. Taste belongs to the planner, so a taste rule
that is still fixed is listed in the second table as open, with what closes it. It is never
hidden among the limits.

Each row names the file and the symbol that sets it, making the inventory traceable to the
implementation.

Reclassified against `main` at v0.5.0, from the 94-row inventory in the AI-first design
(17 Oct 2026). That inventory's own total said 34 fixed rows; counting its rows marked F,
F + M and F + user gives 44. Rows marked "M" or "M + T" there are not limits: the planner
owns them, and the shipped ones need no entry here.

## Fixed because of a limit

| Choice | Where | Limit | Why it cannot be taste |
|---|---|---|---|
| Whether a planner runs at all (`--offline`, no sign-in) | `src/make.ts` · `PlannerUnavailable` | cost | No engine means no call and no spend; the film is recorded as a fallback, never passed off as planned |
| Run-level token ceiling | `src/make.ts` · `DEFAULT_TOKENS_PER_MIN` | cost | A hard spend bound per take minute |
| Planner request size and batching | `src/decide/request.ts` · `CHUNK_TOKEN_CAP` | cost | Bounds one call; the chunk size is `CHUNK_BEATS` |
| Actions described per beat | `src/decide/request.ts` · `ACTIONS_PER_BEAT` | cost | Prompt size |
| Beats the planner is asked about | `src/make.ts` · `byAi` | cost | A beat with one candidate zone has nothing to choose |
| Failed or refused call | `src/decide/planner.ts` · `PlannerUnavailable` | cost | A provider limit stops and asks; it never silently degrades |
| Transport retry | `src/decide/planner.ts` · `retryBaseMs` | cost | One bounded retry on a rate limit |
| Price list behind the cost shown | `src/decide/prices.ts` · `PROVIDER_PRICES` | cost | A provider's published price, not a choice |
| Recorder-protocol planning needs a host-passed credential | `src/capture.ts` · `plannerKeyFd` | privacy | The host owns the credential; the recorder never reads a stored one |
| Health check for the planner | `src/doctor.ts` · `ai-planner` | cost | Reports presence only, never the credential |
| Reading a tightness distribution as one level | `src/decide/mapping.ts` · `medianLevel` | measurement | Interpreting an answer, not choosing one |
| Answer validity (probabilities sum to 1) | `src/decide/mapping.ts` · `CONF_SUM_TOL` | measurement | Validation boundary; an invalid answer falls back |
| Beats per minute | `src/beats/segment.ts` · `MAX_BEATS_PER_MIN` | cost | The bound behind every per-beat price |
| What counts as "the result" of an action | `src/beats/segment.ts` · `RESULT_AFTER_MS` | measurement | A perception threshold |
| When a cut has settled | `src/beats/segment.ts` · `CUT_SETTLE_MS` | measurement | Signal settling |
| Minimum time between shots | `src/camera/defaults.ts` · `min_shot` | physics | A floor below which a move is unreadable; the planner picks shots above it |
| Moves per window | `src/camera/defaults.ts` · `rate_max` | physics | Anti-jitter cap; the planner's importance ranks inside it |
| Arrival timing | `src/camera/defaults.ts` · `anchor_early` | physics | Perceptual timing: the camera lands just before the action |
| Move duration | `src/camera/defaults.ts` · `move_t_min` | physics | How fast a move can be followed |
| Pull-out on a long pan at high zoom | `src/camera/defaults.ts` · `hop_zoom` | physics | Legibility during a fast pan |
| Padding per tightness level | `src/camera/defaults.ts` · `l2_pad` | physics | The geometry behind the planner's tightness answer |
| Widest framed share of the screen | `src/camera/defaults.ts` · `frame_max` | physics | Keeps a tight shot from becoming a full screen |
| Edges never cut words | `src/camera/solver.ts` · `edge` | physics | Legibility guard, also a check on the planner |
| Upscale ceiling | `src/camera/defaults.ts` · `max_upscale` | physics | Sharpness: source pixels are never stretched |
| Which exports may move the camera | `src/render/render.ts` · `portrait` | format | Square and phone exports stay centred, proven per shape |
| Calm-path acceleration and holds | `src/render/framing.ts` · `MIN_HOLD_S` | physics | Motion physics |
| Candidate zones offered | `src/beats/zones.ts` · `MAX_ZONES` | cost | The generator shapes the choices; the cap bounds cost |
| Size, place and delay words | `src/beats/zones.ts` · `tiny` | format | The description vocabulary the planner reads |
| Zones read with OCR | `src/beats/zones.ts` · `OCR_MAX_AREA` | privacy | Only small zones are read, so little screen text leaves |
| OCR word filter | `src/decide/ocr.ts` · `OCR_MIN_CONF` | privacy | A word cap, confidence floor and redaction |
| Redaction of every word | `src/decide/redact.ts` · `redactWord` | privacy | Only plain short words leave the machine |
| Text band layout | `src/render/stage.ts` · `bandRows` | format | Only a 16:9 source exported at 16:9 gets the band |
| Keycap placement | `src/render/overlays.ts` · `clearance` | format | One dock above the text band; skipped rather than covering the subject |
| Keycap glyph set | `src/camera/defaults.ts` · `keycap_style` | format | Follows the recorder's operating system |
| Blur is never removed | `src/camera/types.ts` · `blur` | privacy | The planner may suggest blur; a user's blur always wins |
| Dialog and toast windows | `src/perceive/dialogs.ts` · `dialog` | measurement | Detected from pixels, not an editorial call |
| Cursor idle hide | `src/render/cursor.ts` · `IDLE_FADE` | physics | A resting pointer fades rather than sitting on text |
| Text safe inset | `src/render/safe-area.ts` · `SAFE_INSET` | format | Broadcast title-safe area |
| Motion blur | `src/camera/defaults.ts` · `motion_blur` | physics | A measured default ([motion blur](motion-blur.md)) |
| Output shape for phone footage | `src/cli.ts` · `--aspect` | format | The destination is the user's choice |
| Size, frame rate and encode | `src/render/render.ts` · `crf` | format | Container and codec |
| Export transcodes | `src/cli.ts` · `GIF_MAX_BYTES` | format | GIF, WebM and ProRes limits |
| Length cap and reading time | `src/motion/storyboard.ts` · `MAX_DURATION_S` | format | A film cap and a readability floor |
| Perception thresholds and capture rates | `src/perceive/regions.ts` · `DIFF_THRESHOLD` | measurement | Pixel and input thresholds; capture stays with the recorder |
| Analysis frame rate | `src/perceive/decode.ts` · `ANALYSIS_FPS` | measurement | What perception samples |
| UI-box references per second | `src/perceive/boxes.ts` · `BOX_MAX_PER_FRAME` | cost | Bounds the boxes a frame yields |
| Click and dwell detection | `src/perceive/actions.ts` · `CLICK_RELEASE_MAX_MS` | measurement | Input thresholds |
| Capture bit rate and frame rate | `src/session.ts` · `DEFAULT_BITRATE_KBPS` | format | Capture settings |
| Android capture bit rate | `src/android/video.ts` · `VIDEO_BIT_RATE` | format | Device encoder setting |

## Fixed, and a taste rule: not yet the planner's

These are not limits. Each is a rule a person would call a style choice, kept fixed because
the planner does not own it yet. They are the only open items.

| Rule | Where | Why it is still fixed | What closes it |
|---|---|---|---|
| Screenshot and page films: scene sequence, scene lengths, copy (`See it in motion.`, `Try it today`) and light/dark alternation | `src/motion/cli.ts` · `planStoryboard` | Image planning is off: a planner must not receive an unredacted screenshot, and redaction is not yet shipped (privacy). Pitch films already take structure and copy from the engine | Redaction of screenshots, then screenshot planning (item A64) |
| Take films: title and closing copy | `src/motion/cli.ts` · `planTake` | The film call is not asked for a take's motion wrapper copy | Ask the film call for the wrapper copy |
| Title on screen from 0.35 s to 3.1 s | `src/render/stage.ts` · `Math.min(duration, 3.1)` | A fixed window; the planner picks only the title text, bounded by `TITLE_MAX_S` in `src/decide/film.ts` | Let the film call give the title's seconds, floored by reading time |
| A keycap stays 2.2 s | `src/render/overlays.ts` · `t0 + 2.2` | A fixed hold; the planner chooses which shortcuts show, not for how long | Hold = reading time of the keys, floored, as captions already are |
| Overlay emphasis when the planner abstains | `src/render/overlays.ts` · `shortcutKeys` | Every detected shortcut and click gets the same emphasis, a fixed presentation choice | Let the planner choose overlay emphasis for fallback beats |
| Theme tokens | `src/themes.ts` · `midnight` | The planner chooses only a theme name; colours and typography remain fixed | Let the planner choose the theme tokens |
| Phone frame look | `src/render/render.ts` · `corner_radius: 36` | The frame's corner radius is a fixed presentation choice | Let the planner choose the phone frame treatment |

A click ring's size (`ripple_ms`, `ripple_r` in `src/camera/defaults.ts`) is presentation
physics: which clicks ring is the planner's (`clicks`), the ring's size is not a choice.

Already planner-owned, and so absent from both tables: caption text and seconds (held to
reading time, `src/decide/film.ts`), title text, spotlights, which keycaps and click rings
show, theme, camera style, opening and ending, the closing beat, and the pitch film's
structure and copy.
