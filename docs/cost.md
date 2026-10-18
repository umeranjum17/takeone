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

**Thumbnail rule.** Only when the decider BYOKit builds from the stored
config reads images (its own `supportsImages` capability), and in capture
mode only with screen words opted in: one thumbnail at each asked beat's
action and one at its result when the beat has a result zone, so at most 2 a
beat and 16 a chunk. Each is a JPEG, 512 px on the long side, with every zone
outlined and labelled. Only the zones whose text is read stay sharp; the rest
of the frame is blurred past reading, and inside those zones every word that
would not pass as screen text is blacked out. With `--no-screen-text` the
whole frame is blurred, so the image shows no word the notes would not carry. At the 30-beats-a-minute cap that is at most 60 thumbnails, about
15,300 estimated tokens a minute; the 40,000-token preflight counts them and
still refuses anything above it.

## Per-provider cost (slice 1)

Token counts are the same request shape for every provider: about **15–16k
input tokens per minute of video, typical**, hard-bounded by the preflight in
`src/make.ts` at 40,000 estimated tokens per take minute
(`DEFAULT_TOKENS_PER_MIN`). The per-minute tokens come from today's measured
Jev take below, plus the slice-1 additions (screen words on by default at up
to ~90 tokens a beat, key moment asked on every beat). Cost per provider is
tokens × that provider's list price:

| Provider | Model (example) | Input price | Typical/min | Ceiling/min | Verified |
|---|---|---|---|---|---|
| Jev | `jev-latest` (default) | $0.042 / Mtok input | ~15,800 tok ≈ $0.00066 | 40,000 tok ≈ $0.0017 | input price from the code const (unverified: no output price published; accounting counts input only) |
| OpenCode Go plan | `opencode-go/muse-spark-1.3-contributor` | $0 marginal (subscription) | ~15,800 tok ≈ $0.00 | 40,000 tok ≈ $0.00 | billing route is the OpenCode Go subscription (`auth: account`) |
| OpenCode Go plan | `opencode-go/deepseek-v4.1-flash` | $0 marginal (subscription) | ~15,800 tok ≈ $0.00 | 40,000 tok ≈ $0.00 | same subscription route |
| OpenCode Go plan | `opencode-go/glm-5.3` (GLM) | $0 marginal (subscription) | ~15,800 tok ≈ $0.00 | 40,000 tok ≈ $0.00 | same subscription route |
| OpenAI API | `gpt-6.1-sol` | $2 / Mtok input, $10 / Mtok output | ~15,800 tok ≈ $0.032 in | 40,000 tok ≈ $0.08 in | **unverified**: example price from the `@byokit/decide` README (2026-09-30); re-check the provider pricing page |
| Local | on-device model | $0 (own hardware) | ~15,800 tok ≈ $0.00 | 40,000 tok ≈ $0.00 | no per-token billing |

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
- With `--no-ai` the cost is exactly zero tokens on every provider.

## Measured take (Jev, pre-slice-1 shape)

About **14–15k Jev input tokens, roughly $0.0006, per minute of video**, hard-bounded by the preflight in `src/make.ts`: it refuses any take whose reserved total — planned request tokens plus a 1,200-token re-ask reserve per planner job after the first — exceeds 40,000 estimated tokens per take minute (`DEFAULT_TOKENS_PER_MIN`), about $0.0017/min at the $0.042/Mtok estimate and about $0.0023/min worst billed given the measured ~1.34× estimate-to-billed gap.

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

Worst case at the defaults: the reserved total (planned tokens plus one re-asked chunk since slice 3; a 1,200-token re-ask per beat before it) is capped at 40,000 estimated tokens per take minute ≈ $0.0017/min at the listed Jev price, ≈ $0.0023/min worst billed. The measured take above used about half of that. Rendering costs no tokens at any setting.

Back to the [README](../README.md).
