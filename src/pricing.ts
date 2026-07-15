import { TokenCounts } from './types';

export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

// USD per million tokens; cache-write (5-minute TTL) = 1.25x input, cache-read = 0.1x input.
// The 1-hour cache-write TTL is priced separately at 2x input (see cacheWriteRaw).
const PRICING: Record<string, ModelPricing> = {
  'claude-fable-5': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1.0 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  // Sonnet 5 intro pricing ($2/$10) runs through 2026-08-31, then reverts to $3/$15.
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

const DEFAULT_PRICING: ModelPricing = PRICING['claude-sonnet-4-6'];

const CACHE_WRITE_1H_MULTIPLIER = 2;

export interface ModelFamilyInfo {
  label: string; // display name, e.g. 'Opus'
  pricingId: string; // representative id for family-fallback pricing
  cheaperLabel?: string; // next tier down to suggest, absent for budget tiers
  cheaperId?: string; // concrete id to re-price the same tokens against
}

// Single source for a model id's family + the tier below it (advisor, predictor, and pricing
// fallback derive from this). Order = match precedence; cheaperId stays on standard, non-intro pricing.
const FAMILIES: { keywords: string[]; info: ModelFamilyInfo }[] = [
  {
    keywords: ['fable', 'mythos'],
    info: { label: 'Fable', pricingId: 'claude-fable-5', cheaperLabel: 'Sonnet', cheaperId: 'claude-sonnet-4-6' },
  },
  {
    keywords: ['opus'],
    info: { label: 'Opus', pricingId: 'claude-opus-4-8', cheaperLabel: 'Sonnet', cheaperId: 'claude-sonnet-4-6' },
  },
  {
    // Unlisted Sonnet ids (legacy 4.5/4.0, 3.x) price at the STANDARD $3/$15, not Sonnet 5's
    // temporary $2/$10 intro — claude-sonnet-5 is matched exactly above, so only others reach here.
    keywords: ['sonnet'],
    info: { label: 'Sonnet', pricingId: 'claude-sonnet-4-6', cheaperLabel: 'Haiku', cheaperId: 'claude-haiku-4-5' },
  },
  {
    keywords: ['haiku'],
    info: { label: 'Haiku', pricingId: 'claude-haiku-4-5' },
  },
];

export function familyOf(model: string): ModelFamilyInfo | undefined {
  const m = model.toLowerCase();
  return FAMILIES.find((f) => f.keywords.some((keyword) => m.includes(keyword)))?.info;
}

export function familyLabel(model: string): string {
  return familyOf(model)?.label ?? model;
}

// The next cheaper tier to suggest, or undefined for a budget/unknown tier (nothing to advise).
export function cheaperTier(model: string): string | undefined {
  return familyOf(model)?.cheaperLabel;
}

export function pricingForModel(model: string): ModelPricing {
  const exact = PRICING[model];
  if (exact) {
    return exact;
  }
  // A Bedrock prefix (anthropic./us.anthropic.) or a suffix ([1m], -fast) still contains the base id.
  const contained = Object.keys(PRICING).find((key) => model.includes(key));
  if (contained) {
    return PRICING[contained];
  }
  // An unlisted/future id is priced by family so it's never silently billed at the mid-tier default.
  const family = familyOf(model);
  if (family) {
    return PRICING[family.pricingId];
  }
  return DEFAULT_PRICING;
}

// Cache-write cost (raw per-million units): the 1-hour-TTL portion bills at 2x input, the rest at 1.25x.
export function cacheWriteRaw(tokens: TokenCounts, p: ModelPricing): number {
  const oneHour = Math.min(Math.max(tokens.cacheWrite1h, 0), tokens.cacheWrite);
  const fiveMin = tokens.cacheWrite - oneHour;
  return fiveMin * p.cacheWrite + oneHour * (CACHE_WRITE_1H_MULTIPLIER * p.input);
}

export function estimateCost(tokens: TokenCounts, model: string): number {
  const p = pricingForModel(model);
  const raw =
    tokens.input * p.input +
    tokens.output * p.output +
    cacheWriteRaw(tokens, p) +
    tokens.cacheRead * p.cacheRead;
  return raw / 1_000_000;
}
