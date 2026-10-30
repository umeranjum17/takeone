# Cost per minute of video (measured + per-provider table)

## Slice 3: batched chunks (measured offline)

The planner asks up to 8 beats per call under one shared rubric, capped at
4,000 estimated tokens a call (`CHUNK_TOKEN_CAP` in `src/decide/request.ts`;
over the cap, screen words are dropped first, then the chunk splits in half).
Chunks run in order, and the preflight reserves one re-asked chunk (the
largest) instead of a re-ask per beat.

**Measured offline**: these numbers come from the real request bodies the
planner built for the slice-1 demo take (the 43.1 s Tidewater board take,
3840×2160, 10 beats, 7 asked), sent to a fake provider that replays recorded
answers. Tokens are the planner's estimate (body length / 3.5); no provider
billed them. The live check waits for a cheap model route.

These figures predate the film call, which adds one planner request per take, or one per chunk when the take is too long for one request (see [Plan and render](guide.md#plan-and-render)). They are not re-measured here, so the per-call counts above exclude it.

**Film chunking, measured offline (slice 5).** The film request carries one timeline line per beat, and a request over the 4,000-token cap is split into ordered chunks so no beat is dropped. A 99-beat board take (430.8 s) measured here was planned in 2 requests of 88 and 11 beats, 4,941 estimated tokens in total with a title and captions; one 10-beat repeat of the same take measured 1,032. The first request asks the theme, pace, opening and camera style, the last asks the ending, and every request asks the title or captions of its own beats when the planner returns text. A text-less planner's middle chunk asks the film-wide questions too, so its beats are still planned. Every request after the first also carries up to 600 characters (about 170 estimated tokens) of the request before it, so splitting repeats the per-request state and question wording: the 4,941 total is above what the same 99 beats would cost in one request, and the beat count a request holds is not fixed because it depends on the length of each timeline line and on which questions the request asks. No provider billed these estimates.

| Demo take, per minute of video | Before (slice 1, one call per beat) | After (slice 3, text-only model) | After (slice 3, model reads images) |
|---|---|---|---|
| Planner calls | 7 (9.7 a minute) | 1 (1.4 a minute) | 2 (2.8 a minute) |
| Request tokens | 5,163 (7,190 a minute) | 3,688 (5,134 a minute) | 6,419 planner estimate (8,936 a minute), 8 thumbnails included |
| Largest request | 816 | 3,688 | under 4,000 each |
| Preflight reserve | 12,363 | 7,376 | 10,140 |
| Jev ($0.042 / Mtok input) | $0.00030 | $0.00022 | not offered (Jev is text only) |
| OpenCode Go plan | $0 marginal | $0 marginal | not offered (no image capability in BYOKit) |
| OpenAI API ($2 / Mtok input, unverified) | $0.0144 | $0.0103 | about $0.019 (6,543 text tokens a minute in the OpenAI body + 8 thumbnails at 255 tokens) |
| Anthropic API | price unknown | price unknown | price unknown (about 8,700 tokens a minute, thumbnails at about 197 tokens) |

The image token figures are the providers' published size formulas applied to
a 512×288 thumbnail (OpenAI: 85 + 170 per 512 px tile = 255; Anthropic:
width × height / 750 ≈ 197); they are unverified until a live run reports
billed usage. The planner budgets 255 tokens per thumbnail (`IMAGE_TOKENS`).

**Thumbnail budget.** Image-capable planners receive at most two 512 px JPEG
thumbnails per asked beat and 16 per chunk; the privacy treatment is described
in the [planner guide](guide.md#ai-planner-key). At the 30-beats-a-minute cap
that is at most 60 thumbnails, about 15,300 estimated tokens a minute; the
40,000-token preflight counts them and still refuses anything above it.

## Per-provider cost (slice 1 reference)

The following rows describe historical slice-1 request shapes, not current
planner usage. Current measured usage and caps are in [Slice 3](#slice-3-batched-chunks-measured-offline). Cost per provider is tokens × that provider's list price:

| Provider | Model (example) | Input price | Typical/min | Ceiling/min | Verified |
|---|---|---|---|---|---|
| Jev | `jev-latest` (default) | $0.042 / Mtok input | ~15,800 tok ≈ $0.00066 | 40,000 tok ≈ $0.0017 | input price from the code const (unverified: no output price published; accounting counts input only) |
| OpenCode Go plan | `opencode-go/muse-spark-1.3-contributor` | $0 marginal (subscription) | ~15,800 tok ≈ $0.00 | 40,000 tok ≈ $0.00 | billing route is the OpenCode Go subscription (`auth: account`) |
| OpenCode Go plan | `opencode-go/deepseek-v4.1-flash` | $0 marginal (subscription) | ~15,800 tok ≈ $0.00 | 40,000 tok ≈ $0.00 | same subscription route |
| OpenCode Go plan | `opencode-go/glm-5.3` (GLM) | $0 marginal (subscription) | ~15,800 tok ≈ $0.00 | 40,000 tok ≈ $0.00 | same subscription route |
| ChatGPT plan | `openai` account model (kit catalogue `strong`) | $0 marginal (subscription) | ~15,800 tok ≈ $0.00 | 40,000 tok ≈ $0.00 | billing route is the ChatGPT subscription (`auth: account`), not the OpenAI API |
| OpenAI API | `gpt-6.1-sol` | $2 / Mtok input, $10 / Mtok output | ~15,800 tok ≈ $0.032 in | 40,000 tok ≈ $0.08 in | **unverified**: example price from the `@byokit/decide` README (2026-09-30); re-check the provider pricing page; applies to an `auth: apiKey` config only |
| Local | on-device model | $0 (own hardware) | ~15,800 tok ≈ $0.00 | 40,000 tok ≈ $0.00 | no per-token billing |
| pi (the person's installed CLI) | any model that pi can reach, e.g. `deepseek/deepseek-flash` | not reported by pi | 6,409 tok in / 33,741 tok out for a 41.15 s film (≈ 9,344 in tok ≈ 8,599 request tokens a minute) | same preflight cap; the model's own limits apply | live run 2026-10-19: pi reports usage but no price, so `planner.usd` stays `null` and no dollar figure is computed |

Notes:

- "Typical" uses the measured take below plus the slice-1 screen-words
  addition; it is re-measured with a live run in each slice's proof and
  corrected here when the measurement disagrees.
- The 1.34× estimate-to-billed gap below was measured on Jev only; other
  API-billed providers report their own usage and the estimate is input
  tokens until their output pricing is confirmed.
- A GLM API key outside the Go plan has no confirmed listing at the time of
  writing, so it is not priced above; the Go-plan GLM row is the supported
  GLM route.
- An Anthropic API key is set with `takeone key set --backend anthropic --model
  <model>`; a model is required, and the price has no confirmed listing at the
  time of writing, so the cost shows as unknown rather than a number.
- Responses are cached per request hash (`analysis/planner-cache.jsonl`), so
  replanning an unchanged take costs nothing on every provider.
- The pi route cannot be priced by TakeOne: pi reports token usage but not the
  model's price, and the model is whichever one the user's pi is signed in for.
  `take.json` therefore records `planner.input_tokens`/`output_tokens` and
  `planner.usd: null`, and `capture` warns `cost unknown` rather than sending a
  $0. Cost per output minute for this route is unknown by design, not zero.
- Any `auth: account` config (ChatGPT, OpenCode Go, an installed Claude or Codex CLI) is subscription-billed, so its marginal token cost is $0, and so is an OpenCode Go plan key (`auth: apiKey`); the OpenAI API list price applies only to an OpenAI `auth: apiKey` config, which never falls back to subscription billing.

## Historical measured take (Jev, pre-slice-1 shape)

This live-run measurement predates the current chunk planner and is retained as historical context only. Current measured usage and preflight behavior are documented in [Slice 3](#slice-3-batched-chunks-measured-offline).

Measured on a real 62.7 s desktop take recorded on Hyprland at 3840×2160 (`scripts/e2e`, see the [staged-scene take](guide.md#end-to-end-take-with-a-staged-scene)). The run used a live Jev credential, `--goal` set, and no cache:

| Metric | Measured | Per minute of video |
|---|---|---|
| Beats (AI / local) | 20 (12 / 8) | 19 |
| Planner requests | 15 | 14 |
| Planner input tokens | 14,715 | ~14,100 |
| Planner cost | $0.000618 | ~$0.00059 |
| Largest request | 1,099 tokens | — |
| Failed calls | 0 | 0 |
| `make` wall clock (plan + render, machine at load ~100) | 28–111 s | ~27–106 s |

Three clean live runs of the same take, from successive code states, landed between 14.7k and 15.8k input tokens. The preflight planned 22,000 tokens for this take against its 41.8k cap, so it held. Idle and cut beats are decided locally and cost nothing. The planner's `usage.input_tokens` is summed into `take.json` (`planner.input_tokens`, `planner.usd`).

The cost is bounded by design, not by luck:

- **Beat cap**: at most 30 beats per minute (`MAX_BEATS_PER_MIN` in `src/beats/segment.ts`), so the number of planner calls never grows with how busy the recording is.
- **Token preflight**: `make` estimates every planned request up front and refuses the whole run (`PreflightRefusal`) when the reserved total exceeds `--max-tokens`, default 40,000 input tokens per take minute (`DEFAULT_TOKENS_PER_MIN` in `src/make.ts`). Each single request is also hard-capped at `CHUNK_TOKEN_CAP` (4,000 estimated tokens) in `src/decide/request.ts`.

Rendering costs no tokens at any setting.

Back to the [README](../README.md).
