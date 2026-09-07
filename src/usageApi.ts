import * as https from 'https';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { mapUsageData, PlanLimits } from './limitsReader';
import { readOAuthAsync, isExpiring, OAuthCredentials } from './credentials';
import { claudeConfigDir } from './paths';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// The endpoint rate-limits clients that lack a claude-code/* user agent.
// Bump on releases; it must keep the claude-code/<version> shape.
const USER_AGENT = 'claude-code/2.1.183';
const OAUTH_BETA = 'oauth-2025-04-20';
const REQUEST_TIMEOUT_MS = 8000;

interface HttpResult {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

// Per extension host; a successful fetch is also published to a shared file all
// windows read, so N windows make ~one request between them instead of N (avoiding 429s).
let memToken: { accessToken: string; expiresAt: number; mintedFor: string } | undefined;
let liveCache: { data: any; at: number } | undefined;
let lastAttemptAt = 0;
let backoffUntil = 0;

const SHARED_SKEW_MS = 60 * 1000;
let sharedWriteSeq = 0;

// fs.rename over a destination another process has open fails with EPERM on Windows — measured
// at ~30% under a concurrent read/rename loop, and every window reads this path on every tick.
const RENAME_ATTEMPTS = 3;
const RENAME_RETRY_MS = 20;

// A host killed between writeFile and rename strands a .tmp that nothing else removes.
const TMP_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const TMP_ORPHAN_MS = 5 * 60 * 1000;
let lastSweepAt = 0;

// Matches retryAfterMs's cap: one window's bad clock must not mute every other window.
const MAX_BACKOFF_MS = 30 * 60 * 1000;

const UNKNOWN_TOKEN_TTL_MS = 15 * 60 * 1000;

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
  } catch {
    // ignore
  }
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
  // Last resort: a non-atomic overwrite. A torn read is recoverable — the parsers reject
  // unparseable content and the reader keeps its last value — never publishing is not.
  try {
    await fs.promises.writeFile(file, payload);
  } catch {
    // ignore
  }
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
    } catch {
      // ignore
    }
  }
}

async function writeSharedCache(entry: { data: any; at: number }): Promise<void> {
  await publishAtomic(
    sharedCachePath(),
    JSON.stringify({ v: 1, data: entry.data, at: entry.at, writer: process.pid })
  );
}

// A 429 is account-wide, so the backoff is shared the way the reading is.
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

// Always settles within REQUEST_TIMEOUT_MS. A premature socket close can fire
// neither 'end' nor 'error', and req.setTimeout (socket-idle) cannot rescue an
// already-closed socket — so an absolute timer plus close/aborted handlers are
// what guarantee the promise never hangs (a hang would wedge the refresh loop).
function request(
  method: string,
  url: string,
  headers: Record<string, string>,
  jsonBody?: unknown
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const payload = jsonBody === undefined ? undefined : Buffer.from(JSON.stringify(jsonBody));
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
      } catch {
        // ignore
      }
      action();
    };
    timer = setTimeout(() => finish(() => reject(new Error('request timed out'))), REQUEST_TIMEOUT_MS);
    req = https.request(
      {
        method,
        hostname: target.hostname,
        path: target.pathname + target.search,
        headers: payload ? { ...headers, 'Content-Length': String(payload.length) } : headers,
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
    if (payload) {
      req.write(payload);
    }
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
  // Capped like the header branch: liveApiMinIntervalSeconds has no maximum, and a longer backoff
  // is rejected as far-future by every window that reads it.
  return Math.min(Math.max(fallbackMs, 5 * 60 * 1000), MAX_BACKOFF_MS);
}

// Refreshes the access token in memory only — never writes ~/.claude/.credentials.json,
// so a concurrent Claude Code session can't be logged out by us.
async function refreshAccessToken(oauth: OAuthCredentials): Promise<string | undefined> {
  if (!oauth.refreshToken) {
    return undefined;
  }
  let result: HttpResult;
  try {
    result = await request(
      'POST',
      TOKEN_URL,
      { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      {
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id: CLIENT_ID,
        scope: oauth.scopes.join(' '),
      }
    );
  } catch {
    return undefined;
  }
  if (result.status !== 200) {
    return undefined;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    return undefined;
  }
  if (typeof parsed?.access_token !== 'string') {
    return undefined;
  }
  // isExpiring(undefined) is false, so an unknown expiry would pin a token that never looks stale.
  const expiresIn = Number.isFinite(parsed.expires_in) ? parsed.expires_in * 1000 : UNKNOWN_TOKEN_TTL_MS;
  memToken = {
    accessToken: parsed.access_token,
    expiresAt: Date.now() + expiresIn,
    mintedFor: credentialId(oauth),
  };
  return parsed.access_token;
}

// Hashed because it is only ever compared, never sent.
export function credentialId(oauth: OAuthCredentials): string {
  return createHash('sha256').update(oauth.refreshToken || oauth.accessToken).digest('hex');
}

async function resolveToken(oauth: OAuthCredentials): Promise<string> {
  // A stale in-memory token shadows a newly logged-in account, and the request succeeds against
  // the old one — so no 401 ever arrives to correct it.
  if (memToken && memToken.mintedFor !== credentialId(oauth)) {
    memToken = undefined;
  }
  if (memToken && !isExpiring(memToken.expiresAt)) {
    return memToken.accessToken;
  }
  if (!isExpiring(oauth.expiresAt)) {
    return oauth.accessToken;
  }
  const refreshed = await refreshAccessToken(oauth);
  return refreshed ?? oauth.accessToken;
}

function usageHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'anthropic-beta': OAUTH_BETA,
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
  };
}

// Fetches current plan limits live from Anthropic. Returns undefined on any
// failure (no creds, network error, non-200, unparseable, error payload) so the
// caller can fall back to the on-disk cache. Network calls are throttled to
// minIntervalMs; within that window the last payload is re-mapped so reset
// roll-over stays current without re-hitting the endpoint.
export async function fetchLiveLimits(minIntervalMs: number): Promise<PlanLimits | undefined> {
  const now = Date.now();
  const shared = await readSharedCache(now);
  if (shared && (!liveCache || shared.at > liveCache.at)) {
    liveCache = shared;
  }
  const cached = (): PlanLimits | undefined =>
    liveCache ? mapUsageData(liveCache.data, liveCache.at) : undefined;
  // Fresh cache from any window satisfies us without a network call.
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
  const oauth = await readOAuthAsync();
  if (!oauth) {
    return cached();
  }
  lastAttemptAt = Date.now();
  let token = await resolveToken(oauth);
  let result: HttpResult;
  try {
    result = await request('GET', USAGE_URL, usageHeaders(token));
    if (result.status === 401) {
      memToken = undefined;
      const refreshed = await refreshAccessToken(oauth);
      if (refreshed) {
        token = refreshed;
        result = await request('GET', USAGE_URL, usageHeaders(token));
      }
    }
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
