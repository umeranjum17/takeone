// Per-backend input-token prices behind the planner's usage accounting.
// This is cost data, not provider behaviour: code uses it only for accounting, and
// the human-readable source with workings is docs/cost.md.

export interface ProviderPrice {
  /** USD per million input tokens; null when unknown or subscription-billed. */
  inputPerMtok: number | null;
}

/** Keyed by BYOKit decide backend id. The planner default (jev) is the only
 * provider-specific value takeone behaviour depends on; everything else is
 * accounting shown to the user. */
export const PROVIDER_PRICES: Record<string, ProviderPrice> = {
  jev: { inputPerMtok: 0.042 },
  "opencode-go": { inputPerMtok: 0 },
  openai: { inputPerMtok: 2 },
  anthropic: { inputPerMtok: null },
  // pi reports tokens but no price, and the model behind it is the user's own
  // choice: cost stays unknown rather than guessed.
  pi: { inputPerMtok: null },
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
