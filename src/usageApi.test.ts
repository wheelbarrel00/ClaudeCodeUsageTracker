import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSharedCache } from './usageApi';

const NOW = 1_000_000_000;
const ok = (at: number) => JSON.stringify({ v: 1, data: { limits: [] }, at });

test('parseSharedCache accepts a current v1 payload', () => {
  const parsed = parseSharedCache(ok(NOW), NOW);
  assert.deepEqual(parsed, { data: { limits: [] }, at: NOW });
});

test('parseSharedCache tolerates a small forward clock skew', () => {
  assert.ok(parseSharedCache(ok(NOW + 30_000), NOW));
});

test('parseSharedCache rejects a far-future timestamp', () => {
  assert.equal(parseSharedCache(ok(NOW + 5 * 60_000), NOW), undefined);
});

test('parseSharedCache rejects unknown version, missing data/at, and garbage', () => {
  assert.equal(parseSharedCache(JSON.stringify({ v: 2, data: {}, at: NOW }), NOW), undefined);
  assert.equal(parseSharedCache(JSON.stringify({ v: 1, at: NOW }), NOW), undefined);
  assert.equal(parseSharedCache(JSON.stringify({ v: 1, data: {} }), NOW), undefined);
  assert.equal(parseSharedCache('{ not valid json', NOW), undefined);
  assert.equal(parseSharedCache('', NOW), undefined);
});
