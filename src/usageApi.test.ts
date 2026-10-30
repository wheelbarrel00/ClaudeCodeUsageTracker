import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as credentials from './credentials';
import { parseSharedCache, parseBackoff, fetchLiveLimits } from './usageApi';

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

test('parseBackoff accepts a live shared backoff', () => {
  const now = Date.now();
  assert.equal(parseBackoff(JSON.stringify({ v: 1, until: now + 60_000 }), now), now + 60_000);
});

test('parseBackoff ignores an elapsed, unversioned, or unparseable backoff', () => {
  const now = Date.now();
  assert.equal(parseBackoff(JSON.stringify({ v: 1, until: now - 1 }), now), 0);
  assert.equal(parseBackoff(JSON.stringify({ v: 2, until: now + 60_000 }), now), 0);
  assert.equal(parseBackoff(JSON.stringify({ until: now + 60_000 }), now), 0);
  assert.equal(parseBackoff('not json', now), 0);
});

test('parseBackoff caps a far-future backoff so one bad clock cannot mute every window', () => {
  const now = Date.now();
  assert.equal(parseBackoff(JSON.stringify({ v: 1, until: now + 3 * 60 * 60 * 1000 }), now), 0);
  assert.equal(parseBackoff(JSON.stringify({ v: 1, until: now + 29 * 60 * 1000 }), now), now + 29 * 60 * 1000);
});

test('parseBackoff accepts just under the cap and rejects just over it', () => {
  const now = Date.now();
  assert.equal(parseBackoff(JSON.stringify({ v: 1, until: now + 29 * 60_000 }), now), now + 29 * 60_000);
  assert.equal(parseBackoff(JSON.stringify({ v: 1, until: now + 31 * 60_000 }), now), 0);
});

test('the live fetch never spends Claude Code’s refresh token', () => {
  const compiled = fs.readFileSync(path.join(__dirname, 'usageApi.js'), 'utf8');
  assert.doesNotMatch(compiled, /refresh_token|oauth\/token|refreshToken/);
});

test('an expired token is re-read once per interval, not on every refresh', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccut-usage-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const read = t.mock.method(credentials, 'readOAuthAsync', async () => ({ accessToken: 'stale', expiresAt: 1 }));
  assert.equal(await fetchLiveLimits(60_000), undefined);
  assert.equal(await fetchLiveLimits(60_000), undefined);
  assert.equal(read.mock.callCount(), 1);
});
