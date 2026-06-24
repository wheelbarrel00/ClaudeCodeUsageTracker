import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

export interface OAuthCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes: string[];
  subscriptionType?: string;
}

const EXPIRY_SKEW_MS = 5 * 60 * 1000;

export function credentialsPath(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, '.credentials.json');
}

export function readOAuth(): OAuthCredentials | undefined {
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
