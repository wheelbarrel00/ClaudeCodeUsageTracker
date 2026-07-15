import * as path from 'path';
import * as fs from 'fs';
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

// readOAuth runs on every render; a short TTL keeps it a memory read, not a per-render readFileSync.
const READ_TTL_MS = 15 * 1000;
let readCache: { value: OAuthCredentials | undefined; at: number } | undefined;

export function credentialsPath(): string {
  return path.join(claudeConfigDir(), '.credentials.json');
}

export function readOAuth(): OAuthCredentials | undefined {
  if (readCache && Date.now() - readCache.at < READ_TTL_MS) {
    return readCache.value;
  }
  const value = readOAuthFresh();
  readCache = { value, at: Date.now() };
  return value;
}

function readOAuthFresh(): OAuthCredentials | undefined {
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(credentialsPath(), 'utf8'));
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
