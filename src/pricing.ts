import { TokenCounts } from './types';

export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

// USD per million tokens; cache-write = 1.25x input, cache-read = 0.1x input
const PRICING: Record<string, ModelPricing> = {
  'claude-fable-5': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1.0 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

const DEFAULT_PRICING: ModelPricing = PRICING['claude-sonnet-4-6'];

export function pricingForModel(model: string): ModelPricing {
  if (PRICING[model]) {
    return PRICING[model];
  }
  const prefixMatch = Object.keys(PRICING).find((key) => model.startsWith(key));
  return prefixMatch ? PRICING[prefixMatch] : DEFAULT_PRICING;
}

export function estimateCost(tokens: TokenCounts, model: string): number {
  const p = pricingForModel(model);
  const raw =
    tokens.input * p.input +
    tokens.output * p.output +
    tokens.cacheWrite * p.cacheWrite +
    tokens.cacheRead * p.cacheRead;
  return raw / 1_000_000;
}
