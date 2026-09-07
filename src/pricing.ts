import { TokenCounts } from './types';

export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

// USD per million tokens; cache-write (5-minute TTL) = 1.25x input, cache-read = 0.1x input.
// The 1-hour cache-write TTL is priced separately at 2x input (see cacheWriteRaw).
// Order matters: pricingForModel falls back to substring containment, so a longer id must sit
// before any shorter id it contains ('claude-fable-5-1' before 'claude-fable-5').
const PRICING: Record<string, ModelPricing> = {
  // Fable 5.1 breaks the 0.1x-input rule above: cache reads are $0.25/MTok, not $1.00.
  'claude-fable-5-1': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1.0 },
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
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

const LARGE_CONTEXT = 1_000_000;
const SMALL_CONTEXT = 200_000;

// 1M arrived with the 4.6 generation; everything older is 200K, as is Haiku. Listing it
// explicitly matters: "not Haiku" as 1M understated ctx% fivefold on every earlier model.
const LARGE_CONTEXT_MODELS = [
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
];

export function contextWindowFor(model: string, tokens = 0): number {
  if (model.includes('[1m]') || LARGE_CONTEXT_MODELS.some((id) => model.includes(id))) {
    return LARGE_CONTEXT;
  }
  // A prompt beyond the small window can only have come from a larger tier.
  return tokens > SMALL_CONTEXT ? LARGE_CONTEXT : SMALL_CONTEXT;
}

export function familyLabel(model: string): string {
  return familyOf(model)?.label ?? model;
}

// The next cheaper tier to suggest, or undefined for a budget/unknown tier (nothing to advise).
export function cheaperTier(model: string): string | undefined {
  return familyOf(model)?.cheaperLabel;
}

// Fast mode runs the same model at premium rates ($10/$50 vs $5/$25), reported as usage.speed.
// Cache rates are scaled by the same factor — the published figures cover input/output only.
const FAST_MODE_MULTIPLIER = 2;

function atSpeed(pricing: ModelPricing, speed: string | undefined): ModelPricing {
  if (speed !== 'fast') {
    return pricing;
  }
  return {
    input: pricing.input * FAST_MODE_MULTIPLIER,
    output: pricing.output * FAST_MODE_MULTIPLIER,
    cacheWrite: pricing.cacheWrite * FAST_MODE_MULTIPLIER,
    cacheRead: pricing.cacheRead * FAST_MODE_MULTIPLIER,
  };
}

export function pricingForModel(model: string, speed?: string): ModelPricing {
  const exact = PRICING[model];
  if (exact) {
    return atSpeed(exact, speed);
  }
  // A Bedrock prefix (anthropic./us.anthropic.) or a suffix ([1m], -fast) still contains the base id.
  const contained = Object.keys(PRICING).find((key) => model.includes(key));
  if (contained) {
    return atSpeed(PRICING[contained], speed);
  }
  // An unlisted/future id is priced by family so it's never silently billed at the mid-tier default.
  const family = familyOf(model);
  if (family) {
    return atSpeed(PRICING[family.pricingId], speed);
  }
  return atSpeed(DEFAULT_PRICING, speed);
}

// Cache-write cost (raw per-million units): the 1-hour-TTL portion bills at 2x input, the rest at 1.25x.
export function cacheWriteRaw(tokens: TokenCounts, p: ModelPricing): number {
  const oneHour = Math.min(Math.max(tokens.cacheWrite1h, 0), tokens.cacheWrite);
  const fiveMin = tokens.cacheWrite - oneHour;
  return fiveMin * p.cacheWrite + oneHour * (CACHE_WRITE_1H_MULTIPLIER * p.input);
}

export function estimateCost(tokens: TokenCounts, model: string, speed?: string): number {
  const p = pricingForModel(model, speed);
  const raw =
    tokens.input * p.input +
    tokens.output * p.output +
    cacheWriteRaw(tokens, p) +
    tokens.cacheRead * p.cacheRead;
  return raw / 1_000_000;
}
