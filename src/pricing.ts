import { TokenCounts } from './types';

export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

// USD per million tokens. Order matters: a longer id must precede any shorter id it contains.
const PRICING: Record<string, ModelPricing> = {
  // Cache reads are 0.1x input except Fable/Mythos 5.1 (0.025x) and Opus/Sonnet 5.5 (0.05x).
  'claude-fable-5-1': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1.0 },
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

const LONG_PROMPT_PRICING: Record<string, { above: number; pricing: ModelPricing }> = {
  'claude-haiku-5-5': { above: 100_000, pricing: { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 } },
};

const DEFAULT_PRICING: ModelPricing = PRICING['claude-sonnet-4-6'];

const CACHE_WRITE_1H_MULTIPLIER = 2;

export interface ModelFamilyInfo {
  label: string;
  pricingId: string;
  cheaperLabel?: string;
  cheaperId?: string;
}

// Order is match precedence; cheaperId is the current model one tier down.
const FAMILIES: { keywords: string[]; info: ModelFamilyInfo }[] = [
  {
    keywords: ['fable', 'mythos'],
    info: { label: 'Fable', pricingId: 'claude-fable-5', cheaperLabel: 'Sonnet', cheaperId: 'claude-sonnet-5-5' },
  },
  {
    keywords: ['opus'],
    info: { label: 'Opus', pricingId: 'claude-opus-4-8', cheaperLabel: 'Sonnet', cheaperId: 'claude-sonnet-5-5' },
  },
  {
    // Unlisted Sonnet ids are pre-5.x, so they price at $3/$15, not 5.x's $2/$10.
    keywords: ['sonnet'],
    info: { label: 'Sonnet', pricingId: 'claude-sonnet-4-6', cheaperLabel: 'Haiku', cheaperId: 'claude-haiku-5-5' },
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

const LARGE_CONTEXT_MODELS = [
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-5-5',
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

export function cheaperTier(model: string): string | undefined {
  return familyOf(model)?.cheaperLabel;
}

// Fast mode scales cache rates by the same factor; the published figures cover input/output only.
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

export function promptTokens(tokens: TokenCounts): number {
  return tokens.input + tokens.cacheWrite + tokens.cacheRead;
}

export function pricingForModel(model: string, speed?: string, prompt = 0): ModelPricing {
  // A Bedrock prefix (anthropic./us.anthropic.) or a suffix ([1m], -fast) still contains the base id.
  const key = PRICING[model] ? model : Object.keys(PRICING).find((k) => model.includes(k));
  if (key) {
    const long = LONG_PROMPT_PRICING[key];
    return atSpeed(long && prompt > long.above ? long.pricing : PRICING[key], speed);
  }
  const family = familyOf(model);
  if (family) {
    return atSpeed(PRICING[family.pricingId], speed);
  }
  return atSpeed(DEFAULT_PRICING, speed);
}

export function cacheWriteRaw(tokens: TokenCounts, p: ModelPricing): number {
  const oneHour = Math.min(Math.max(tokens.cacheWrite1h, 0), tokens.cacheWrite);
  const fiveMin = tokens.cacheWrite - oneHour;
  return fiveMin * p.cacheWrite + oneHour * (CACHE_WRITE_1H_MULTIPLIER * p.input);
}

export function estimateCost(tokens: TokenCounts, model: string, speed?: string): number {
  const p = pricingForModel(model, speed, promptTokens(tokens));
  const raw =
    tokens.input * p.input +
    tokens.output * p.output +
    cacheWriteRaw(tokens, p) +
    tokens.cacheRead * p.cacheRead;
  return raw / 1_000_000;
}
