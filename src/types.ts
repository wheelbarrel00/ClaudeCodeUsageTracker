export interface TokenCounts {
  input: number;
  output: number;
  cacheWrite: number;
  // Subset of cacheWrite, kept only for pricing; never add it to a token total.
  cacheWrite1h: number;
  cacheRead: number;
}

export interface UsageRecord {
  timestamp: number;
  model: string;
  tokens: TokenCounts;
  project?: string;
  cwd?: string;
  session?: string;
  sessionTitle?: string;
  branch?: string;
  isSidechain?: boolean;
  speed?: string;
}

export interface UsageSummary {
  tokens: TokenCounts;
  costUsd: number;
  messageCount: number;
}

export const EMPTY_TOKENS: TokenCounts = {
  input: 0,
  output: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
};

export function emptySummary(): UsageSummary {
  return { tokens: { ...EMPTY_TOKENS }, costUsd: 0, messageCount: 0 };
}

export function totalTokens(t: TokenCounts): number {
  return t.input + t.output + t.cacheWrite + t.cacheRead;
}
