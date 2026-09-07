import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_TOKENS, TokenCounts } from './types';
import {
  pricingForModel,
  estimateCost,
  cacheWriteRaw,
  familyOf,
  familyLabel,
  contextWindowFor,
} from './pricing';

function tokens(partial: Partial<TokenCounts>): TokenCounts {
  return { ...EMPTY_TOKENS, ...partial };
}

test('estimateCost prices the 1-hour cache-write TTL at 2x input, not the 5-minute 1.25x', () => {
  // Opus input = $5/MTok -> 5m cache write 6.25, 1h cache write 10.
  // 600k @ 6.25 + 400k @ 10 = 3.75 + 4.00 = 7.75
  const cost = estimateCost(tokens({ cacheWrite: 1_000_000, cacheWrite1h: 400_000 }), 'claude-opus-4-8');
  assert.equal(cost, 7.75);
});

test('estimateCost with no 1-hour portion prices all cache writes at the 5-minute rate', () => {
  const cost = estimateCost(tokens({ cacheWrite: 1_000_000 }), 'claude-opus-4-8');
  assert.equal(cost, 6.25); // 1M @ 6.25, unchanged from before the split
});

test('cacheWriteRaw clamps a 1-hour count that exceeds the total (defensive)', () => {
  const p = pricingForModel('claude-opus-4-8');
  assert.equal(cacheWriteRaw(tokens({ cacheWrite: 100, cacheWrite1h: 500 }), p), 100 * 10);
});

test('pricingForModel returns exact matches, including the newly-added Sonnet 5', () => {
  assert.equal(pricingForModel('claude-opus-4-8').input, 5);
  assert.equal(pricingForModel('claude-sonnet-5').input, 2); // intro pricing; had fallen through to $3
  assert.equal(pricingForModel('claude-haiku-4-5').input, 1);
});

test('pricingForModel matches provider-prefixed and suffixed ids by inclusion', () => {
  assert.equal(pricingForModel('anthropic.claude-opus-4-8').input, 5);
  assert.equal(pricingForModel('us.anthropic.claude-sonnet-5').input, 2);
  assert.equal(pricingForModel('claude-opus-4-8[1m]').input, 5);
});

test('pricingForModel falls back by family for unlisted ids instead of the mid-tier default', () => {
  assert.equal(pricingForModel('claude-opus-4-9').input, 5); // future Opus -> Opus, not the $3 default
  assert.equal(pricingForModel('claude-mythos-5').input, 10); // Mythos -> Fable tier
  assert.equal(pricingForModel('claude-haiku-9').input, 1);
});

test('unlisted Sonnet ids fall back to standard $3/$15, not Sonnet 5 intro pricing', () => {
  // Legacy/other sonnet ids not in the table must not inherit Sonnet 5's temporary
  // $2/$10 — they were really $3/$15, so the family fallback prices them there.
  for (const id of ['claude-sonnet-4-5', 'claude-sonnet-4-0', 'claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022']) {
    assert.equal(pricingForModel(id).input, 3, id);
    assert.equal(pricingForModel(id).output, 15, id);
  }
  // The exact Sonnet 5 id still gets its intro rate.
  assert.equal(pricingForModel('claude-sonnet-5').input, 2);
});

test('pricingForModel uses the mid-tier default only for a genuinely unrecognizable id', () => {
  assert.equal(pricingForModel('some-unknown-model').input, 3); // Sonnet 4.6 default
});

test('familyOf centralizes label, cheaper tier, and re-pricing id per family', () => {
  const opus = familyOf('anthropic.claude-opus-4-9[1m]');
  assert.equal(opus?.label, 'Opus');
  assert.equal(opus?.cheaperLabel, 'Sonnet');
  assert.equal(opus?.cheaperId, 'claude-sonnet-4-6');
  assert.equal(familyOf('claude-mythos-5')?.label, 'Fable');
  assert.equal(familyOf('claude-haiku-4-5')?.cheaperLabel, undefined);
  assert.equal(familyOf('some-unknown-model'), undefined);
});

test('familyLabel falls back to the raw id for unknown models', () => {
  assert.equal(familyLabel('claude-sonnet-5'), 'Sonnet');
  assert.equal(familyLabel('some-unknown-model'), 'some-unknown-model');
});

test('claude-fable-5-1 prices cache reads at its own rate, not Fable 5s', () => {
  assert.equal(pricingForModel('claude-fable-5-1').cacheRead, 0.25);
  assert.equal(pricingForModel('claude-fable-5').cacheRead, 1.0);
  assert.equal(estimateCost(tokens({ cacheRead: 100_000_000 }), 'claude-fable-5-1'), 25);
  assert.equal(estimateCost(tokens({ cacheRead: 100_000_000 }), 'claude-fable-5'), 100);
});

test('a suffixed Fable 5.1 id still resolves to 5.1, not the shorter Fable 5 key', () => {
  assert.equal(pricingForModel('claude-fable-5-1[1m]').cacheRead, 0.25);
  assert.equal(pricingForModel('us.anthropic.claude-fable-5-1').cacheRead, 0.25);
});

test('the context window comes from the model, so ctx% never falls as context grows', () => {
  const pct = (t: number) => (t / contextWindowFor('claude-opus-5', t)) * 100;
  const samples = [150_000, 190_000, 199_999, 200_001, 205_000, 400_000, 899_192];
  const percentages = samples.map(pct);
  for (let i = 1; i < percentages.length; i++) {
    assert.ok(
      percentages[i] >= percentages[i - 1],
      `ctx% fell from ${percentages[i - 1]} to ${percentages[i]}`
    );
  }
  assert.equal(contextWindowFor('claude-opus-5', 190_000), 1_000_000);
});

test('Haiku keeps its 200K window; an unknown model past it cannot report over 100%', () => {
  assert.equal(contextWindowFor('claude-haiku-4-5-20251001', 50_000), 200_000);
  assert.equal(contextWindowFor('some-unreleased-model', 300_000), 1_000_000);
  assert.equal(contextWindowFor('claude-haiku-4-5[1m]', 50_000), 1_000_000);
});

test('pre-4.6 models keep the 200K window', () => {
  for (const model of [
    'claude-sonnet-4-5',
    'claude-sonnet-4-20250514',
    'claude-3-5-sonnet-20241022',
    'claude-opus-4-1-20250805',
    'claude-3-opus-20240229',
  ]) {
    assert.equal(contextWindowFor(model, 190_000), 200_000, model);
  }
});

test('4.6-and-later models carry the 1M window', () => {
  for (const model of [
    'claude-opus-5',
    'claude-opus-4-6',
    'claude-sonnet-5',
    'claude-sonnet-4-6',
    'claude-fable-5-1',
    'us.anthropic.claude-opus-4-8',
  ]) {
    assert.equal(contextWindowFor(model, 190_000), 1_000_000, model);
  }
});

test('fast mode bills at twice the standard rate', () => {
  assert.equal(pricingForModel('claude-opus-5').input, 5);
  assert.equal(pricingForModel('claude-opus-5', 'standard').input, 5);
  assert.equal(pricingForModel('claude-opus-5', 'fast').input, 10);
  assert.equal(pricingForModel('claude-opus-5', 'fast').output, 50);
  assert.equal(estimateCost(tokens({ input: 1_000_000 }), 'claude-opus-5', 'fast'), 10);
  assert.equal(estimateCost(tokens({ input: 1_000_000 }), 'claude-opus-5'), 5);
});

test('fast mode applies through the family and substring fallbacks too', () => {
  assert.equal(pricingForModel('claude-opus-9-future', 'fast').input, 10);
  assert.equal(pricingForModel('us.anthropic.claude-opus-5', 'fast').input, 10);
});

test('fast mode scales the cache rates too, not just input and output', () => {
  const fast = pricingForModel('claude-opus-5', 'fast');
  assert.equal(fast.cacheRead, 1.0);
  assert.equal(fast.cacheWrite, 12.5);
  assert.equal(estimateCost(tokens({ cacheRead: 10_000_000 }), 'claude-opus-5', 'fast'), 10);
  assert.equal(estimateCost(tokens({ cacheRead: 10_000_000 }), 'claude-opus-5'), 5);
});
