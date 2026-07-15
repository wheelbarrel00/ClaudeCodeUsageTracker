import { test } from 'node:test';
import assert from 'node:assert/strict';
import { severityBand, LimitWindow } from './limitsReader';

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
