import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { claudeConfigDir } from './paths';
import type { PlanLimits } from './limitsReader';

export interface OAuthCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes: string[];
  subscriptionType?: string;
}

const EXPIRY_SKEW_MS = 5 * 60 * 1000;

// readOAuth runs on every render; a short TTL keeps it a memory read, not a per-render readFileSync/keychain spawn.
const READ_TTL_MS = 15 * 1000;
const KEYCHAIN_TIMEOUT_MS = 10 * 1000;
let readCache: { value: OAuthCredentials | undefined; at: number } | undefined;
let keychainInFlight: Promise<OAuthCredentials | undefined> | undefined;
let cacheGen = 0;

function writeCache(value: OAuthCredentials | undefined, at: number): void {
  readCache = { value, at };
  cacheGen++;
}

export function credentialsPath(): string {
  return path.join(claudeConfigDir(), '.credentials.json');
}

// macOS keeps creds in the login Keychain, not .credentials.json; derive service/account exactly as Claude Code does.
export function keychainService(): string {
  return `Claude Code-credentials${keychainServiceSuffix()}`;
}

function keychainServiceSuffix(): string {
  const secure = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (secure !== undefined) {
    return secure ? hashDir(secure) : '';
  }
  return process.env.CLAUDE_CONFIG_DIR ? hashDir(process.env.CLAUDE_CONFIG_DIR) : '';
}

function hashDir(dir: string): string {
  return `-${crypto.createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8)}`;
}

export function keychainAccount(): string {
  const fallback = 'claude-code-user';
  let user: string | undefined;
  try {
    user = process.env.USER || os.userInfo().username;
  } catch {
    return fallback;
  }
  return user && /^[a-zA-Z0-9._-]+$/.test(user) ? user : fallback;
}

export function parseCredentials(text: string): OAuthCredentials | undefined {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const oauth = raw?.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) {
    return undefined;
  }
  return {
    accessToken: oauth.accessToken,
    refreshToken: typeof oauth.refreshToken === 'string' ? oauth.refreshToken : undefined,
    expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined,
    scopes: Array.isArray(oauth.scopes) ? oauth.scopes.filter((s: unknown) => typeof s === 'string') : [],
    subscriptionType: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : undefined,
  };
}

function readFile(): OAuthCredentials | undefined {
  try {
    return parseCredentials(fs.readFileSync(credentialsPath(), 'utf8'));
  } catch {
    return undefined;
  }
}

function readKeychainViaSecurity(): Promise<OAuthCredentials | undefined> {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-a', keychainAccount(), '-w', '-s', keychainService()],
      { timeout: KEYCHAIN_TIMEOUT_MS },
      (err, stdout) => resolve(err || !stdout ? undefined : parseCredentials(stdout))
    );
  });
}

let keychainReader: () => Promise<OAuthCredentials | undefined> = readKeychainViaSecurity;

function cacheFresh(now: number): boolean {
  return !!readCache && now - readCache.at < READ_TTL_MS;
}

// Sync: file plus the last cached Keychain value, never a subprocess; on macOS it warms the cache in the background.
export function readOAuth(): OAuthCredentials | undefined {
  const now = Date.now();
  if (cacheFresh(now)) {
    return readCache!.value;
  }
  const fromFile = readFile();
  if (fromFile) {
    writeCache(fromFile, now);
    return fromFile;
  }
  if (process.platform === 'darwin') {
    void readOAuthAsync();
    return readCache?.value;
  }
  writeCache(undefined, now);
  return undefined;
}

// Async: file first, then the macOS Keychain; fetchLiveLimits awaits this so a Mac (no file) still gets a token.
export async function readOAuthAsync(): Promise<OAuthCredentials | undefined> {
  const now = Date.now();
  if (cacheFresh(now)) {
    return readCache!.value;
  }
  const fromFile = readFile();
  if (fromFile) {
    writeCache(fromFile, now);
    return fromFile;
  }
  if (process.platform !== 'darwin') {
    writeCache(undefined, now);
    return undefined;
  }
  if (!keychainInFlight) {
    // Don't let a stale Keychain result overwrite fresher creds a concurrent file read cached while `security` ran.
    const genAtSpawn = cacheGen;
    keychainInFlight = keychainReader()
      .then((value) => {
        if (cacheGen === genAtSpawn) {
          writeCache(value, Date.now());
        }
        return value;
      })
      .catch(() => undefined)
      .finally(() => {
        keychainInFlight = undefined;
      });
  }
  return keychainInFlight;
}

export function isExpiring(expiresAt?: number): boolean {
  return typeof expiresAt === 'number' && Date.now() + EXPIRY_SKEW_MS >= expiresAt;
}

// Subscription (Pro/Max) bills a flat fee, not per token — lets the advisor frame dollar figures as estimates, not a bill.
export function isSubscription(): boolean {
  const sub = readOAuth()?.subscriptionType;
  return typeof sub === 'string' && sub.length > 0;
}

// A present limit window already proves the subscription; only read credentials when it's absent.
export function hasSubscription(limits?: PlanLimits): boolean {
  return !!(limits?.fiveHour || limits?.sevenDay) || isSubscription();
}

// Test seams: reset module state and swap the Keychain reader so the platform/coalescing paths are exercisable.
export function __resetCredentialCacheForTests(): void {
  readCache = undefined;
  keychainInFlight = undefined;
  cacheGen = 0;
}

export function __setKeychainReaderForTests(fn?: () => Promise<OAuthCredentials | undefined>): void {
  keychainReader = fn ?? readKeychainViaSecurity;
}
