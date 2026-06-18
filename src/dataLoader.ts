import * as os from 'os';
import * as path from 'path';
import { UsageRecord, UsageSummary, EMPTY_TOKENS } from './types';
import { estimateCost } from './pricing';

/** Root directory where Claude Code stores its per-project session logs. */
export function claudeLogRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Load and parse usage records from Claude Code's local logs.
 *
 * TODO (first milestone): walk claudeLogRoot() recursively for .jsonl files,
 * read each file line by line, and map the assistant/usage entries into
 * UsageRecord objects. For now this returns an empty list so the rest of the
 * pipeline runs.
 */
export async function loadUsageRecords(): Promise<UsageRecord[]> {
  // TODO: implement JSONL discovery + parsing here.
  return [];
}

/** Aggregate records into a single summary with an estimated cost. */
export function summarize(records: UsageRecord[]): UsageSummary {
  const tokens = { ...EMPTY_TOKENS };
  let costUsd = 0;
  for (const record of records) {
    tokens.input += record.tokens.input;
    tokens.output += record.tokens.output;
    tokens.cacheWrite += record.tokens.cacheWrite;
    tokens.cacheRead += record.tokens.cacheRead;
    costUsd += estimateCost(record.tokens, record.model);
  }
  return { tokens, costUsd, messageCount: records.length };
}

/** Keep only records whose timestamp falls on the current local day. */
export function filterToday(records: UsageRecord[]): UsageRecord[] {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const startMs = midnight.getTime();
  return records.filter((record) => record.timestamp >= startMs);
}
