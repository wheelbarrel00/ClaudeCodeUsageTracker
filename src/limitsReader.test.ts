import { test } from 'node:test';
import assert from 'node:assert/strict';
import { severityBand, mapUsageData, LimitWindow } from './limitsReader';

function win(utilization: number, severity = 'normal'): LimitWindow {
  return { utilization, severity };
}

test('severityBand derives bands from the warn thresholds', () => {
  assert.equal(severityBand(win(10), [75, 90]), 'normal');
  assert.equal(severityBand(win(74), [75, 90]), 'normal');
  assert.equal(severityBand(win(75), [75, 90]), 'warning');
  assert.equal(severityBand(win(89), [75, 90]), 'warning');
  assert.equal(severityBand(win(90), [75, 90]), 'error');
  assert.equal(severityBand(win(100), [75, 90]), 'error');
});

test('severityBand compares the rounded (displayed) utilization', () => {
  assert.equal(severityBand(win(74.6), [75, 90]), 'warning');
  assert.equal(severityBand(win(89.4), [75, 90]), 'warning');
});

test('severityBand with a single threshold jumps straight to error at it', () => {
  assert.equal(severityBand(win(89), [90]), 'normal');
  assert.equal(severityBand(win(90), [90]), 'error');
});

test('an explicit API error/critical escalates even below the thresholds', () => {
  assert.equal(severityBand(win(5, 'critical'), [75, 90]), 'error');
  assert.equal(severityBand(win(5, 'error'), [75, 90]), 'error');
});

test('an explicit API warning is honored but never downgrades a threshold band', () => {
  assert.equal(severityBand(win(5, 'warning'), [75, 90]), 'warning');
  assert.equal(severityBand(win(95, 'warning'), [75, 90]), 'error');
});

test('unknown API severity strings no longer color anything on their own', () => {
  assert.equal(severityBand(win(5, 'elevated'), [75, 90]), 'normal');
  assert.equal(severityBand(win(80, 'elevated'), [75, 90]), 'warning');
});

test('with no thresholds configured only the API severity speaks', () => {
  assert.equal(severityBand(win(99), []), 'normal');
  assert.equal(severityBand(win(99, 'warning'), []), 'warning');
  assert.equal(severityBand(win(99, 'critical'), []), 'error');
});

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function payload(windows: { kind: string; percent: number; resetsAgoMs?: number; resetsInMs?: number }[]) {
  const now = Date.now();
  return {
    limits: windows.map((w) => ({
      kind: w.kind,
      group: w.kind === 'session' ? 'session' : 'weekly',
      percent: w.percent,
      severity: 'normal',
      resets_at: new Date(
        w.resetsInMs !== undefined ? now + w.resetsInMs : now - (w.resetsAgoMs ?? 0)
      ).toISOString(),
      scope: null,
    })),
  };
}

test('a payload older than a full weekly period is refused outright', () => {
  const data = payload([{ kind: 'weekly_all', percent: 42, resetsInMs: 3 * DAY_MS }]);
  assert.equal(mapUsageData(data, Date.now() - 8 * DAY_MS), undefined);
});

test('a reading inside the cap is served; just outside it is refused', () => {
  const data = payload([{ kind: 'weekly_all', percent: 63, resetsInMs: 3 * DAY_MS }]);
  assert.equal(mapUsageData(data, Date.now() - (7 * DAY_MS - HOUR_MS))?.sevenDay?.utilization, 63);
  assert.equal(mapUsageData(data, Date.now() - (7 * DAY_MS + HOUR_MS)), undefined);
});

test('a hours-old reading still reports a window that has not expired', () => {
  const data = payload([{ kind: 'weekly_all', percent: 63, resetsInMs: 3 * DAY_MS }]);
  assert.equal(mapUsageData(data, Date.now() - 4 * HOUR_MS)?.sevenDay?.utilization, 63);
});

test('a payload with no fetchedAt timestamp cannot be age-checked, so it is refused', () => {
  const data = payload([{ kind: 'weekly_all', percent: 42, resetsInMs: 3 * DAY_MS }]);
  assert.equal(mapUsageData(data, undefined as unknown as number), undefined);
});

test('an expired weekly window is dropped, not reported as a fresh 0%', () => {
  const data = payload([
    { kind: 'weekly_all', percent: 63, resetsAgoMs: 60 * MINUTE_MS },
    { kind: 'session', percent: 12, resetsInMs: 2 * HOUR_MS },
  ]);
  const limits = mapUsageData(data, Date.now() - 90 * MINUTE_MS);
  assert.equal(limits?.fiveHour?.utilization, 12, 'the live window proves the payload was accepted');
  assert.equal(limits?.sevenDay, undefined);
});

test('a rollover inside the grace bridges to 0%; outside it the window is dropped', () => {
  const inside = payload([
    { kind: 'weekly_all', percent: 93, resetsAgoMs: 10 * MINUTE_MS },
    { kind: 'session', percent: 12, resetsInMs: 2 * HOUR_MS },
  ]);
  assert.equal(mapUsageData(inside, Date.now() - 11 * MINUTE_MS)?.sevenDay?.utilization, 0);

  const outside = payload([
    { kind: 'weekly_all', percent: 93, resetsAgoMs: 20 * MINUTE_MS },
    { kind: 'session', percent: 12, resetsInMs: 2 * HOUR_MS },
  ]);
  assert.equal(mapUsageData(outside, Date.now() - 21 * MINUTE_MS)?.sevenDay, undefined);
});

test('an expired 5-hour window is dropped once the rollover is no longer recent', () => {
  const data = payload([
    { kind: 'session', percent: 88, resetsAgoMs: 45 * MINUTE_MS },
    { kind: 'weekly_all', percent: 30, resetsInMs: 3 * DAY_MS },
  ]);
  const limits = mapUsageData(data, Date.now() - 50 * MINUTE_MS);
  assert.equal(limits?.sevenDay?.utilization, 30, 'the live window proves the payload was accepted');
  assert.equal(limits?.fiveHour, undefined);
});

test('a just-rolled weekly window still bridges to 0% and projects the next boundary', () => {
  const data = payload([{ kind: 'weekly_all', percent: 93, resetsAgoMs: 2 * MINUTE_MS }]);
  const limits = mapUsageData(data, Date.now() - 3 * MINUTE_MS);
  assert.equal(limits?.sevenDay?.utilization, 0);
  assert.equal(limits?.sevenDay?.severity, 'normal');
  const expected = Date.now() - 2 * MINUTE_MS + 7 * DAY_MS;
  assert.ok(Math.abs((limits?.sevenDay?.resetsAt ?? 0) - expected) < MINUTE_MS);
});

test('a just-rolled 5-hour window bridges to 0% and clears its unknown next reset', () => {
  const data = payload([{ kind: 'session', percent: 71, resetsAgoMs: MINUTE_MS }]);
  const limits = mapUsageData(data, Date.now() - 2 * MINUTE_MS);
  assert.equal(limits?.fiveHour?.utilization, 0);
  assert.equal(limits?.fiveHour?.resetsAt, undefined);
});

test('a recent payload with live windows passes through untouched', () => {
  const data = payload([
    { kind: 'session', percent: 2, resetsInMs: 4 * HOUR_MS },
    { kind: 'weekly_all', percent: 16, resetsInMs: 3 * DAY_MS },
  ]);
  const limits = mapUsageData(data, Date.now() - MINUTE_MS);
  assert.equal(limits?.fiveHour?.utilization, 2);
  assert.equal(limits?.sevenDay?.utilization, 16);
});

test('a months-stale cache contributes nothing, not even its never-expiring scoped rows', () => {
  const data = {
    ...payload([{ kind: 'weekly_all', percent: 6, resetsAgoMs: 77 * DAY_MS }]),
    seven_day_sonnet: { utilization: 0, resets_at: null },
  };
  (data as any).limits.push({
    kind: 'weekly_scoped',
    percent: 0,
    severity: 'normal',
    resets_at: null,
    scope: { model: { display_name: 'Sonnet' } },
  });
  assert.equal(mapUsageData(data, Date.now() - 77 * DAY_MS), undefined);
});

test('a future-dated payload is refused rather than treated as maximally fresh', () => {
  const data = payload([{ kind: 'weekly_all', percent: 6, resetsAgoMs: 77 * DAY_MS }]);
  assert.equal(mapUsageData(data, Date.now() + DAY_MS), undefined);
  assert.equal(mapUsageData(data, Date.now() + 365 * DAY_MS), undefined);
});

test('clock skew is tolerated up to a minute and refused beyond it', () => {
  const data = payload([{ kind: 'weekly_all', percent: 16, resetsInMs: 3 * DAY_MS }]);
  assert.equal(mapUsageData(data, Date.now() + 30 * 1000)?.sevenDay?.utilization, 16);
  assert.equal(mapUsageData(data, Date.now() + 5 * MINUTE_MS), undefined);
});

test('an exhausted window is never normal, whatever the thresholds say', () => {
  assert.equal(severityBand(win(100), []), 'error');
  assert.equal(severityBand(win(100), [75, 90]), 'error');
  assert.equal(severityBand(win(99.6), []), 'error');
  assert.equal(severityBand(win(99), []), 'normal');
});
