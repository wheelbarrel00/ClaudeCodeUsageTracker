import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import * as path from 'path';
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

test('every t() string has an entry with the same placeholders in each translation bundle', () => {
  const root = path.join(__dirname, '..');
  const srcDir = path.join(root, 'src');
  const keys = new Set<string>();
  for (const file of readdirSync(srcDir)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) {
      continue;
    }
    const source = readFileSync(path.join(srcDir, file), 'utf8');
    assert.doesNotMatch(source, /\bt\(\s*`/, `${file} passes a template literal to t()`);
    for (const match of source.matchAll(/\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) {
      keys.add(match[2].replace(/\\(['"\\])/g, '$1'));
    }
  }
  assert.ok(keys.size > 0);
  const placeholders = (text: string): string =>
    [...text.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(',');
  const bundleDir = path.join(root, 'l10n');
  const bundles = readdirSync(bundleDir).filter((name) => /^bundle\.l10n\.[\w-]+\.json$/.test(name));
  assert.ok(bundles.length > 0);
  for (const name of bundles) {
    const bundle: Record<string, string> = JSON.parse(readFileSync(path.join(bundleDir, name), 'utf8'));
    for (const key of keys) {
      assert.ok(key in bundle, `${name} is missing "${key}"`);
      assert.equal(placeholders(bundle[key]), placeholders(key), `${name} placeholders differ for "${key}"`);
    }
  }
});
