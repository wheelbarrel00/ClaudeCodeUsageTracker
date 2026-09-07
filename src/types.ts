// Shared types for Claude Code Usage Tracker.

/** Token counts for a single unit of usage (one message, one day, etc.). */
export interface TokenCounts {
  input: number;
  output: number;
  cacheWrite: number;
  // 1-hour-TTL subset of cacheWrite (billed at 2x input). Already counted in cacheWrite —
  // tracked only for pricing; never add it to a token total.
  cacheWrite1h: number;
  cacheRead: number;
}

/** A single usage record parsed from one Claude Code log entry. */
export interface UsageRecord {
  timestamp: number; // epoch milliseconds
  model: string;
  tokens: TokenCounts;
  project?: string;
  cwd?: string;
  session?: string;
  sessionTitle?: string;
  branch?: string;
  // Subagent turn: real spend, so it counts in every total, but it is not "the current conversation".
  isSidechain?: boolean;
  // usage.speed — 'fast' bills at premium rates. Absent on models without fast mode.
  speed?: string;
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
  cacheWrite1h: 0,
  cacheRead: 0,
};

export function emptySummary(): UsageSummary {
  return { tokens: { ...EMPTY_TOKENS }, costUsd: 0, messageCount: 0 };
}

/** All tokens processed. cacheWrite1h is a subset of cacheWrite and must not be added. */
export function totalTokens(t: TokenCounts): number {
  return t.input + t.output + t.cacheWrite + t.cacheRead;
}
