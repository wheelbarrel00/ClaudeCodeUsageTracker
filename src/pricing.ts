import { TokenCounts } from './types';

/** Per-million-token prices, in USD. */
export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

// ---------------------------------------------------------------------------
// PLACEHOLDER STARTER VALUES — verify against current Anthropic pricing before
// you publish. Keep this the single source of truth for cost math so prices are
// trivial to update when models or rates change.
// ---------------------------------------------------------------------------
const PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-5': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-opus-4-1': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

const DEFAULT_PRICING: ModelPricing = PRICING['claude-sonnet-4-5'];

/** Resolve a model id (which may carry date / long-context suffixes) to pricing. */
export function pricingForModel(model: string): ModelPricing {
  if (PRICING[model]) {
    return PRICING[model];
  }
  const prefixMatch = Object.keys(PRICING).find((key) => model.startsWith(key));
  return prefixMatch ? PRICING[prefixMatch] : DEFAULT_PRICING;
}

/** Estimate USD cost for a set of token counts under a given model. */
export function estimateCost(tokens: TokenCounts, model: string): number {
  const p = pricingForModel(model);
  const raw =
    tokens.input * p.input +
    tokens.output * p.output +
    tokens.cacheWrite * p.cacheWrite +
    tokens.cacheRead * p.cacheRead;
  return raw / 1_000_000;
}
