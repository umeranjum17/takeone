# Cost per minute of video (measured + per-provider table)

## Per-provider cost (slice 1)

Token counts are the same request shape for every provider: about **15–16k
input tokens per minute of video, typical**, hard-bounded by the preflight in
`src/make.ts` at 40,000 estimated tokens per take minute
(`DEFAULT_TOKENS_PER_MIN`). The per-minute tokens come from today's measured
Jev take below, plus screen words on by default at up to ~90 tokens a beat and
key moment asked on every beat. Cost per provider is tokens × that provider's
list price:

| Provider | Model (example) | Input price | Typical/min | Ceiling/min | Verified |
|---|---|---|---|---|---|
| Jev | `jev-latest` (default) | $0.042 / Mtok input | ~15,800 tok ≈ $0.00066 | 40,000 tok ≈ $0.0017 | input price from the code const (unverified: no output price published; accounting counts input only) |
| OpenCode Go plan | `opencode-go/muse-spark-1.3-contributor` | $0 marginal (subscription) | ~15,800 tok ≈ $0.00 | 40,000 tok ≈ $0.00 | billing route is the OpenCode Go subscription (`auth: account`) |
| OpenCode Go plan | `opencode-go/deepseek-v4.1-flash` | $0 marginal (subscription) | ~15,800 tok ≈ $0.00 | 40,000 tok ≈ $0.00 | same subscription route |
| OpenCode Go plan | `opencode-go/glm-5.3` (GLM) | $0 marginal (subscription) | ~15,800 tok ≈ $0.00 | 40,000 tok ≈ $0.00 | same subscription route |
| OpenAI API | `gpt-6.1-sol` | $2 / Mtok input, $10 / Mtok output | ~15,800 tok ≈ $0.032 in | 40,000 tok ≈ $0.08 in | **unverified**: example price from the `@byokit/decide` README (2026-09-30); re-check the provider pricing page |
| Local | on-device model | $0 (own hardware) | ~15,800 tok ≈ $0.00 | 40,000 tok ≈ $0.00 | no per-token billing |

Notes:

- "Typical" uses the measured take below plus the screen-words addition; it is
  re-measured with a live run in each slice's proof and corrected here when
  the measurement disagrees.
- The 1.34× estimate-to-billed gap below was measured on Jev only; other
  API-billed providers report their own usage and the estimate is input
  tokens until their output pricing is confirmed.
- A GLM API key outside the Go plan has no confirmed listing at the time of
  writing, so it is not priced above; the Go-plan GLM row is the supported
  GLM route.
- An Anthropic API key is set with `takeone key set --backend anthropic --model
  <model>`; a model is required, and the price has no confirmed listing at the
  time of writing, so the cost shows as unknown rather than a number.
- Responses are cached per request hash, so replanning an unchanged take costs
  nothing on every provider.
- With the planner off the cost is exactly zero tokens on every provider.

## Measured take (Jev)

About **14–15k Jev input tokens, roughly $0.0006, per minute of video**, hard-bounded by the preflight in `src/make.ts`: it refuses any take whose reserved total — planned request tokens plus a 1,200-token re-ask reserve per Jev job after the first — exceeds 40,000 estimated tokens per take minute (`DEFAULT_TOKENS_PER_MIN`), about $0.0017/min at the $0.042/Mtok estimate and about $0.0023/min worst billed given the measured ~1.34× estimate-to-billed gap.

Measured on a real 62.7 s desktop take recorded on Hyprland at 3840×2160 (`scripts/e2e`, see the [staged-scene take](guide.md#end-to-end-take-with-a-staged-scene)). The run used a live Jev key, `--about` set, and no cache:

| Metric | Measured | Per minute of video |
|---|---|---|
| Beats (Jev / local) | 20 (12 / 8) | 19 |
| Jev requests | 15 | 14 |
| Jev input tokens | 14,715 | ~14,100 |
| Jev cost | $0.000618 | ~$0.00059 |
| Largest request | 1,099 tokens | — |
| Failed calls | 0 | 0 |
| `make` wall clock (plan + render, machine at load ~100) | 28–111 s | ~27–106 s |

Three clean live runs of the same take, from successive code states, landed between 14.7k and 15.8k input tokens. The preflight planned 22,000 tokens for this take against its 41.8k cap, so it held. Idle and cut beats are decided locally and cost nothing. Jev's `usage.input_tokens` is summed into `take.json` (`jev.input_tokens`, `jev.usd`).

With `--no-jev` the cost is exactly zero tokens. Responses are cached per request hash (`analysis/jev-cache.jsonl`), so replanning an unchanged take costs nothing.

The cost is bounded by design, not by luck:

- **Beat cap**: at most 30 beats per minute (`MAX_BEATS_PER_MIN` in `src/beats/segment.ts`), so the number of Jev calls never grows with how busy the recording is.
- **Token preflight**: `make` estimates every planned request up front and refuses the whole run (`PreflightRefusal`) when the reserved total exceeds `--max-tokens`, default 40,000 input tokens per take minute (`DEFAULT_TOKENS_PER_MIN` in `src/make.ts`). Each single request is also hard-capped at `REQUEST_TOKEN_CAP` (1,200 estimated tokens) in `src/decide/request.ts`.

Worst case at the defaults: the reserved total (planned tokens plus the 1,200-token re-ask reserve per Jev job after the first) is capped at 40,000 estimated tokens per take minute ≈ $0.0017/min at the listed price, ≈ $0.0023/min worst billed. The measured take above used about half of that. Rendering costs no tokens at any setting.

Back to the [README](../README.md).
