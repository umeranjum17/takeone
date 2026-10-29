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
This inventory lists known fixed values by file and class; it is not proven exhaustive.

Reclassified against `main` at v0.5.0, this code-level inventory is grouped by implementation
rule; one design decision may correspond to multiple implementation rules here.

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
| What counts as "the result" of an action | `src/beats/segment.ts` · `RESULT_MIN_AREA`, `RESULT_PART_AREA`, `RESULT_AFTER_MS` | measurement | Fixed region-size and timing thresholds associate visible results with an action |
| When a cut has settled | `src/beats/segment.ts` · `CUT_SETTLE_FRAC`, `CUT_SETTLE_MS` | measurement | Fixed signal-settling thresholds |
| Minimum time between shots | `src/camera/defaults.ts` · `min_shot` | physics | A floor below which a move is unreadable; the planner picks shots above it |
| Moves per window | `src/camera/defaults.ts` · `rate_max` | physics | Anti-jitter cap; the planner's importance ranks inside it |
| Arrival timing | `src/camera/defaults.ts` · `anchor_early` | physics | Perceptual timing: the camera lands just before the action |
| Move duration | `src/camera/defaults.ts` · `move_t_min` | physics | How fast a move can be followed |
| Pull-out on a long pan at high zoom | `src/camera/defaults.ts` · `hop_zoom` | physics | Legibility during a fast pan |
| Padding per tightness level | `src/camera/defaults.ts` · `l2_pad` | physics | The geometry behind the planner's tightness answer |
| Edges never cut words | `src/camera/solver.ts` · `edge` | physics | Legibility guard, also a check on the planner |
| Upscale ceiling | `src/camera/defaults.ts` · `max_upscale` | physics | Sharpness: source pixels are never stretched |
| Which exports may move the camera | `src/render/render.ts` · `portrait` | format | Square and phone exports stay centred, proven per shape |
| Calm-path acceleration and holds | `src/render/framing.ts` · `ZOOM_V`, `ZOOM_A`, `PAN_A`, `SETTLE`, `MIN_HOLD_S`, `MOVE_MAX_S` | physics | Acceleration, settling and hold floors keep camera motion followable |
| Camera framing clearance and text thresholds | `src/render/framing.ts` · `INK_STEP`, `LANDMARK_INK`, `GUARD`, `GAP`, `SAMPLES`, `TEXT_SPAN`, `TEXT_INK` | physics | Sampled edges, landmark density and clearance protect visible text and subjects |
| Candidate zones offered | `src/beats/zones.ts` · `MAX_ZONES` | cost | The generator shapes the choices; the cap bounds cost |
| Zones read with OCR | `src/beats/zones.ts` · `OCR_MAX_AREA` | privacy | Only small zones are read, so little screen text leaves |
| OCR word filter | `src/decide/ocr.ts` · `OCR_MIN_CONF` | privacy | A word cap, confidence floor and redaction |
| Redaction of every word | `src/decide/redact.ts` · `redactWord` | privacy | Only plain short words leave the machine |
| Text band layout | `src/render/stage.ts` · `bandRows` | format | Only a 16:9 source exported at 16:9 gets the band |
| Keycap placement | `src/render/overlays.ts` · `clearance` | physics | One dock above the text band; skipped rather than covering the subject |
| Blur is never removed | `src/camera/types.ts` · `blur` | privacy | The planner may suggest blur; a user's blur always wins |
| Dialog and toast windows | `src/perceive/dialogs.ts` · `dialog` | measurement | Detected from pixels, not an editorial call |
| Cursor movement detection | `src/render/cursor.ts` · `MOVE_EPS` | measurement | A 1.5 source-pixel threshold over 0.2 s filters smoothed pointer jitter from actual movement |
| Text safe inset | `src/render/safe-area.ts` · `SAFE_INSET`; `src/motion/film.ts` · `ask` | format | Output text and generated segments stay inside the title-safe area |
| Motion blur | `src/camera/defaults.ts` · `motion_blur`; `src/render/motion-blur.ts` · `READ_MARGIN` | physics | A measured default and enough neighboring pixels for the blur sample window ([motion blur](motion-blur.md)) |
| Output shape for phone footage | `src/cli.ts` · `--aspect`; `src/motion/cli.ts` · `ASPECTS` | format | The destination is the user's choice and output dimensions match the selected shape |
| Output container, codec and frame rate | `src/render/render.ts` · `-r`; `src/motion/render.ts` · `encoder` | format | Encoded outputs use supported containers, codecs and frame rates |
| Export transcodes | `src/cli.ts` · `--format` | format | Supported output formats are GIF, WebM and ProRes |
| GIF output size ceiling | `src/cli.ts` · `GIF_MAX_BYTES` | cost | Caps GIF output at the 15 MiB social upload limit |
| Motion storyboard duration cap | `src/motion/storyboard.ts` · `MAX_DURATION_S` | cost | Caps rendered frames and output length at 120 s |
| Reading-time floor | `src/motion/storyboard.ts` · `readingFloor` | physics | Keeps generated text on screen long enough to read |
| Change-region detection thresholds | `src/perceive/regions.ts` · `DIFF_THRESHOLD`, `POINTER_MASK`, `DILATE`, `MIN_COMPONENT`, `CUT_FRAC` | measurement | Fixed pixel-change, pointer-mask, component-size and cut thresholds define detected changes |
| Beat grouping thresholds | `src/beats/segment.ts` · `BEAT_GAP_MS`, `BEAT_SPREAD_FRAC`, `IDLE_GAP_MS`, `MERGE_SHORT_MS` | measurement | Fixed timing and distance thresholds group and merge actions into beats |
| Candidate-zone geometry and filtering thresholds | `src/beats/zones.ts` · `ACT_PAD_LOGICAL`, `DEDUPE_IOU`, `RES_IOU_MAX`, `SMALL_REGION_AREA`, `ACT_REGION_MS`, `PANEL_MAX_AREA`, `WIN_MAX_COVER` | measurement | Fixed geometry and overlap thresholds determine candidate zones from measured actions and regions |
| Motion and audio measurements | `src/motion/gates.ts` · `FROZEN_SAMPLE_FPS`, `FROZEN_YDIF`, `TRUE_PEAK_MAX_DBTP`, `LOUDNESS_BAND_LUFS` | measurement | Detects frozen frames and verifies encoded audio peak and loudness |
| Analysis and render sampling thresholds | `src/perceive/decode.ts` · `ANALYSIS_FPS`; `src/render/render.ts` · `DECODE_WINDOW`, `DECODE_WINDOWS`; `src/render/camera-filter.ts` · `PREFILTER_SIGMA`; `src/motion/hyperframes.ts` · `CHIP_FPS`, `TEXT_RUNS`, `STROKE_STEP`, `BLANK_LUMA_RANGE` | measurement | Fixed sample rates and pixel thresholds measure perceived changes, text overlap and blank frames; sigma 0.7 reduces measured motion-edge wobble from 0.47 RMS to 0.11–0.13 under minification |
| UI-box references per second | `src/perceive/boxes.ts` · `BOX_MAX_PER_FRAME` | cost | Bounds the boxes a frame yields |
| Action recognition thresholds | `src/perceive/actions.ts` · `CLICK_RELEASE_MAX_MS`, `CLICK_RELEASE_MAX_PX`, `DOUBLE_MS`, `DOUBLE_MAX_PX`, `SCROLL_GAP_MS`, `TYPE_GAP_MS`, `DWELL_MIN_MS`, `DWELL_MAX_PX`, `TRAVEL_WINDOW_MS`, `TRAVEL_FRAC` | measurement | Fixed timing and movement thresholds classify clicks, double-clicks, scrolls, typing, dwell and travel |
| Synthesized click tick count | `src/render/sound.ts` · `MAX_TICKS` | cost | Bounds audio filter branches for dense click tracks |
| Pinned render engines | `src/motion/hyperframes.ts` · `HYPERFRAMES_VERSION`, `HYPERFRAMES_SHELL_VERSION`, `HYPERFRAMES_SHELL_SHA256`; `src/motion/shell.ts` · `SHELL_VERSION`, `SHELL_ARCHIVE_SHA256`, `SHELL_SHA256` | measurement | Exact engine versions are checksum-verified and held to the deterministic-render gate |

## Fixed, and a taste rule: not yet the planner's

These are not limits. Each is a rule a person would call a style choice, kept fixed because
the planner does not own it yet. The list is grouped by source file and class. Any new fixed
value must be classified here or in the limits table when it is introduced.

| Rule | Source file and symbol | Class | Why it is still fixed | What closes it |
|---|---|---|---|
| Default and multi-screen screenshot/page/URL films: scene sequence, scene lengths, fallback copy (`See it in motion.`, `Try it today`), alternating color and recap composition | `src/motion/cli.ts` · `planStoryboard` | taste | This local path remains rule-based; the separate editorial and bento screenshot recipes already send redacted OCR text, not images, to the planner | Let the planner choose sequence, timing and fallback copy for this local path |
| Take films: title and closing copy | `src/motion/cli.ts` · `planTake` | taste | The film call is not asked for a take's motion wrapper copy | Ask the film call for the wrapper copy |
| Local CLI patterns and named recipes (`launch`, `feature`, `social`, `compare`): fixed sequences, scene durations, default copy and color alternation | `src/motion/cli.ts` · `RECIPES`, `planStoryboard`; `src/motion/types.ts` · `PATTERNS` | taste | The local planner chooses a fixed recipe and timing; missing title, CTA or logo uses fixed copy such as `TakeOne` | Let the planner choose the pattern sequence, timing and fallback copy |
| Zone description wording and position labels | `src/beats/zones.ts` · `SIZE_WORDS`, `sizeWords`, `whereWords`, `delayWords` | taste | The planner receives fixed wording for region size, position and delay; these labels are copy, not a format requirement | Let the planner choose concise descriptions for candidate zones |
| Maximum camera framing width and panel growth | `src/camera/defaults.ts` · `frame_max`; `src/render/framing.ts` · `PANEL_GROW` | taste | The maximum shot width and panel expansion ratio fix how much surrounding space remains in a composition | Let the planner choose framing room around each subject |
| Editorial and bento recipe composition, screen framing and scene timing | `src/motion/editorial.ts` · `editorialStoryboard`, `PHONE_SCREEN_W`, `LENS_TEXT`, `LENS_W`, `grid`; `src/motion/bento.ts` · `bentoStoryboard`, `REEL_S` | taste | The engine supplies words and screen choices from redacted OCR, while scene order, phone/lens layout, patterns, duration floors, the 12 s reel cap and optional music volume stay fixed | Let the planner choose composition, scene order, duration within the output limit, and audio mix |
| Generated intro, callout and outro segment duration | `src/motion/film.ts` · `SEGMENT_S` | taste | Each model-written segment is fixed at 3 s, regardless of its brief | Let the film call set each segment's duration within reading limits |
| Per-pattern text reveal timing and choreography | `src/motion/storyboard.ts` · `sceneRevealDuration` | taste | Each pattern uses a fixed reveal cadence before the reading floor is applied | Let the planner choose reveal timing for each scene |
| Storyboard fallback copy and logo | `src/motion/storyboard.ts` · `sceneTexts`, `scene` | taste | Incomplete fragment fields use fixed interface copy such as `Create task` and `Design preview`; end-card and logo-sting scenes default a missing logo to `TakeOne` | Require the planner to provide copy and logo, or let it choose the fallback wording |
| Title on screen from 0.35 s to 3.1 s | `src/render/stage.ts` · `Math.min(duration, 3.1)` | taste | A fixed window; the planner picks only the title text, bounded by `TITLE_MAX_S` in `src/decide/film.ts` | Let the film call give the title's seconds, floored by reading time |
| Missing caption duration defaults to 3 s | `src/render/stage.ts` · `takeCaptions` | taste | A caption with no positive finite duration gets a fixed hold | Require the film call to provide duration or derive it from reading time |
| A keycap stays 2.2 s | `src/render/overlays.ts` · `t0 + 2.2` | taste | A fixed hold; the planner chooses which shortcuts show, not for how long | Hold = reading time of the keys, floored, as captions already are |
| Overlay emphasis when the planner abstains | `src/render/overlays.ts` · `shortcutKeys` | taste | Every detected shortcut and click gets the same emphasis, a fixed presentation choice | Let the planner choose overlay emphasis for fallback beats |
| Click ring duration and radius | `src/camera/defaults.ts` · `ripple_ms`, `ripple_r` | taste | The defaults set the ring's duration and maximum radius; clipping prevents overflow but does not require these values | Let the planner choose timing and radius within frame bounds |
| Caption, overlay and clip-label visual treatment | `src/render/stage.ts` · `captionAss`; `src/render/overlays.ts` · `keycapAss`, `keycapMotion`; `src/render/cursor.ts` · `ART`, `REST_H`, `PIN_S`, `LOOP_S`; `src/motion/hyperframes.ts` · `videoLayers`, `SPOTS` | taste | Caption fades, keycap colors, shape and spring, pointer artwork and transitions, and clip-label styling and placement order are fixed presentation choices | Let the planner choose caption, overlay and clip-label styling and timing |
| Cursor idle fade timing | `src/render/cursor.ts` · `IDLE_FADE` | taste | The duration of the pointer's fade after stillness is a visual treatment choice | Let the planner choose whether and how quickly the pointer fades |
| Default keycap style | `src/camera/defaults.ts` · `keycap_style` | taste | The fixed default is `linux`; users can override it with `--set`, but the default glyph treatment remains an editorial choice | Let the planner select the default style while honoring explicit user overrides |
| Frozen-frame tolerance | `src/motion/gates.ts` · `FROZEN_LONGEST_S`, `FROZEN_PER_30S`, `FROZEN_TOTAL_MIN_FILM_S` | taste | The tolerated amount of stillness is a motion-style quality bar rather than a format or perception limit | Let the planner vary stillness tolerance by film style |
| Encoder quality settings | `src/render/render.ts` · `encodingOptions`; `src/motion/render.ts` · `MOTION_CRF`; `src/motion/hyperframes.ts` · `-crf 10` | taste | CRF controls the quality/file-size tradeoff; no fixed output-size or render-time budget requires these values | Let the user or planner choose quality, or set a concrete size/time budget |
| Capture frame rate and bitrate defaults | `src/session.ts` · `DEFAULT_FPS`, `DEFAULT_BITRATE_KBPS`; `src/android/video.ts` · `MAX_FPS`, `VIDEO_BIT_RATE` | taste | Capture rates set smoothness and the quality/data-size tradeoff; no fixed capture-size budget requires these values | Let the user or planner choose capture quality and rate, or set a concrete size budget |
| Synthesized click tick tone | `src/render/sound.ts` · `addSound` | taste | The click uses a fixed 1800 Hz, 40 ms tone and fixed level | Let the planner choose the click sound |
| Theme tokens and motion-only fonts | `src/themes.ts` · `midnight`; `src/motion/theme.ts` · `SYMBOL_FONT`, `RULE_FONT` | taste | The planner chooses only a theme name; colors and motion typography remain fixed | Let the planner choose theme tokens and fonts |
| Phone frame look | `src/render/render.ts` · `corner_radius: 36`, `PHONE_BAND_FLOOR` | taste | The frame's corner radius and minimum source-width fit are fixed presentation choices | Let the planner choose the phone frame treatment |
| Fade in and out at the film boundaries | `src/render/render.ts` · `fade`; `src/camera/defaults.ts` · `fade_s` | taste | The export applies a fixed default fade duration | Let the planner choose boundary fade timing |

Already planner-owned: caption wording and valid supplied seconds (bounded by reading
time, `src/decide/film.ts`), spotlights, which keycaps and click rings show, theme name,
camera choices, and the wording and visual content generated for editorial, bento and
film segments. Their fixed composition and timing are listed above.
