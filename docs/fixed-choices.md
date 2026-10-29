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

Reclassified against `main` at v0.5.0. This code-level inventory has 51 limit-bound rules
and 15 open taste rules (66 choices total). It is not a one-to-one recount of the 94-row
AI-first design inventory (17 Oct 2026), which reported 34 fixed decisions; individual
design decisions may correspond to multiple implementation rules here.

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
| Calm-path acceleration and holds | `src/render/framing.ts` · `ZOOM_V`, `ZOOM_A`, `PAN_A`, `SETTLE`, `MIN_HOLD_S`, `MOVE_MAX_S` | physics | Acceleration, settling and hold floors keep camera motion followable |
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
| Text safe inset | `src/render/safe-area.ts` · `SAFE_INSET`; `src/motion/film.ts` · `ask` | format | Output text and generated segments stay inside the title-safe area |
| Motion blur | `src/camera/defaults.ts` · `motion_blur` | physics | A measured default ([motion blur](motion-blur.md)) |
| Output shape for phone footage | `src/cli.ts` · `--aspect` | format | The destination is the user's choice |
| Size, frame rate and encode | `src/render/render.ts` · `crf`; `src/motion/render.ts` · `MOTION_CRF` | format | Container and codec |
| Export transcodes | `src/cli.ts` · `GIF_MAX_BYTES` | format | GIF, WebM and ProRes limits |
| Length cap and reading time | `src/motion/storyboard.ts` · `MAX_DURATION_S` | format | A film cap and a readability floor |
| Perception thresholds and capture rates | `src/perceive/regions.ts` · `DIFF_THRESHOLD` | measurement | Pixel and input thresholds; capture stays with the recorder |
| Motion and audio quality gates | `src/motion/gates.ts` · `FROZEN_SAMPLE_FPS`, `FROZEN_YDIF`, `FROZEN_LONGEST_S`, `FROZEN_PER_30S`, `FROZEN_TOTAL_MIN_FILM_S`, `TRUE_PEAK_MAX_DBTP`, `LOUDNESS_BAND_LUFS` | measurement | Frozen-picture and loudness thresholds are checked on the rendered output |
| Analysis frame rate | `src/perceive/decode.ts` · `ANALYSIS_FPS` | measurement | What perception samples |
| UI-box references per second | `src/perceive/boxes.ts` · `BOX_MAX_PER_FRAME` | cost | Bounds the boxes a frame yields |
| Click and dwell detection | `src/perceive/actions.ts` · `CLICK_RELEASE_MAX_MS` | measurement | Input thresholds |
| Synthesized click tick count | `src/render/sound.ts` · `MAX_TICKS` | cost | Bounds audio filter branches for dense click tracks |
| Capture bit rate and frame rate | `src/session.ts` · `DEFAULT_BITRATE_KBPS` | format | Capture settings |
| Android capture bit rate | `src/android/video.ts` · `VIDEO_BIT_RATE` | format | Device encoder setting |

## Fixed, and a taste rule: not yet the planner's

These are not limits. Each is a rule a person would call a style choice, kept fixed because
the planner does not own it yet. They are the only 15 open items.

| Rule | Where | Why it is still fixed | What closes it |
|---|---|---|---|
| Default and multi-screen screenshot/page/URL films: scene sequence, scene lengths, fallback copy (`See it in motion.`, `Try it today`), alternating color and recap composition | `src/motion/cli.ts` · `planStoryboard` | Image planning is off: a planner must not receive an unredacted screenshot, and redaction is not yet shipped (privacy) | Redaction of screenshots, then screenshot planning (item A64) |
| Take films: title and closing copy | `src/motion/cli.ts` · `planTake` | The film call is not asked for a take's motion wrapper copy | Ask the film call for the wrapper copy |
| Local CLI patterns and named recipes (`launch`, `feature`, `social`, `compare`): fixed sequences, scene durations, default copy and color alternation | `src/motion/cli.ts` · `RECIPES`, `planStoryboard` | The local planner chooses a fixed recipe and timing; missing title, CTA or logo uses fixed copy such as `TakeOne` | Let the planner choose the pattern sequence, timing and fallback copy |
| Editorial and bento recipe composition and scene timing | `src/motion/editorial.ts` · `editorialStoryboard`; `src/motion/bento.ts` · `bentoStoryboard`, `REEL_S` | The engine supplies words and screen choices, while scene order, patterns, duration floors, the 12 s reel cap and optional music volume stay fixed | Let the planner choose the scene order and duration within the output limit, and the audio mix |
| Generated intro, callout and outro segment duration | `src/motion/film.ts` · `SEGMENT_S` | Each model-written segment is fixed at 3 s, regardless of its brief | Let the film call set each segment's duration within reading limits |
| Per-pattern text reveal timing and choreography | `src/motion/storyboard.ts` · `sceneRevealDuration` | Each pattern uses a fixed reveal cadence before the reading floor is applied | Let the planner choose reveal timing for each scene |
| Title on screen from 0.35 s to 3.1 s | `src/render/stage.ts` · `Math.min(duration, 3.1)` | A fixed window; the planner picks only the title text, bounded by `TITLE_MAX_S` in `src/decide/film.ts` | Let the film call give the title's seconds, floored by reading time |
| A keycap stays 2.2 s | `src/render/overlays.ts` · `t0 + 2.2` | A fixed hold; the planner chooses which shortcuts show, not for how long | Hold = reading time of the keys, floored, as captions already are |
| Overlay emphasis when the planner abstains | `src/render/overlays.ts` · `shortcutKeys` | Every detected shortcut and click gets the same emphasis, a fixed presentation choice | Let the planner choose overlay emphasis for fallback beats |
| Caption, overlay and clip-label visual treatment | `src/render/stage.ts` · `captionAss`; `src/render/overlays.ts` · `keycapAss`, `keycapMotion`; `src/render/cursor.ts` · `ART`, `REST_H`, `PIN_S`, `LOOP_S`; `src/motion/hyperframes.ts` · `videoLayers` | Caption fades, keycap colors, shape and spring, pointer artwork and transitions, and clip-label styling are fixed presentation choices | Let the planner choose caption, overlay and clip-label styling and timing |
| Synthesized click tick tone | `src/render/sound.ts` · `addSound` | The click uses a fixed 1800 Hz, 40 ms tone and fixed level | Let the planner choose the click sound |
| Theme tokens and motion-only fonts | `src/themes.ts` · `midnight`; `src/motion/theme.ts` · `SYMBOL_FONT`, `RULE_FONT` | The planner chooses only a theme name; colors and motion typography remain fixed | Let the planner choose theme tokens and fonts |
| Phone frame look | `src/render/render.ts` · `corner_radius: 36` | The frame's corner radius is a fixed presentation choice | Let the planner choose the phone frame treatment |
| Missing caption duration defaults to 3 s | `src/render/stage.ts` · `takeCaptions` | A caption with no positive finite duration gets a fixed hold | Require the film call to provide duration or derive it from reading time |
| Fade in and out at the film boundaries | `src/render/render.ts` · `fade`; `src/camera/defaults.ts` · `fade_s` | The export applies a fixed default fade duration | Let the planner choose boundary fade timing |

A click ring's size (`ripple_ms`, `ripple_r` in `src/camera/defaults.ts`) is presentation
physics: which clicks ring is the planner's (`clicks`), the ring's size is not a choice.

Already planner-owned: caption wording and valid supplied seconds (bounded by reading
time, `src/decide/film.ts`), spotlights, which keycaps and click rings show, theme name,
camera choices, and the wording and visual content generated for editorial, bento and
film segments. Their fixed composition and timing are listed above.
