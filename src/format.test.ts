import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCurrency } from './format';

test('formatCurrency renders a normal USD amount', () => {
  assert.equal(formatCurrency(12.5, 'USD', 2), '$12.50');
});

test('formatCurrency clamps a negative decimalPlaces instead of throwing', () => {
  // A hand-edited settings.json can pass a negative value past the schema's 0-6 bounds;
  // an unclamped toFixed(-1) would throw and take down every refresh.
  assert.doesNotThrow(() => formatCurrency(12.5, 'USD', -1));
  assert.equal(formatCurrency(12.5, 'USD', -1), '$13'); // clamped to 0 fraction digits
});

test('formatCurrency handles an out-of-range high decimalPlaces', () => {
  assert.doesNotThrow(() => formatCurrency(1, 'USD', 999));
});

test('formatCurrency falls back to a plain string for an unknown currency code', () => {
  assert.equal(formatCurrency(5, 'NOTACURRENCY', 2), '$5.00');
});
