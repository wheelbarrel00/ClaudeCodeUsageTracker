import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { t, setTranslator } from './l10n';

afterEach(() => setTranslator());

test('t returns the English text with placeholders filled when no translator is set', () => {
  assert.equal(t('resets in {0}h {1}m', 2, 5), 'resets in 2h 5m');
  assert.equal(t('resetting now'), 'resetting now');
});

test('t leaves a placeholder with no matching argument untouched', () => {
  assert.equal(t('{0} of {1}', 'a'), 'a of {1}');
});

test('t reuses an argument that appears twice', () => {
  assert.equal(t('{0}-{0}', 7), '7-7');
});

test('setTranslator routes every later call through the injected translator', () => {
  setTranslator((message, ...args) => `[ru] ${message} | ${args.join(',')}`);
  assert.equal(t('Updated {0}', '5m ago'), '[ru] Updated {0} | 5m ago');
});
