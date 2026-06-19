import * as https from 'https';
import { mapUsageData, PlanLimits } from './limitsReader';
import { readOAuth, isExpiring, OAuthCredentials } from './credentials';

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

// Module-level, so the throttle and refreshed token are per extension host.
// With N open windows that is ~N× the request rate against the same endpoint;
// the min-interval floor below keeps a single window well within safe limits.
let memToken: { accessToken: string; expiresAt?: number } | undefined;
let liveCache: { data: any; at: number } | undefined;
let lastAttemptAt = 0;
let backoffUntil = 0;

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
    return Math.min(seconds * 1000, 30 * 60 * 1000);
  }
  return Math.max(fallbackMs, 5 * 60 * 1000);
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
  const expiresAt = typeof parsed.expires_in === 'number' ? Date.now() + parsed.expires_in * 1000 : undefined;
  memToken = { accessToken: parsed.access_token, expiresAt };
  return parsed.access_token;
}

async function resolveToken(oauth: OAuthCredentials): Promise<string> {
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
  if (liveCache && now - liveCache.at < minIntervalMs) {
    return mapUsageData(liveCache.data, liveCache.at);
  }
  // Throttle network attempts whether they succeed or fail, so a rate-limited
  // or unreachable endpoint is not retried on every refresh tick.
  if (now < backoffUntil || now - lastAttemptAt < minIntervalMs) {
    return undefined;
  }
  const oauth = readOAuth();
  if (!oauth) {
    return undefined;
  }
  lastAttemptAt = Date.now();
  let token = await resolveToken(oauth);
  let result: HttpResult;
  try {
    result = await request('GET', USAGE_URL, usageHeaders(token));
    if (result.status === 401) {
      const refreshed = await refreshAccessToken(oauth);
      if (refreshed) {
        token = refreshed;
        result = await request('GET', USAGE_URL, usageHeaders(token));
      }
    }
  } catch {
    return undefined;
  }
  if (result.status === 429) {
    backoffUntil = Date.now() + retryAfterMs(result.headers, minIntervalMs);
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
  if (!parsed || parsed.type === 'error') {
    return undefined;
  }
  const at = Date.now();
  const mapped = mapUsageData(parsed, at);
  if (!mapped) {
    return undefined;
  }
  liveCache = { data: parsed, at };
  return mapped;
}
