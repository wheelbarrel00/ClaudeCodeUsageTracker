// Shared types for Claude Code Usage Tracker.

/** Token counts for a single unit of usage (one message, one day, etc.). */
export interface TokenCounts {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** A single usage record parsed from one Claude Code log entry. */
export interface UsageRecord {
  timestamp: number; // epoch milliseconds
  model: string;
  tokens: TokenCounts;
  project?: string;
}

/** Aggregated usage plus an estimated cost (USD). */
export interface UsageSummary {
  tokens: TokenCounts;
  costUsd: number;
  messageCount: number;
}

export const EMPTY_TOKENS: TokenCounts = {
  input: 0,
  output: 0,
  cacheWrite: 0,
  cacheRead: 0,
};

export function emptySummary(): UsageSummary {
  return { tokens: { ...EMPTY_TOKENS }, costUsd: 0, messageCount: 0 };
}
