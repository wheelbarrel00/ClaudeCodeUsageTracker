import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { claudeConfigDir } from './paths';
import type { PlanLimits } from './limitsReader';

export interface OAuthCredentials {
  accessToken: string;
  expiresAt?: number;
  subscriptionType?: string;
}

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

// Mirrors how Claude Code names its macOS Keychain entry.
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
    expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined,
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
    // A file read that landed while `security` ran is fresher; don't overwrite it.
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

export function isExpired(expiresAt: number | undefined, now: number): boolean {
  return typeof expiresAt === 'number' && now >= expiresAt;
}

export function isSubscription(): boolean {
  const sub = readOAuth()?.subscriptionType;
  return typeof sub === 'string' && sub.length > 0;
}

export function hasSubscription(limits?: PlanLimits): boolean {
  return !!(limits?.fiveHour || limits?.sevenDay || limits?.scoped.length) || isSubscription();
}

export function __resetCredentialCacheForTests(): void {
  readCache = undefined;
  keychainInFlight = undefined;
  cacheGen = 0;
}

export function __setKeychainReaderForTests(fn?: () => Promise<OAuthCredentials | undefined>): void {
  keychainReader = fn ?? readKeychainViaSecurity;
}
