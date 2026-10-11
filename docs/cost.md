# Cost per minute of video (measured)

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
