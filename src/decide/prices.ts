// Per-backend input/output token prices behind the planner's usage accounting.
// This is cost data, not provider behaviour: no code path branches on it, and
// the human-readable source with workings is docs/cost.md. Prices older than 30
// days are marked unverified until re-checked; unverified output prices never
// enter the billed estimate (input tokens only, as before).

export interface ProviderPrice {
  /** USD per million input tokens; null when unknown or subscription-billed. */
  inputPerMtok: number | null;
  /** USD per million output tokens; null when unknown or subscription-billed. */
  outputPerMtok: number | null;
  /** True only when the price was confirmed against the provider's listing. */
  verified: boolean;
  /** Source and date, e.g. "code const, 2026-10-17". */
  asOf: string;
}

/** Keyed by BYOKit decide backend id. The planner default (jev) is the only
 * provider-specific value takeone behaviour depends on; everything else is
 * accounting shown to the user. */
export const PROVIDER_PRICES: Record<string, ProviderPrice> = {
  jev: { inputPerMtok: 0.042, outputPerMtok: null, verified: false, asOf: "code const, 2026-10-17 (unverified: no output price published)" },
  "opencode-go": { inputPerMtok: 0, outputPerMtok: 0, verified: true, asOf: "subscription billing, 2026-10-17 ($0 marginal per call)" },
  openai: { inputPerMtok: 2, outputPerMtok: 10, verified: false, asOf: "@byokit/decide README example gpt-6.1-sol, 2026-09-30 (unverified: re-check the provider pricing page)" },
  anthropic: { inputPerMtok: null, outputPerMtok: null, verified: false, asOf: "unverified: no confirmed listing at 2026-10-17" },
};

/** Input-only cost estimate for planned/reported tokens, matching the
 * long-standing input-only accounting (output pricing is unverified).
 * Undefined when the backend or its input price is unknown: no estimate is
 * never a fabricated $0. */
export function estimateUsd(backend: string, inputTokens: number): number | undefined {
  const price = PROVIDER_PRICES[backend]?.inputPerMtok;
  if (typeof price !== "number" || !Number.isFinite(price)) return undefined;
  return (inputTokens * price) / 1e6;
}
