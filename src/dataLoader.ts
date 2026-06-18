import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { UsageRecord, UsageSummary, EMPTY_TOKENS } from './types';
import { estimateCost } from './pricing';

const SYNTHETIC_MODEL = '<synthetic>';

export interface GroupSummary {
  key: string;
  summary: UsageSummary;
}

export function claudeLogRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

async function findJsonlFiles(dir: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findJsonlFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(full);
    }
  }
  return files;
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseUsageEntry(entry: any): { key: string; record: UsageRecord } | null {
  if (!entry || entry.type !== 'assistant') {
    return null;
  }
  const message = entry.message;
  if (!message || typeof message !== 'object') {
    return null;
  }
  const usage = message.usage;
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  const model = message.model;
  if (typeof model !== 'string' || model === SYNTHETIC_MODEL) {
    return null;
  }
  const timestamp = Date.parse(entry.timestamp);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  const messageId = typeof message.id === 'string' ? message.id : '';
  const requestId = typeof entry.requestId === 'string' ? entry.requestId : '';
  // each message is logged once per content block, all repeating the same usage
  let key = '';
  if (messageId || requestId) {
    key = `${messageId}|${requestId}`;
  } else if (typeof entry.uuid === 'string') {
    key = `uuid:${entry.uuid}`;
  }

  const cwd = typeof entry.cwd === 'string' && entry.cwd ? entry.cwd : undefined;
  const record: UsageRecord = {
    timestamp,
    model,
    tokens: {
      input: toCount(usage.input_tokens),
      output: toCount(usage.output_tokens),
      cacheWrite: toCount(usage.cache_creation_input_tokens),
      cacheRead: toCount(usage.cache_read_input_tokens),
    },
    project: cwd ? path.basename(cwd) : undefined,
  };
  return { key, record };
}

export async function loadUsageRecords(): Promise<UsageRecord[]> {
  const files = await findJsonlFiles(claudeLogRoot());
  const seen = new Set<string>();
  const records: UsageRecord[] = [];

  for (const file of files) {
    let text: string;
    try {
      text = await fs.promises.readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let entry: any;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const parsed = parseUsageEntry(entry);
      if (!parsed) {
        continue;
      }
      if (parsed.key) {
        if (seen.has(parsed.key)) {
          continue;
        }
        seen.add(parsed.key);
      }
      records.push(parsed.record);
    }
  }
  return records;
}

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

export function filterToday(records: UsageRecord[]): UsageRecord[] {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const startMs = midnight.getTime();
  return records.filter((record) => record.timestamp >= startMs);
}

export function filterMonth(records: UsageRecord[]): UsageRecord[] {
  const now = new Date();
  const startMs = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return records.filter((record) => record.timestamp >= startMs);
}

export function summarizeByModel(records: UsageRecord[]): GroupSummary[] {
  return groupSummaries(records, (record) => record.model);
}

export function summarizeByProject(records: UsageRecord[]): GroupSummary[] {
  return groupSummaries(records, (record) => record.project ?? 'unknown');
}

function groupSummaries(
  records: UsageRecord[],
  keyOf: (record: UsageRecord) => string
): GroupSummary[] {
  const groups = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const key = keyOf(record);
    const list = groups.get(key);
    if (list) {
      list.push(record);
    } else {
      groups.set(key, [record]);
    }
  }
  return [...groups.entries()]
    .map(([key, group]) => ({ key, summary: summarize(group) }))
    .sort((a, b) => b.summary.costUsd - a.summary.costUsd);
}
