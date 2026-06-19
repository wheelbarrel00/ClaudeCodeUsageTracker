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

export interface ContextInfo {
  tokens: number;
  windowTokens: number;
  model: string;
  percent: number;
}

const CONTEXT_RECENCY_MS = 5 * 60 * 60 * 1000;

interface ParsedEntry {
  key: string;
  record: UsageRecord;
}

interface CachedFile {
  mtimeMs: number;
  entries: ParsedEntry[];
}

const fileCache = new Map<string, CachedFile>();

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

async function parseFile(file: string): Promise<ParsedEntry[]> {
  let text: string;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const entries: ParsedEntry[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let raw: any;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const parsed = parseUsageEntry(raw);
    if (!parsed) {
      continue;
    }
    if (parsed.key && seen.has(parsed.key)) {
      continue;
    }
    if (parsed.key) {
      seen.add(parsed.key);
    }
    entries.push(parsed);
  }
  return entries;
}

export async function loadUsageRecords(): Promise<UsageRecord[]> {
  const files = await findJsonlFiles(claudeLogRoot());
  const present = new Set(files);
  for (const cached of fileCache.keys()) {
    if (!present.has(cached)) {
      fileCache.delete(cached);
    }
  }

  const seen = new Set<string>();
  const records: UsageRecord[] = [];
  for (const file of files) {
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.promises.stat(file)).mtimeMs;
    } catch {
      continue;
    }
    let cached = fileCache.get(file);
    if (!cached || cached.mtimeMs !== mtimeMs) {
      cached = { mtimeMs, entries: await parseFile(file) };
      fileCache.set(file, cached);
    }
    for (const { key, record } of cached.entries) {
      if (key) {
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
      }
      records.push(record);
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

// Logs sometimes drop the [1m] marker, so a prompt larger than the base
// window is itself proof of the 1M tier.
function contextWindowFor(model: string, tokens: number): number {
  return model.includes('[1m]') || tokens > 200_000 ? 1_000_000 : 200_000;
}

export function currentContext(records: UsageRecord[], now = Date.now()): ContextInfo | undefined {
  let latest: UsageRecord | undefined;
  for (const record of records) {
    const tokens = record.tokens.input + record.tokens.cacheRead + record.tokens.cacheWrite;
    if (tokens <= 0) {
      continue;
    }
    if (!latest || record.timestamp > latest.timestamp) {
      latest = record;
    }
  }
  if (!latest || now - latest.timestamp > CONTEXT_RECENCY_MS) {
    return undefined;
  }
  const tokens = latest.tokens.input + latest.tokens.cacheRead + latest.tokens.cacheWrite;
  const windowTokens = contextWindowFor(latest.model, tokens);
  return { tokens, windowTokens, model: latest.model, percent: (tokens / windowTokens) * 100 };
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
