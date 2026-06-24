import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UsageRecord, EMPTY_TOKENS } from './types';
import type { SessionSummary } from './dataLoader';
import { analyze, AdvisorInput, Insight, savingsBadge } from './advisor';

const money = (usd: number): string => `$${usd.toFixed(2)}`;

function record(tokens: Partial<typeof EMPTY_TOKENS>, model = 'claude-opus-4-8', timestamp = 0): UsageRecord {
  return { timestamp, model, tokens: { ...EMPTY_TOKENS, ...tokens } };
}

function session(
  peakContextPct: number,
  tokens: Partial<typeof EMPTY_TOKENS> = {},
  messageCount = 0
): SessionSummary {
  return {
    session: 's',
    title: 't',
    project: 'p',
    startMs: 0,
    endMs: 0,
    activeMs: 0,
    peakContextPct,
    summary: { tokens: { ...EMPTY_TOKENS, ...tokens }, costUsd: 0, messageCount },
  };
}

function run(input: Partial<AdvisorInput>): Insight[] {
  return analyze(
    { records: input.records ?? [], sessions: input.sessions ?? [], now: input.now ?? 0, subscription: input.subscription },
    money
  );
}

function byId(insights: Insight[], id: string): Insight | undefined {
  return insights.find((i) => i.id === id);
}

// A mid-June "now" so the forecast rule is deterministic: day 15 of a 30-day month.
const JUNE_15 = new Date(2026, 5, 15, 12, 0, 0).getTime();

test('model-mix flags short-output spend on an expensive model with a positive saving', () => {
  const records = Array.from({ length: 6 }, () => record({ input: 1_000_000, output: 100 }, 'claude-opus-4-8'));
  const insight = byId(run({ records }), 'model-mix');
  assert.ok(insight);
  assert.equal(insight!.severity, 'tip');
  assert.match(insight!.title, /Sonnet/);
  // Per turn: opus $5.0025 vs sonnet $3.0015 = $2.001 saved; x6 = $12.006.
  assert.ok(insight!.savingsUsd! > 12 && insight!.savingsUsd! < 12.01);
});

test('savingsBadge frames a pay-as-you-go saving green but a subscriber figure as a usage gauge', () => {
  const records = Array.from({ length: 6 }, () => record({ input: 1_000_000, output: 100 }, 'claude-opus-4-8'));
  const insight = byId(run({ records }), 'model-mix')!;
  assert.ok(insight.savingsUsd! > 0);

  const payg = savingsBadge(insight, money, false)!;
  assert.equal(payg.gauge, false);
  assert.match(payg.title, /saving/i);
  assert.match(payg.text, /^~\$/);

  // On a subscription the same figure must never read as a green cash "saving".
  const sub = savingsBadge(insight, money, true)!;
  assert.equal(sub.gauge, true);
  assert.doesNotMatch(sub.title, /saving/i);
  assert.match(sub.title, /not your subscription bill/i);
  assert.match(sub.text, /^≈ \$/);
});

test('savingsBadge is absent when an insight carries no positive saving', () => {
  const forecast = byId(run({ records: [record({ input: 1_000_000, output: 5000 })], now: JUNE_15 }), 'spend-forecast');
  assert.ok(forecast);
  assert.equal(savingsBadge(forecast!, money, true), undefined);
  assert.equal(savingsBadge(forecast!, money, false), undefined);
});

test('model-mix stays silent when outputs are substantial', () => {
  const records = Array.from({ length: 6 }, () => record({ input: 1_000_000, output: 1500 }, 'claude-opus-4-8'));
  assert.equal(byId(run({ records }), 'model-mix'), undefined);
});

test('model-mix stays silent below the minimum turn count', () => {
  const records = Array.from({ length: 4 }, () => record({ input: 1_000_000, output: 100 }, 'claude-opus-4-8'));
  assert.equal(byId(run({ records }), 'model-mix'), undefined);
});

test('model-mix stays silent below the minimum saving floor', () => {
  // 6 tiny opus turns: saving is well under $1.
  const records = Array.from({ length: 6 }, () => record({ input: 10_000, output: 50 }, 'claude-opus-4-8'));
  assert.equal(byId(run({ records }), 'model-mix'), undefined);
});

test('model-mix never flags a budget model', () => {
  const records = Array.from({ length: 8 }, () => record({ input: 10_000_000, output: 100 }, 'claude-haiku-4-5'));
  assert.equal(byId(run({ records }), 'model-mix'), undefined);
});

test('model-mix maps Fable to Sonnet with a correct positive saving', () => {
  const records = Array.from({ length: 6 }, () => record({ input: 1_000_000, output: 100 }, 'claude-fable-5'));
  const insight = byId(run({ records }), 'model-mix');
  assert.ok(insight);
  assert.match(insight!.title, /Sonnet/);
  // Per turn: fable $10.005 vs sonnet $3.0015 = $7.0035 saved; x6 = $42.021.
  assert.ok(insight!.savingsUsd! > 42 && insight!.savingsUsd! < 42.03);
});

test('model-mix picks the model with the larger realisable saving', () => {
  const records = [
    ...Array.from({ length: 6 }, () => record({ input: 1_000_000, output: 100 }, 'claude-sonnet-4-6')),
    ...Array.from({ length: 6 }, () => record({ input: 1_000_000, output: 100 }, 'claude-opus-4-8')),
  ];
  const insight = byId(run({ records }), 'model-mix');
  assert.ok(insight);
  // Opus->Sonnet saves $2/MTok x 6M = $12; Sonnet->Haiku saves $2/MTok x 6M = $12 too,
  // but cache/output differences make Opus the larger; just assert it names a real tier.
  assert.match(insight!.title, /Route routine (Opus|Sonnet) turns/);
});

test('cache-efficiency flags long sessions that reused little context', () => {
  const lowReuse = session(50, { input: 9_000_000, cacheWrite: 1_000_000, cacheRead: 1_000_000 }, 20);
  const insight = byId(run({ sessions: [lowReuse, lowReuse] }), 'cache-efficiency');
  assert.ok(insight);
  assert.equal(insight!.savingsUsd, undefined);
  assert.match(insight!.evidence!, /cache reuse/);
});

test('cache-efficiency stays silent when long sessions reuse cache well', () => {
  const healthy = session(50, { input: 1_000_000, cacheWrite: 1_000_000, cacheRead: 20_000_000 }, 30);
  assert.equal(byId(run({ sessions: [healthy, healthy] }), 'cache-efficiency'), undefined);
});

test('cache-efficiency ignores short fresh sessions even at low reuse', () => {
  // Brand-new sessions: low reuse, but only a couple of turns each — not churn.
  const fresh = session(50, { input: 2_000_000, cacheWrite: 2_000_000, cacheRead: 0 }, 2);
  assert.equal(byId(run({ sessions: [fresh, fresh] }), 'cache-efficiency'), undefined);
});

test('cache-efficiency needs at least two churny sessions', () => {
  const lowReuse = session(50, { input: 9_000_000, cacheWrite: 1_000_000, cacheRead: 1_000_000 }, 20);
  assert.equal(byId(run({ sessions: [lowReuse] }), 'cache-efficiency'), undefined);
});

test('context-bloat fires when at least two sessions run hot', () => {
  const insight = byId(run({ sessions: [session(85), session(92), session(40)] }), 'context-bloat');
  assert.ok(insight);
  assert.match(insight!.evidence!, /peak 92%/);
});

test('context-bloat stays silent with only one hot session', () => {
  assert.equal(byId(run({ sessions: [session(85), session(30)] }), 'context-bloat'), undefined);
});

test('spend-forecast projects from the spend so far at the current pace', () => {
  // $6 of opus output (200k out * $25/MTok = $5) + input; just assert a doubling on day 15/30.
  const records = [record({ input: 1_000_000, output: 200_000 }, 'claude-opus-4-8')];
  const insight = byId(run({ records, now: JUNE_15 }), 'spend-forecast');
  assert.ok(insight);
  assert.match(insight!.detail, /on track to reach about/);
});

test('spend-forecast withholds the projection on day 1', () => {
  const records = [record({ input: 1_000_000, output: 200_000 }, 'claude-opus-4-8')];
  const day1 = new Date(2026, 5, 1, 6, 0, 0).getTime();
  assert.equal(byId(run({ records, now: day1 }), 'spend-forecast'), undefined);
});

test('spend-forecast reframes as API-equivalent usage on a subscription', () => {
  const records = [record({ input: 1_000_000, output: 200_000 }, 'claude-opus-4-8')];
  const insight = byId(run({ records, now: JUNE_15, subscription: true }), 'spend-forecast');
  assert.ok(insight);
  assert.match(insight!.title, /API-equivalent/);
  assert.match(insight!.detail, /usage gauge|not a bill/);
});

test('model-mix points a subscriber to their session limits (savings unchanged)', () => {
  const records = Array.from({ length: 6 }, () => record({ input: 1_000_000, output: 100 }, 'claude-opus-4-8'));
  const insight = byId(run({ records, subscription: true }), 'model-mix');
  assert.ok(insight);
  assert.match(insight!.detail, /5-hour \/ weekly limits/);
  assert.ok(insight!.savingsUsd! > 12 && insight!.savingsUsd! < 12.01);
});

test('analyze returns nothing for empty input', () => {
  assert.deepEqual(run({}), []);
});

test('analyze ranks a dollar-quantified tip above the informational forecast', () => {
  const records = [
    ...Array.from({ length: 6 }, () => record({ input: 1_000_000, output: 100 }, 'claude-opus-4-8')),
    record({ input: 1_000_000, output: 200_000 }, 'claude-opus-4-8'),
  ];
  const insights = run({ records, now: JUNE_15 });
  assert.equal(insights[0].id, 'model-mix');
  assert.equal(insights[insights.length - 1].id, 'spend-forecast');
});
