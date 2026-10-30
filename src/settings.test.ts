import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import * as path from 'path';
import { numberSetting, NumberBounds, REFRESH_INTERVAL_S, LIVE_API_MIN_INTERVAL_S, ACTIVITY_WINDOW_MIN } from './settings';

const BOUNDS: NumberBounds = { fallback: 30, min: 5, max: 3600 };

test('numberSetting keeps an in-range number', () => {
  assert.equal(numberSetting(45, BOUNDS), 45);
});

test('numberSetting clamps to the range', () => {
  assert.equal(numberSetting(1, BOUNDS), 5);
  assert.equal(numberSetting(1e300, BOUNDS), 3600);
});

test('numberSetting falls back for anything that is not a finite number', () => {
  for (const raw of ['60', null, undefined, true, NaN, Infinity, -Infinity, {}, [60]]) {
    assert.equal(numberSetting(raw, BOUNDS), 30, String(raw));
  }
});

test('the refresh interval can never overflow a Node timer', () => {
  assert.ok(numberSetting(Number.MAX_VALUE, REFRESH_INTERVAL_S) * 1000 <= 2 ** 31 - 1);
});

test('the manifest declares the same bounds the code enforces', () => {
  const manifest = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const props = manifest.contributes.configuration.properties;
  const expected: [string, NumberBounds][] = [
    ['claudeCodeUsageTracker.refreshIntervalSeconds', REFRESH_INTERVAL_S],
    ['claudeCodeUsageTracker.liveApiMinIntervalSeconds', LIVE_API_MIN_INTERVAL_S],
    ['claudeCodeUsageTracker.predictiveAlerts.windowMinutes', ACTIVITY_WINDOW_MIN],
  ];
  for (const [key, bounds] of expected) {
    assert.equal(props[key].default, bounds.fallback, key);
    assert.equal(props[key].minimum, bounds.min, key);
    assert.equal(props[key].maximum, bounds.max, key);
  }
});
