import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UsageRecord, EMPTY_TOKENS } from './types';
import {
  burnRate,
  etaFromAverageRate,
  projectedUtilization,
  describeProjection,
  predictsBreachBeforeReset,
  crossedThresholds,
  formatEta,
  evaluateWindow,
  emptyWindowState,
  sanitizeThresholds,
  modelAdvice,
  FIVE_HOUR_PERIOD_MS,
  SEVEN_DAY_PERIOD_MS,
  ON_PACE_BAND_PTS,
  EtaMode,
  WindowState,
} from './burnRate';
import { cheaperTier } from './pricing';

const MIN = 60_000;
const HOUR = 60 * MIN;

type Step = { now: number; utilization: number; resetsAt?: number };

function runWindow(
  steps: Step[],
  opts: { periodMs?: number; thresholds?: number[]; predictBreach?: boolean; etaMode?: EtaMode; recentlyActive?: boolean } = {}
): { states: WindowState[]; outcomes: ReturnType<typeof evaluateWindow>[] } {
  let state = emptyWindowState();
  const states: WindowState[] = [];
  const outcomes: ReturnType<typeof evaluateWindow>[] = [];
  for (const step of steps) {
    const outcome = evaluateWindow(state, {
      utilization: step.utilization,
      resetsAt: step.resetsAt,
      periodMs: opts.periodMs ?? FIVE_HOUR_PERIOD_MS,
      now: step.now,
      thresholds: opts.thresholds ?? [75, 90],
      predictBreach: opts.predictBreach ?? true,
      etaMode: opts.etaMode ?? 'projection',
      recentlyActive: opts.recentlyActive ?? true,
    });
    state = outcome.state;
    states.push(state);
    outcomes.push(outcome);
  }
  return { states, outcomes };
}

function record(timestamp: number, tokens: Partial<typeof EMPTY_TOKENS>, model = 'claude-opus-4-8'): UsageRecord {
  return { timestamp, model, tokens: { ...EMPTY_TOKENS, ...tokens } };
}

function approx(actual: number, expected: number, eps = 1e-6): void {
  assert.ok(Math.abs(actual - expected) <= eps, `expected ~${expected}, got ${actual}`);
}

test('burnRate is zero when there are no records', () => {
  const r = burnRate([], 1_000_000, 15 * MIN);
  assert.equal(r.tokensPerMin, 0);
  assert.equal(r.costPerMin, 0);
  assert.equal(r.windowTokens, 0);
  assert.equal(r.recordCount, 0);
});

test('burnRate sums tokens and cost only within the trailing window', () => {
  const now = 100 * MIN;
  const records = [
    record(now - 5 * MIN, { input: 1_000_000, output: 200_000 }),
    record(now - 20 * MIN, { input: 9_000_000 }),
    record(now + MIN, { input: 9_000_000 }),
  ];
  const r = burnRate(records, now, 15 * MIN);
  assert.equal(r.recordCount, 1);
  assert.equal(r.windowTokens, 1_200_000);
  approx(r.windowCostUsd, 10);
  approx(r.tokensPerMin, 1_200_000 / 15);
  approx(r.costPerMin, 10 / 15);
});

test('burnRate excludes the exact window-start boundary, includes now', () => {
  const now = 50 * MIN;
  const records = [record(now - 15 * MIN, { input: 100 }), record(now, { input: 200 })];
  const r = burnRate(records, now, 15 * MIN);
  assert.equal(r.recordCount, 1);
  assert.equal(r.windowTokens, 200);
});

test('burnRate separates new tokens from cached context re-reads', () => {
  const now = 1_000_000_000;
  const records = [record(now - 5 * MIN, { input: 100, output: 2_000, cacheWrite: 900, cacheRead: 280_000 })];
  const r = burnRate(records, now, 15 * MIN);
  approx(r.newTokensPerMin, 3_000 / 15);
  approx(r.cacheReadPerMin, 280_000 / 15);
  approx(r.tokensPerMin, 283_000 / 15);
  approx(r.newTokensPerMin + r.cacheReadPerMin, r.tokensPerMin);
});

test('etaFromAverageRate judges a 7-day window over days, not minutes (the weekly bug)', () => {
  const now = 1_000_000_000;
  const resetsAt = now + 80 * HOUR;
  const eta = etaFromAverageRate(9, resetsAt, SEVEN_DAY_PERIOD_MS, now)!;
  assert.ok(eta > 20 * 24 * HOUR, `expected weeks, got ${(eta / HOUR).toFixed(1)}h`);
  assert.equal(predictsBreachBeforeReset(eta, resetsAt, now), false);
});

test('etaFromAverageRate flags a 5-hour window pacing over the limit (true positive)', () => {
  const now = 1_000_000_000;
  const resetsAt = now + 1 * HOUR;
  const eta = etaFromAverageRate(85, resetsAt, FIVE_HOUR_PERIOD_MS, now)!;
  assert.ok(eta < 1 * HOUR);
  assert.equal(predictsBreachBeforeReset(eta, resetsAt, now), true);
});

test('etaFromAverageRate is undefined for idle / full / unknown-reset / too-early / past-reset windows', () => {
  const now = 1_000_000_000;
  const reset = now + 4 * HOUR;
  assert.equal(etaFromAverageRate(0, reset, FIVE_HOUR_PERIOD_MS, now), undefined);
  assert.equal(etaFromAverageRate(100, reset, FIVE_HOUR_PERIOD_MS, now), undefined);
  assert.equal(etaFromAverageRate(50, undefined, FIVE_HOUR_PERIOD_MS, now), undefined);
  assert.equal(etaFromAverageRate(80, now - 5 * MIN, FIVE_HOUR_PERIOD_MS, now), undefined);
  const earlyReset = now + (FIVE_HOUR_PERIOD_MS - 5 * MIN);
  assert.equal(etaFromAverageRate(3, earlyReset, FIVE_HOUR_PERIOD_MS, now), undefined);
});

test('projectedUtilization forecasts end-of-window utilization at the current pace', () => {
  const now = 1_000_000_000;
  // 24% used at the 2.5h (50%) mark of a 5h window -> finishes ~48%.
  approx(projectedUtilization(24, now + 2.5 * HOUR, FIVE_HOUR_PERIOD_MS, now)!, 48);
  // 70% used 4h in (80% elapsed) -> ~87.5% (under pace).
  approx(projectedUtilization(70, now + 1 * HOUR, FIVE_HOUR_PERIOD_MS, now)!, 87.5);
  // 72% used 3h in (60% elapsed) -> 120% (over pace).
  approx(projectedUtilization(72, now + 2 * HOUR, FIVE_HOUR_PERIOD_MS, now)!, 120);
});

test('projectedUtilization is undefined for idle / full / unknown-reset / past-reset / too-early', () => {
  const now = 1_000_000_000;
  const reset = now + 2 * HOUR;
  assert.equal(projectedUtilization(0, reset, FIVE_HOUR_PERIOD_MS, now), undefined);
  assert.equal(projectedUtilization(100, reset, FIVE_HOUR_PERIOD_MS, now), undefined);
  assert.equal(projectedUtilization(50, undefined, FIVE_HOUR_PERIOD_MS, now), undefined);
  assert.equal(projectedUtilization(50, now - 1, FIVE_HOUR_PERIOD_MS, now), undefined);
  const earlyReset = now + (FIVE_HOUR_PERIOD_MS - 5 * MIN);
  assert.equal(projectedUtilization(3, earlyReset, FIVE_HOUR_PERIOD_MS, now), undefined);
});

test('projectedUtilization > 100 is exactly the breach condition', () => {
  const now = 1_000_000_000;
  const reset = now + (SEVEN_DAY_PERIOD_MS - 96 * HOUR);
  const proj = projectedUtilization(60, reset, SEVEN_DAY_PERIOD_MS, now)!;
  const eta = etaFromAverageRate(60, reset, SEVEN_DAY_PERIOD_MS, now)!;
  assert.equal(proj > 100, predictsBreachBeforeReset(eta, reset, now));
});

test('predictsBreachBeforeReset compares ETA against time-to-reset', () => {
  const now = 1_000_000;
  assert.equal(predictsBreachBeforeReset(20 * MIN, now + 70 * MIN, now), true);
  assert.equal(predictsBreachBeforeReset(90 * MIN, now + 70 * MIN, now), false);
});

test('predictsBreachBeforeReset is false without an ETA, reset, or future reset', () => {
  const now = 1_000_000;
  assert.equal(predictsBreachBeforeReset(undefined, now + 70 * MIN, now), false);
  assert.equal(predictsBreachBeforeReset(20 * MIN, undefined, now), false);
  assert.equal(predictsBreachBeforeReset(20 * MIN, now - MIN, now), false);
});

test('crossedThresholds returns the reached thresholds in ascending order', () => {
  assert.deepEqual(crossedThresholds(92, [90, 75]), [75, 90]);
  assert.deepEqual(crossedThresholds(80, [75, 90]), [75]);
  assert.deepEqual(crossedThresholds(50, [75, 90]), []);
  assert.deepEqual(crossedThresholds(75, [75, 90]), [75]);
});

test('crossedThresholds compares the rounded (displayed) value', () => {
  assert.deepEqual(crossedThresholds(9.6, [10]), [10]);
  assert.deepEqual(crossedThresholds(9.4, [10]), []);
  assert.deepEqual(crossedThresholds(89.5, [90]), [90]);
});

test('formatEta renders minutes, hours, and days', () => {
  assert.equal(formatEta(38 * MIN), '~38m');
  assert.equal(formatEta(0), '~0m');
  assert.equal(formatEta(65 * MIN), '~1h05m');
  assert.equal(formatEta(125 * MIN), '~2h05m');
  assert.equal(formatEta(25 * HOUR), '~1d1h');
  assert.equal(formatEta(33 * 24 * HOUR), '~33d');
});

test('evaluateWindow warns the first time a threshold is reached, even from startup', () => {
  const { outcomes, states } = runWindow([{ now: 0, utilization: 80 }]);
  assert.equal(outcomes[0].fireThreshold, 75);
  assert.deepEqual(states[0].firedThresholds, [75]);
});

test('evaluateWindow does not re-warn a threshold already fired (in-memory debounce)', () => {
  const restored: WindowState = { ...emptyWindowState(), firedThresholds: [75], lastUtil: 80 };
  const outcome = evaluateWindow(restored, {
    utilization: 82,
    periodMs: FIVE_HOUR_PERIOD_MS,
    now: 0,
    thresholds: [75, 90],
    predictBreach: true,
    etaMode: 'projection',
    recentlyActive: true,
  });
  assert.equal(outcome.fireThreshold, undefined);
});

test('evaluateWindow fires a threshold once as it is crossed', () => {
  const { outcomes } = runWindow([
    { now: 0, utilization: 50 },
    { now: 1 * MIN, utilization: 80 },
    { now: 2 * MIN, utilization: 82 },
  ]);
  assert.equal(outcomes[0].fireThreshold, undefined);
  assert.equal(outcomes[1].fireThreshold, 75);
  assert.equal(outcomes[2].fireThreshold, undefined);
});

test('evaluateWindow jumping past two thresholds fires the highest and arms both', () => {
  const { outcomes, states } = runWindow([
    { now: 0, utilization: 50 },
    { now: 1 * MIN, utilization: 92 },
    { now: 2 * MIN, utilization: 95 },
  ]);
  assert.equal(outcomes[1].fireThreshold, 90);
  assert.deepEqual(states[1].firedThresholds, [75, 90]);
  assert.equal(outcomes[2].fireThreshold, undefined);
});

test('evaluateWindow does not re-fire after a small dip', () => {
  const { outcomes } = runWindow([
    { now: 0, utilization: 50 },
    { now: 1 * MIN, utilization: 80 },
    { now: 2 * MIN, utilization: 78 },
    { now: 3 * MIN, utilization: 82 },
  ]);
  assert.equal(outcomes[1].fireThreshold, 75);
  assert.equal(outcomes[3].fireThreshold, undefined);
});

test('evaluateWindow re-arms thresholds after a rollover (large utilization drop)', () => {
  const { outcomes, states } = runWindow([
    { now: 0, utilization: 50 },
    { now: 1 * MIN, utilization: 80 },
    { now: 2 * MIN, utilization: 2 },
    { now: 3 * MIN, utilization: 80 },
  ]);
  assert.equal(outcomes[1].fireThreshold, 75);
  assert.deepEqual(states[2].firedThresholds, []);
  assert.equal(outcomes[3].fireThreshold, 75);
});

test('evaluateWindow re-arms thresholds when resetsAt rolls to a new window', () => {
  const { outcomes } = runWindow([
    { now: 0, utilization: 80, resetsAt: 100 * HOUR },
    { now: 1 * MIN, utilization: 80, resetsAt: 200 * HOUR },
  ]);
  assert.equal(outcomes[0].fireThreshold, 75);
  assert.equal(outcomes[1].fireThreshold, 75);
});

test('evaluateWindow re-arms when the 5h window clears resets_at with a utilization drop', () => {
  const now0 = 1_000_000_000;
  const prev: WindowState = { firedThresholds: [3], breachWarned: false, lastResetsAt: now0 + HOUR, lastUtil: 4 };
  const outcome = evaluateWindow(prev, {
    utilization: 2,
    resetsAt: undefined,
    periodMs: FIVE_HOUR_PERIOD_MS,
    now: now0,
    thresholds: [3],
    predictBreach: true,
    etaMode: 'projection',
    recentlyActive: true,
  });
  assert.deepEqual(outcome.state.firedThresholds, []);
});

test('a vanished resets_at at unchanged high utilization is NOT a rollover (no spurious re-fire)', () => {
  const now0 = 1_000_000_000;
  const prev: WindowState = { firedThresholds: [75], breachWarned: false, lastResetsAt: now0 + HOUR, lastUtil: 85 };
  const outcome = evaluateWindow(prev, {
    utilization: 85,
    resetsAt: undefined,
    periodMs: FIVE_HOUR_PERIOD_MS,
    now: now0,
    thresholds: [75, 90],
    predictBreach: true,
    etaMode: 'projection',
    recentlyActive: true,
  });
  assert.equal(outcome.fireThreshold, undefined);
  assert.deepEqual(outcome.state.firedThresholds, [75]);
});

test('5h projection meter shows the projected end-of-window % under and over pace', () => {
  const now0 = 1_000_000_000;
  // 24% at the 50% mark -> 48%.
  const under = runWindow([{ now: now0, utilization: 24, resetsAt: now0 + 2.5 * HOUR }], { etaMode: 'projection', thresholds: [] });
  assert.equal(under.outcomes[0].annotation, 'projection');
  approx(under.outcomes[0].projectedUtil!, 48);
  assert.equal(under.outcomes[0].fireBreach, false);
  // 70% at the 50% mark -> 140%.
  const over = runWindow([{ now: now0, utilization: 70, resetsAt: now0 + 2.5 * HOUR }], { etaMode: 'projection', thresholds: [] });
  assert.equal(over.outcomes[0].annotation, 'projection');
  approx(over.outcomes[0].projectedUtil!, 140);
  assert.equal(over.outcomes[0].fireBreach, true);
});

test('5h projection is damped early instead of amplifying a thin slice', () => {
  const now0 = 1_000_000_000;
  const elapsed = 1 * HOUR;
  const reset = now0 + (FIVE_HOUR_PERIOD_MS - elapsed);
  const { outcomes } = runWindow([{ now: now0, utilization: 30, resetsAt: reset }], { etaMode: 'projection', thresholds: [] });
  const raw = (30 * FIVE_HOUR_PERIOD_MS) / elapsed;
  approx(outcomes[0].projectedUtil!, 78); // raw 150% shrunk toward 30% at confidence 0.4
  assert.ok(outcomes[0].projectedUtil! < raw && outcomes[0].projectedUtil! > 30);
  assert.equal(outcomes[0].annotation, 'projection');
});

test('an over-the-band damped reading before halfway still fires no breach: the ETA gate holds', () => {
  const now0 = 1_000_000_000;
  const reset = now0 + 3 * HOUR;
  const { outcomes } = runWindow([{ now: now0, utilization: 60, resetsAt: reset }], {
    etaMode: 'projection',
    thresholds: [],
    recentlyActive: true,
  });
  // Raw 150% shrunk toward 60% at confidence 0.8 -> 132%.
  approx(outcomes[0].projectedUtil!, 132);
  assert.equal(outcomes[0].annotation, 'projection');
  assert.equal(outcomes[0].etaMs, undefined);
  assert.equal(outcomes[0].fireBreach, false);
});

test('past the halfway mark the meter equals the raw projection (damping is fully confident)', () => {
  const now0 = 1_000_000_000;
  const reset = now0 + 2 * HOUR;
  const { outcomes } = runWindow([{ now: now0, utilization: 36, resetsAt: reset }], { etaMode: 'projection', thresholds: [] });
  approx(outcomes[0].projectedUtil!, (36 * FIVE_HOUR_PERIOD_MS) / (3 * HOUR));
});

test('5h projection stays visible when idle but never fires a breach popup', () => {
  const now0 = 1_000_000_000;
  const reset = now0 + 1 * HOUR;
  const idle = runWindow([{ now: now0, utilization: 95, resetsAt: reset }], {
    etaMode: 'projection',
    thresholds: [],
    recentlyActive: false,
  });
  assert.equal(idle.outcomes[0].annotation, 'projection');
  assert.equal(idle.outcomes[0].fireBreach, false);

  const active = runWindow([{ now: now0, utilization: 95, resetsAt: reset }], {
    etaMode: 'projection',
    thresholds: [],
    recentlyActive: true,
  });
  assert.equal(active.outcomes[0].annotation, 'projection');
  assert.equal(active.outcomes[0].fireBreach, true);
});

test('a knife-edge lead over pace reads "on pace" and raises no alarm', () => {
  const now0 = 1_000_000_000;
  const reset = now0 + 146 * MIN;
  const { outcomes } = runWindow([{ now: now0, utilization: 53, resetsAt: reset }], {
    etaMode: 'projection',
    thresholds: [],
  });
  assert.equal(outcomes[0].annotation, 'projection');
  approx(outcomes[0].projectedUtil!, (53 * 300) / 154);
  assert.equal(describeProjection(outcomes[0].projectedUtil!).segment, '· on pace');
  assert.equal(outcomes[0].fireBreach, false);
});

test('describeProjection reports "on pace" inside the dead-band instead of a coin-flip number', () => {
  assert.equal(describeProjection(103.2).segment, '· on pace');
  assert.equal(describeProjection(96).segment, '· on pace');
  assert.equal(describeProjection(48).segment, '→ 48%');
  assert.equal(describeProjection(140).segment, '→ 140%');
});

test('a heavy-then-idle window does not breach at the 50% mark (front-load + idle false alarm killed)', () => {
  const now0 = 1_000_000_000;
  const reset = now0 + 2.5 * HOUR;
  const idle = runWindow([{ now: now0, utilization: 70, resetsAt: reset }], { etaMode: 'projection', thresholds: [], recentlyActive: false });
  assert.equal(idle.outcomes[0].fireBreach, false);
  const active = runWindow([{ now: now0, utilization: 70, resetsAt: reset }], { etaMode: 'projection', thresholds: [], recentlyActive: true });
  assert.equal(active.outcomes[0].fireBreach, true);
});

test('weekly window (risk mode) hides its ETA unless genuinely on track to breach', () => {
  const now0 = 1_000_000_000;
  const reset = now0 + 80 * HOUR;
  const { outcomes } = runWindow([{ now: now0, utilization: 9, resetsAt: reset }], {
    etaMode: 'risk',
    periodMs: SEVEN_DAY_PERIOD_MS,
    thresholds: [],
  });
  assert.equal(outcomes[0].annotation, 'none');
  assert.ok(outcomes[0].etaMs! > 20 * 24 * HOUR);
  assert.equal(outcomes[0].fireBreach, false);
});

test('weekly window (risk mode) shows its ETA and breaches on a trustworthy over-pace track', () => {
  const now0 = 1_000_000_000;
  const reset = now0 + (SEVEN_DAY_PERIOD_MS - 96 * HOUR);
  const { outcomes } = runWindow([{ now: now0, utilization: 70, resetsAt: reset }], {
    etaMode: 'risk',
    periodMs: SEVEN_DAY_PERIOD_MS,
    thresholds: [],
  });
  assert.equal(outcomes[0].annotation, 'eta');
  assert.equal(outcomes[0].fireBreach, true);
});

test('weekly window (risk mode) hides its ETA while idle even when on track', () => {
  const now0 = 1_000_000_000;
  const reset = now0 + (SEVEN_DAY_PERIOD_MS - 96 * HOUR);
  const { outcomes } = runWindow([{ now: now0, utilization: 60, resetsAt: reset }], {
    etaMode: 'risk',
    periodMs: SEVEN_DAY_PERIOD_MS,
    thresholds: [],
    recentlyActive: false,
  });
  assert.equal(outcomes[0].annotation, 'none');
  assert.equal(outcomes[0].fireBreach, false);
});

test('a window with ETA mode off shows nothing and never breaches', () => {
  const now0 = 1_000_000_000;
  const reset = now0 + 1 * HOUR;
  const { outcomes } = runWindow([{ now: now0, utilization: 85, resetsAt: reset }], {
    etaMode: 'off',
    thresholds: [],
  });
  assert.equal(outcomes[0].annotation, 'none');
  assert.equal(outcomes[0].fireBreach, false);
});

test('no breach early in the window even when ahead of pace', () => {
  const now0 = 1_000_000_000;
  const reset = now0 + (SEVEN_DAY_PERIOD_MS - 17 * HOUR);
  const wk = runWindow([{ now: now0, utilization: 14, resetsAt: reset }], { etaMode: 'risk', periodMs: SEVEN_DAY_PERIOD_MS, thresholds: [] });
  assert.equal(wk.outcomes[0].fireBreach, false);
  assert.equal(wk.outcomes[0].annotation, 'none');
});

test('evaluateWindow fires a breach once when over pace, past halfway, and active', () => {
  const now0 = 1_000_000_000;
  const reset = now0 + 1 * HOUR;
  const { outcomes } = runWindow(
    [
      { now: now0, utilization: 95, resetsAt: reset },
      { now: now0 + 1 * MIN, utilization: 96, resetsAt: reset },
    ],
    { etaMode: 'projection', thresholds: [] }
  );
  assert.equal(outcomes[0].fireBreach, true);
  assert.equal(outcomes[1].fireBreach, false);
});

test('evaluateWindow never breaches when prediction is disabled', () => {
  const now0 = 1_000_000_000;
  const reset = now0 + 1 * HOUR;
  const { outcomes } = runWindow([{ now: now0, utilization: 85, resetsAt: reset }], {
    etaMode: 'projection',
    thresholds: [],
    predictBreach: false,
  });
  assert.equal(outcomes[0].fireBreach, false);
});

test('sanitizeThresholds drops junk, dedups, and sorts', () => {
  assert.deepEqual(sanitizeThresholds([90, 75, 75]), [75, 90]);
  assert.deepEqual(sanitizeThresholds([0, 50, 120, 'x', NaN, 100]), [50, 100]);
  assert.deepEqual(sanitizeThresholds('nope'), []);
  assert.deepEqual(sanitizeThresholds(undefined), []);
});

test('cheaperTier suggests a cheaper model, or nothing for budget tiers', () => {
  assert.equal(cheaperTier('claude-opus-4-8'), 'Sonnet');
  assert.equal(cheaperTier('claude-sonnet-4-6'), 'Haiku');
  assert.equal(cheaperTier('claude-fable-5'), 'Sonnet');
  assert.equal(cheaperTier('claude-haiku-4-5'), undefined);
  assert.equal(cheaperTier('some-unknown-model'), undefined);
});

function opusRecord(timestamp: number, output: number): UsageRecord {
  return record(timestamp, { input: 1_000_000, output }, 'claude-opus-4-8');
}

test('modelAdvice flags heavy short-output spend on an expensive model', () => {
  const now = 100 * MIN;
  const records = Array.from({ length: 6 }, (_, i) => opusRecord(now - (i + 1) * MIN, 100));
  const advice = modelAdvice(records, now, 15 * MIN);
  assert.ok(advice);
  assert.equal(advice!.model, 'claude-opus-4-8');
  assert.equal(advice!.cheaperLabel, 'Sonnet');
  assert.equal(advice!.messageCount, 6);
  approx(advice!.share, 1, 1e-9);
  assert.ok(advice!.avgOutputTokens <= 300);
});

test('modelAdvice stays silent when outputs are substantial', () => {
  const now = 100 * MIN;
  const records = Array.from({ length: 6 }, (_, i) => opusRecord(now - (i + 1) * MIN, 1500));
  assert.equal(modelAdvice(records, now, 15 * MIN), undefined);
});

test('modelAdvice stays silent below the minimum turn count', () => {
  const now = 100 * MIN;
  const records = Array.from({ length: 3 }, (_, i) => opusRecord(now - (i + 1) * MIN, 100));
  assert.equal(modelAdvice(records, now, 15 * MIN), undefined);
});

test('modelAdvice stays silent when the expensive model is a small share of spend', () => {
  const now = 100 * MIN;
  const records = [
    ...Array.from({ length: 6 }, (_, i) => record(now - (i + 1) * MIN, { input: 100_000, output: 100 }, 'claude-opus-4-8')),
    record(now - MIN, { input: 100_000_000 }, 'claude-haiku-4-5'),
  ];
  assert.equal(modelAdvice(records, now, 15 * MIN), undefined);
});

test('modelAdvice stays silent over trivial spend', () => {
  const now = 100 * MIN;
  const records = Array.from({ length: 6 }, (_, i) => record(now - (i + 1) * MIN, { input: 1000, output: 100 }, 'claude-opus-4-8'));
  assert.equal(modelAdvice(records, now, 15 * MIN), undefined);
});

test('modelAdvice never flags a budget model', () => {
  const now = 100 * MIN;
  const records = Array.from({ length: 8 }, (_, i) => record(now - (i + 1) * MIN, { input: 10_000_000, output: 100 }, 'claude-haiku-4-5'));
  assert.equal(modelAdvice(records, now, 15 * MIN), undefined);
});

test('a heavy early burn is not reported as "on pace" just because damping lands near 100', () => {
  const now = Date.now();
  const resetsAt = now + 4.4 * 60 * 60 * 1000;
  const damped = projectedUtilization(36, resetsAt, FIVE_HOUR_PERIOD_MS, now)!;
  assert.ok(Math.abs(damped - 100) <= ON_PACE_BAND_PTS, 'precondition: damped lands in the band');

  const outcome = evaluateWindow(emptyWindowState(), {
    utilization: 36,
    resetsAt,
    periodMs: FIVE_HOUR_PERIOD_MS,
    now,
    thresholds: [75, 90],
    predictBreach: true,
    etaMode: 'projection',
    recentlyActive: true,
  });
  assert.equal(Math.round(outcome.rawProjectedUtil!), 300);
  assert.notEqual(describeProjection(outcome.projectedUtil!, outcome.rawProjectedUtil).segment, '· on pace');
});

test('a genuinely on-pace window still reads "on pace"', () => {
  const now = Date.now();
  const resetsAt = now + 1 * 60 * 60 * 1000;
  const outcome = evaluateWindow(emptyWindowState(), {
    utilization: 80,
    resetsAt,
    periodMs: FIVE_HOUR_PERIOD_MS,
    now,
    thresholds: [95],
    predictBreach: false,
    etaMode: 'projection',
    recentlyActive: true,
  });
  assert.equal(describeProjection(outcome.projectedUtil!, outcome.rawProjectedUtil).segment, '· on pace');
});

test('describeProjection judges the verdict on the raw pace but prints the damped number', () => {
  assert.equal(describeProjection(100.8, 360).segment, '→ 101%');
  assert.equal(describeProjection(103.2, 103.2).segment, '· on pace');
  assert.equal(describeProjection(48, 48).segment, '→ 48%');
});

test('non-finite utilization yields no projection or ETA rather than rendering NaN', () => {
  const now = Date.now();
  const resetsAt = now + 2 * 60 * 60 * 1000;
  assert.equal(projectedUtilization(NaN, resetsAt, FIVE_HOUR_PERIOD_MS, now), undefined);
  assert.equal(etaFromAverageRate(NaN, resetsAt, FIVE_HOUR_PERIOD_MS, now), undefined);
  for (const bounded of [Infinity, -Infinity]) {
    assert.equal(projectedUtilization(bounded, resetsAt, FIVE_HOUR_PERIOD_MS, now), undefined);
  }
});

function windowInput(utilization: number, resetsAt: number | undefined, now: number) {
  return {
    utilization,
    resetsAt,
    periodMs: FIVE_HOUR_PERIOD_MS,
    now,
    thresholds: [75, 90],
    predictBreach: true,
    etaMode: 'projection' as EtaMode,
    recentlyActive: true,
  };
}

test('a tiny dip alongside a vanished resets_at does not re-fire a threshold', () => {
  const now = Date.now();
  const prev: WindowState = {
    firedThresholds: [75],
    breachWarned: true,
    lastResetsAt: now + 60 * 60 * 1000,
    lastUtil: 85,
  };
  const outcome = evaluateWindow(prev, windowInput(84.9, undefined, now));
  assert.equal(outcome.fireThreshold, undefined);
  assert.deepEqual(outcome.state.firedThresholds, [75]);
  assert.equal(outcome.state.breachWarned, true);
});

test('a large mid-window drop that stays high is a dip, not a rollover', () => {
  const now = Date.now();
  const prev: WindowState = {
    firedThresholds: [75],
    breachWarned: true,
    lastResetsAt: now + 60 * 60 * 1000,
    lastUtil: 82,
  };
  const outcome = evaluateWindow(prev, windowInput(74, now + 60 * 60 * 1000, now));
  assert.equal(outcome.fireThreshold, undefined);
  assert.deepEqual(outcome.state.firedThresholds, [75]);
});

test('a genuine rollover lands near empty and re-arms every alert', () => {
  const now = Date.now();
  const prev: WindowState = {
    firedThresholds: [75, 90],
    breachWarned: true,
    lastResetsAt: now - 1000,
    lastUtil: 93,
  };
  const outcome = evaluateWindow(prev, windowInput(0, undefined, now));
  assert.deepEqual(outcome.state.firedThresholds, []);
  assert.equal(outcome.state.breachWarned, false);
  assert.equal(outcome.fireThreshold, undefined);
});

test('an advancing resets_at is still an unambiguous rollover', () => {
  const now = Date.now();
  const prev: WindowState = {
    firedThresholds: [75],
    breachWarned: true,
    lastResetsAt: now + 1000,
    lastUtil: 80,
  };
  const outcome = evaluateWindow(prev, windowInput(3, now + 5 * 60 * 60 * 1000, now));
  assert.deepEqual(outcome.state.firedThresholds, []);
  assert.equal(outcome.state.breachWarned, false);
});

test('sub-second resets_at jitter between fetches never re-fires an alert', () => {
  const now0 = Date.now();
  const resetsAt = now0 + 2 * HOUR;
  const { outcomes, states } = runWindow(
    [
      { now: now0, utilization: 92, resetsAt },
      { now: now0 + 6 * MIN, utilization: 92, resetsAt: resetsAt + 820 },
      { now: now0 + 12 * MIN, utilization: 93, resetsAt: resetsAt + 245 },
      { now: now0 + 18 * MIN, utilization: 93, resetsAt: resetsAt + 1_049 },
    ],
    { predictBreach: true }
  );
  assert.equal(outcomes[0].fireThreshold, 90);
  for (const outcome of outcomes.slice(1)) {
    assert.equal(outcome.fireThreshold, undefined);
    assert.equal(outcome.fireBreach, false);
  }
  assert.deepEqual(states[3].firedThresholds, [75, 90]);
});

test('the weekly window only re-arms when resets_at moves to the next week', () => {
  const now0 = Date.now();
  const resetsAt = now0 + 3 * 24 * HOUR;
  const { outcomes } = runWindow(
    [
      { now: now0, utilization: 80, resetsAt },
      { now: now0 + MIN, utilization: 80, resetsAt: resetsAt + 30 * MIN },
      { now: now0 + 2 * MIN, utilization: 80, resetsAt: resetsAt + SEVEN_DAY_PERIOD_MS },
    ],
    { periodMs: SEVEN_DAY_PERIOD_MS }
  );
  assert.equal(outcomes[0].fireThreshold, 75);
  assert.equal(outcomes[1].fireThreshold, undefined, 'a 30-minute shift is not a new week');
  assert.equal(outcomes[2].fireThreshold, 75);
});

test('a drop that lands above the floor is a dip; one that lands below it is a rollover', () => {
  const now = Date.now();
  const prev: WindowState = {
    firedThresholds: [75],
    breachWarned: true,
    lastResetsAt: now + 60 * 60 * 1000,
    lastUtil: 85,
  };
  const dip = evaluateWindow(prev, windowInput(72, now + 60 * 60 * 1000, now));
  assert.deepEqual(dip.state.firedThresholds, [75], '85 -> 72 is still one window');

  const reset = evaluateWindow(prev, windowInput(8, now + 60 * 60 * 1000, now));
  assert.deepEqual(reset.state.firedThresholds, [], '85 -> 8 is a rollover');
});

test('a resets_at appearing after a large drop counts as a rollover', () => {
  const now = Date.now();
  const prev: WindowState = { firedThresholds: [75], breachWarned: true, lastUtil: 92 };
  const outcome = evaluateWindow(prev, windowInput(25, now + 4 * 60 * 60 * 1000, now));
  assert.deepEqual(outcome.state.firedThresholds, []);
  assert.equal(outcome.state.breachWarned, false);
});

test('fast-mode records reach the burn rate at the premium price', () => {
  const now = Date.now();
  const base = {
    timestamp: now - 60_000,
    model: 'claude-opus-5',
    tokens: { ...EMPTY_TOKENS, input: 1_000_000 },
  };
  const standard = burnRate([base], now, 5 * 60_000);
  const fast = burnRate([{ ...base, speed: 'fast' }], now, 5 * 60_000);
  assert.equal(standard.windowCostUsd, 5);
  assert.equal(fast.windowCostUsd, 10);
});

test('fast-mode turns reach the model advisor at the premium price', () => {
  const now = Date.now();
  const turns = (speed?: string) =>
    Array.from({ length: 6 }, () => ({
      timestamp: now - 60_000,
      model: 'claude-opus-5',
      tokens: { ...EMPTY_TOKENS, input: 1_000_000, output: 100 },
      ...(speed ? { speed } : {}),
    }));
  const standard = modelAdvice(turns(), now, 5 * 60_000);
  const fast = modelAdvice(turns('fast'), now, 5 * 60_000);
  assert.ok(standard && fast);
  assert.equal(Math.round(standard!.windowCostUsd), 30);
  assert.equal(Math.round(fast!.windowCostUsd), 60);
});
