import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { mapUsageData, PlanLimits } from './limitsReader';
import { readOAuthAsync, isExpired } from './credentials';
import { claudeConfigDir } from './paths';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// The endpoint rate-limits user agents that aren't claude-code/<version>.
const USER_AGENT = 'claude-code/2.1.183';
const OAUTH_BETA = 'oauth-2025-04-20';
const REQUEST_TIMEOUT_MS = 8000;

interface HttpResult {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

let liveCache: { data: any; at: number } | undefined;
let lastAttemptAt = 0;
let backoffUntil = 0;

const SHARED_SKEW_MS = 60 * 1000;
let sharedWriteSeq = 0;

// Windows fails a rename over a file another window has open (EPERM), so retry.
const RENAME_ATTEMPTS = 3;
const RENAME_RETRY_MS = 20;

const TMP_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const TMP_ORPHAN_MS = 5 * 60 * 1000;
let lastSweepAt = 0;

// One window's bad clock must not mute every other window.
const MAX_BACKOFF_MS = 30 * 60 * 1000;

function sharedCachePath(): string {
  return path.join(claudeConfigDir(), '.ccut', 'usage-shared.json');
}

function sharedBackoffPath(): string {
  return path.join(claudeConfigDir(), '.ccut', 'usage-backoff.json');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeQuietly(file: string): Promise<void> {
  try {
    await fs.promises.unlink(file);
  } catch {}
}

export function parseSharedCache(text: string, now: number): { data: any; at: number } | undefined {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const at = typeof raw?.at === 'number' ? raw.at : undefined;
  if (raw?.v !== 1 || at === undefined || !raw.data || at > now + SHARED_SKEW_MS) {
    return undefined;
  }
  return { data: raw.data, at };
}

async function readSharedCache(now: number): Promise<{ data: any; at: number } | undefined> {
  let text: string;
  try {
    text = await fs.promises.readFile(sharedCachePath(), 'utf8');
  } catch {
    return undefined;
  }
  return parseSharedCache(text, now);
}

async function publishAtomic(file: string, payload: string): Promise<void> {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `${path.basename(file)}.${process.pid}.${sharedWriteSeq++}.tmp`);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(tmp, payload);
  } catch {
    await removeQuietly(tmp);
    return;
  }
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt++) {
    try {
      await fs.promises.rename(tmp, file);
      void sweepOrphanTmp(dir, Date.now());
      return;
    } catch {
      await delay(RENAME_RETRY_MS * (attempt + 1));
    }
  }
  // Non-atomic last resort: readers reject a torn file, and never publishing is worse.
  try {
    await fs.promises.writeFile(file, payload);
  } catch {}
  await removeQuietly(tmp);
}

async function sweepOrphanTmp(dir: string, now: number): Promise<void> {
  if (now - lastSweepAt < TMP_SWEEP_INTERVAL_MS) {
    return;
  }
  lastSweepAt = now;
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.tmp')) {
      continue;
    }
    const full = path.join(dir, name);
    try {
      const st = await fs.promises.stat(full);
      if (now - st.mtimeMs > TMP_ORPHAN_MS) {
        await removeQuietly(full);
      }
    } catch {}
  }
}

async function writeSharedCache(entry: { data: any; at: number }): Promise<void> {
  await publishAtomic(
    sharedCachePath(),
    JSON.stringify({ v: 1, data: entry.data, at: entry.at, writer: process.pid })
  );
}

export function parseBackoff(text: string, now: number): number {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return 0;
  }
  const until = typeof raw?.until === 'number' ? raw.until : 0;
  if (raw?.v !== 1 || until <= now || until - now > MAX_BACKOFF_MS) {
    return 0;
  }
  return until;
}

async function readSharedBackoff(now: number): Promise<number> {
  let text: string;
  try {
    text = await fs.promises.readFile(sharedBackoffPath(), 'utf8');
  } catch {
    return 0;
  }
  return parseBackoff(text, now);
}

async function writeSharedBackoff(until: number): Promise<void> {
  await publishAtomic(sharedBackoffPath(), JSON.stringify({ v: 1, until, writer: process.pid }));
}

// A socket can close without 'end' or 'error'; the absolute timer and close handlers guarantee settling.
function get(url: string, headers: Record<string, string>): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    let req: ReturnType<typeof https.request> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      try {
        req?.destroy();
      } catch {}
      action();
    };
    timer = setTimeout(() => finish(() => reject(new Error('request timed out'))), REQUEST_TIMEOUT_MS);
    req = https.request(
      {
        method: 'GET',
        hostname: target.hostname,
        path: target.pathname + target.search,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk as Buffer));
        res.on('end', () =>
          finish(() =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers })
          )
        );
        res.on('error', (err) => finish(() => reject(err)));
        res.on('aborted', () => finish(() => reject(new Error('response aborted'))));
        res.on('close', () => finish(() => reject(new Error('connection closed before response completed'))));
      }
    );
    req.on('error', (err) => finish(() => reject(err)));
    req.end();
  });
}

function retryAfterMs(headers: HttpResult['headers'], fallbackMs: number): number {
  const raw = headers['retry-after'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const seconds = value ? parseInt(value, 10) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  }
  return Math.min(Math.max(fallbackMs, 5 * 60 * 1000), MAX_BACKOFF_MS);
}

function usageHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'anthropic-beta': OAUTH_BETA,
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
  };
}

export async function fetchLiveLimits(minIntervalMs: number): Promise<PlanLimits | undefined> {
  const now = Date.now();
  const shared = await readSharedCache(now);
  if (shared && (!liveCache || shared.at > liveCache.at)) {
    liveCache = shared;
  }
  const cached = (): PlanLimits | undefined =>
    liveCache ? mapUsageData(liveCache.data, liveCache.at) : undefined;
  if (liveCache && now - liveCache.at < minIntervalMs) {
    return cached();
  }
  if (now < backoffUntil || now - lastAttemptAt < minIntervalMs) {
    return cached();
  }
  const sharedBackoff = await readSharedBackoff(now);
  if (sharedBackoff > backoffUntil) {
    backoffUntil = sharedBackoff;
  }
  if (now < backoffUntil) {
    return cached();
  }
  lastAttemptAt = now;
  // Never refresh the token here: spending Claude Code's refresh token can sign it out.
  const oauth = await readOAuthAsync();
  if (!oauth || isExpired(oauth.expiresAt, now)) {
    return cached();
  }
  let result: HttpResult;
  try {
    result = await get(USAGE_URL, usageHeaders(oauth.accessToken));
  } catch {
    return cached();
  }
  if (result.status === 429) {
    backoffUntil = Date.now() + retryAfterMs(result.headers, minIntervalMs);
    await writeSharedBackoff(backoffUntil);
    return cached();
  }
  if (result.status !== 200) {
    return cached();
  }
  let parsed: any;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    return cached();
  }
  if (!parsed || parsed.type === 'error') {
    return cached();
  }
  const at = Date.now();
  const mapped = mapUsageData(parsed, at);
  if (!mapped) {
    return cached();
  }
  liveCache = { data: parsed, at };
  await writeSharedCache(liveCache);
  return mapped;
}
