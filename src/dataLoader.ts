import * as path from 'path';
import * as fs from 'fs';
import { UsageRecord, UsageSummary, EMPTY_TOKENS } from './types';
import { estimateCost, pricingForModel, cacheWriteRaw } from './pricing';
import { claudeConfigDir } from './paths';

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

export interface ParsedEntry {
  key: string;
  record: UsageRecord;
}

interface CachedFile {
  mtimeMs: number;
  size: number;
  // Byte offset through the last committed line; on growth only [parsedBytes, size) is re-read.
  parsedBytes: number;
  entries: ParsedEntry[];
  index: Map<string, number>;
  aiTitle?: string;
  lastPrompt?: string;
}

const fileCache = new Map<string, CachedFile>();
let lastRecords: UsageRecord[] | undefined;

// One shared instance per distinct string; model ids / cwds / sessions repeat across every record.
const internPool = new Map<string, string>();

function intern(value: string): string {
  const existing = internPool.get(value);
  if (existing !== undefined) {
    return existing;
  }
  internPool.set(value, value);
  return value;
}

export function claudeLogRoot(): string {
  return path.join(claudeConfigDir(), 'projects');
}

// undefined = a directory in the walk failed to read (an access blip), not "no files": the caller
// keeps last-good data instead of purging every file and publishing a dipped total.
export async function findJsonlFiles(root: string): Promise<string[] | undefined> {
  const files: string[] = [];
  return (await collectJsonl(root, files)) ? files : undefined;
}

async function collectJsonl(dir: string, files: string[]): Promise<boolean> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!(await collectJsonl(full, files))) {
        return false;
      }
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(full);
    }
  }
  return true;
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
  // Interim streamed lines carry a placeholder output_tokens; dedupe to the last settled occurrence.
  let key = '';
  if (messageId || requestId) {
    key = `${messageId}|${requestId}`;
  } else if (typeof entry.uuid === 'string') {
    key = `uuid:${entry.uuid}`;
  }

  const cwd = typeof entry.cwd === 'string' && entry.cwd ? intern(entry.cwd) : undefined;
  const session = typeof entry.sessionId === 'string' && entry.sessionId ? intern(entry.sessionId) : undefined;
  const branch = typeof entry.gitBranch === 'string' && entry.gitBranch ? intern(entry.gitBranch) : undefined;
  const record: UsageRecord = {
    timestamp,
    model: intern(model),
    tokens: {
      input: toCount(usage.input_tokens),
      output: toCount(usage.output_tokens),
      cacheWrite: toCount(usage.cache_creation_input_tokens),
      cacheWrite1h: toCount(usage.cache_creation?.ephemeral_1h_input_tokens),
      cacheRead: toCount(usage.cache_read_input_tokens),
    },
    project: cwd ? intern(path.basename(cwd)) : undefined,
    cwd,
    session,
    branch,
  };
  return { key, record };
}

interface ParseState {
  entries: ParsedEntry[];
  index: Map<string, number>;
  aiTitle?: string;
  lastPrompt?: string;
}

function newParseState(): ParseState {
  return { entries: [], index: new Map() };
}

// false only for a non-empty line that isn't valid JSON (a truncated mid-write tail — don't consume).
function parseLine(state: ParseState, line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return true;
  }
  let raw: any;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (raw.type === 'ai-title') {
    if (typeof raw.aiTitle === 'string' && raw.aiTitle) {
      state.aiTitle = raw.aiTitle;
    }
    return true;
  }
  if (raw.type === 'last-prompt') {
    if (typeof raw.lastPrompt === 'string' && raw.lastPrompt) {
      state.lastPrompt = raw.lastPrompt;
    }
    return true;
  }
  const parsed = parseUsageEntry(raw);
  if (!parsed) {
    return true;
  }
  if (parsed.key) {
    const at = state.index.get(parsed.key);
    if (at !== undefined) {
      state.entries[at] = parsed;
      return true;
    }
    state.index.set(parsed.key, state.entries.length);
  }
  state.entries.push(parsed);
  return true;
}

function titleOf(state: { aiTitle?: string; lastPrompt?: string }): string | undefined {
  return state.aiTitle ?? (state.lastPrompt ? truncate(state.lastPrompt, 70) : undefined);
}

function applyTitleTo(entries: ParsedEntry[], title: string | undefined): void {
  if (!title) {
    return;
  }
  const shared = intern(title);
  for (const entry of entries) {
    entry.record.sessionTitle = shared;
  }
}

function applyTitle(state: ParseState): void {
  applyTitleTo(state.entries, titleOf(state));
}

export function parseEntries(text: string): ParsedEntry[] {
  const state = newParseState();
  for (const line of text.split('\n')) {
    parseLine(state, line);
  }
  applyTitle(state);
  return state.entries;
}

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const READ_CHUNK_BYTES = 1 << 20;
const PARSE_YIELD_LINES = 10_000;

// Parse [start, end) into a FRESH state, returning the byte offset consumed. Whole lines commit;
// a trailing no-newline segment commits only if it parses (else it's a partial mid-write tail).
// Chunked with a periodic yield so a cold multi-hundred-MB file can't stall the host.
async function parseRange(handle: fs.promises.FileHandle, start: number, end: number, state: ParseState): Promise<number> {
  let offset = start;
  let consumed = start;
  let carry: Buffer = Buffer.alloc(0);
  let linesSinceYield = 0;
  while (offset < end) {
    const length = Math.min(READ_CHUNK_BYTES, end - offset);
    const { bytesRead, buffer } = await handle.read({
      buffer: Buffer.allocUnsafe(length),
      position: offset,
      length,
    });
    if (bytesRead <= 0) {
      break; // file shrank mid-read; the next pass's size check re-parses
    }
    offset += bytesRead;
    const chunk = buffer.subarray(0, bytesRead);
    const combined = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    // 0x0A never appears inside a multi-byte UTF-8 char, so splitting on the byte is safe.
    const lastNewline = combined.lastIndexOf(0x0a);
    if (lastNewline === -1) {
      carry = combined;
      continue;
    }
    const complete = combined.subarray(0, lastNewline);
    carry = combined.subarray(lastNewline + 1);
    consumed = offset - carry.length;
    for (const line of complete.toString('utf8').split('\n')) {
      parseLine(state, line);
      if (++linesSinceYield >= PARSE_YIELD_LINES) {
        linesSinceYield = 0;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }
  if (carry.length && parseLine(state, carry.toString('utf8'))) {
    consumed = offset;
  }
  return consumed;
}

// True when `offset` still sits on a line boundary — distinguishes a real append from a
// truncate-then-regrow rewrite (which grew past the old size but would resume mid-line).
async function endsOnBoundary(handle: fs.promises.FileHandle, offset: number): Promise<boolean> {
  if (offset <= 0) {
    return false;
  }
  const buf = Buffer.allocUnsafe(1);
  const { bytesRead } = await handle.read({ buffer: buf, position: offset - 1, length: 1 });
  return bytesRead === 1 && buf[0] === 0x0a;
}

// Fold a cleanly-parsed tail into the cached entries/index in place; keyed dups replace via the index.
function mergeTail(base: CachedFile, tail: ParseState): void {
  for (const entry of tail.entries) {
    if (entry.key) {
      const at = base.index.get(entry.key);
      if (at !== undefined) {
        base.entries[at] = entry;
        continue;
      }
      base.index.set(entry.key, base.entries.length);
    }
    base.entries.push(entry);
  }
  if (tail.aiTitle) {
    base.aiTitle = tail.aiTitle;
  }
  if (tail.lastPrompt) {
    base.lastPrompt = tail.lastPrompt;
  }
}

// Tail-parse appended bytes and fold them in (JSONL is append-only); anything else — cold,
// truncated, or rewritten — is a full re-parse. Parsing goes into a throwaway state committed
// only on success, so a read blip (a Windows lock/permission mid-write) leaves the cache untouched.
async function refreshFile(file: string, st: fs.Stats, cached: CachedFile | undefined): Promise<CachedFile | undefined> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, 'r');
  } catch {
    return cached;
  }
  try {
    const canTail = cached !== undefined && st.size > cached.size && (await endsOnBoundary(handle, cached.parsedBytes));
    const tail = newParseState();
    let parsedBytes: number;
    try {
      parsedBytes = await parseRange(handle, canTail ? cached!.parsedBytes : 0, st.size, tail);
    } catch {
      return cached;
    }
    if (canTail && cached) {
      mergeTail(cached, tail);
      cached.mtimeMs = st.mtimeMs;
      cached.size = st.size;
      cached.parsedBytes = parsedBytes;
      applyTitleTo(cached.entries, titleOf(cached));
      return cached;
    }
    applyTitle(tail);
    return {
      mtimeMs: st.mtimeMs,
      size: st.size,
      parsedBytes,
      entries: tail.entries,
      index: tail.index,
      aiTitle: tail.aiTitle,
      lastPrompt: tail.lastPrompt,
    };
  } finally {
    try {
      await handle.close();
    } catch {
      // ignore
    }
  }
}

export async function loadUsageRecords(): Promise<UsageRecord[]> {
  const files = await findJsonlFiles(claudeLogRoot());
  if (files === undefined) {
    // Root walk failed: serve the last good snapshot rather than publishing zeros.
    return lastRecords ?? [];
  }
  const present = new Set(files);
  let changed = lastRecords === undefined;
  for (const known of fileCache.keys()) {
    if (!present.has(known)) {
      fileCache.delete(known);
      changed = true;
    }
  }

  const stats = await Promise.all(files.map((file) => fs.promises.stat(file).catch(() => undefined)));

  const results: CachedFile[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const st = stats[i];
    const cached = fileCache.get(file);
    if (!st) {
      // A stat blip on an already-parsed file must not dip totals; reuse its cached entries.
      if (cached) {
        results.push(cached);
      }
      continue;
    }
    if (cached && st.mtimeMs === cached.mtimeMs && st.size === cached.size) {
      results.push(cached);
      continue;
    }
    changed = true;
    const fresh = await refreshFile(file, st, cached);
    if (fresh) {
      fileCache.set(file, fresh);
      results.push(fresh);
    } else if (cached) {
      results.push(cached);
    }
  }

  // Nothing changed: skip the O(all-records) flatten and reuse the last snapshot.
  if (!changed && lastRecords) {
    return lastRecords;
  }
  const seen = new Set<string>();
  const records: UsageRecord[] = [];
  for (const cached of results) {
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
  lastRecords = records;
  return records;
}

export function summarize(records: UsageRecord[]): UsageSummary {
  const tokens = { ...EMPTY_TOKENS };
  let costUsd = 0;
  for (const record of records) {
    tokens.input += record.tokens.input;
    tokens.output += record.tokens.output;
    tokens.cacheWrite += record.tokens.cacheWrite;
    tokens.cacheWrite1h += record.tokens.cacheWrite1h;
    tokens.cacheRead += record.tokens.cacheRead;
    costUsd += estimateCost(record.tokens, record.model);
  }
  return { tokens, costUsd, messageCount: records.length };
}

export interface CostParts {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export function costBreakdown(records: UsageRecord[]): CostParts {
  const parts: CostParts = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  for (const record of records) {
    const p = pricingForModel(record.model);
    parts.input += (record.tokens.input * p.input) / 1_000_000;
    parts.output += (record.tokens.output * p.output) / 1_000_000;
    parts.cacheWrite += cacheWriteRaw(record.tokens, p) / 1_000_000;
    parts.cacheRead += (record.tokens.cacheRead * p.cacheRead) / 1_000_000;
  }
  return parts;
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

export interface TrendBucket {
  key: string;
  startMs: number;
  summary: UsageSummary;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function dayKeyOf(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function monthKeyOf(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

function bucketBy(records: UsageRecord[], keyOf: (date: Date) => string): Map<string, UsageRecord[]> {
  const buckets = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const key = keyOf(new Date(record.timestamp));
    const list = buckets.get(key);
    if (list) {
      list.push(record);
    } else {
      buckets.set(key, [record]);
    }
  }
  return buckets;
}

// Daily buckets, 1st through today, empty days filled. Each day is built from its index (not a
// cursor): a non-existent spring-forward midnight would otherwise stick at 01:00 and drop today.
export function summarizeDaily(records: UsageRecord[], now = new Date()): TrendBucket[] {
  const buckets = bucketBy(records, dayKeyOf);
  const year = now.getFullYear();
  const month = now.getMonth();
  const result: TrendBucket[] = [];
  for (let d = 1; d <= now.getDate(); d++) {
    const day = new Date(year, month, d);
    const key = dayKeyOf(day);
    result.push({ key, startMs: day.getTime(), summary: summarize(buckets.get(key) ?? []) });
  }
  return result;
}

// Monthly buckets, earliest record's month through now, gaps filled; built by index (see summarizeDaily).
export function summarizeMonthly(records: UsageRecord[], now = new Date()): TrendBucket[] {
  if (records.length === 0) {
    return [];
  }
  const buckets = bucketBy(records, monthKeyOf);
  let earliest = Infinity;
  for (const record of records) {
    earliest = Math.min(earliest, record.timestamp);
  }
  const first = new Date(earliest);
  const startYear = first.getFullYear();
  const startMonth = first.getMonth();
  const months = (now.getFullYear() - startYear) * 12 + (now.getMonth() - startMonth);
  const result: TrendBucket[] = [];
  for (let i = 0; i <= months; i++) {
    const monthDate = new Date(startYear, startMonth + i, 1);
    const key = monthKeyOf(monthDate);
    result.push({ key, startMs: monthDate.getTime(), summary: summarize(buckets.get(key) ?? []) });
  }
  return result;
}

// Logs sometimes drop the [1m] marker; a prompt over the base window is itself proof of the 1M tier.
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

const gitRootCache = new Map<string, string | null>();

function gitRootFor(cwd: string): string | null {
  const seen: string[] = [];
  let dir = cwd;
  for (;;) {
    if (gitRootCache.has(dir)) {
      const cached = gitRootCache.get(dir) ?? null;
      for (const s of seen) {
        gitRootCache.set(s, cached);
      }
      return cached;
    }
    seen.push(dir);
    let isRepo = false;
    try {
      isRepo = fs.existsSync(path.join(dir, '.git'));
    } catch {
      isRepo = false;
    }
    if (isRepo) {
      for (const s of seen) {
        gitRootCache.set(s, dir);
      }
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      for (const s of seen) {
        gitRootCache.set(s, null);
      }
      return null;
    }
    dir = parent;
  }
}

// Fold case for grouping keys only where the filesystem does (Windows/macOS); on Linux
// /dev/API and /dev/api are distinct projects. Display labels keep their original case.
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

function foldCase(value: string): string {
  return CASE_INSENSITIVE_FS ? value.toLowerCase() : value;
}

function normalizeKey(p: string): string {
  return foldCase(p).replace(/[\\/]+/g, '/').replace(/\/+$/, '');
}

function projectGroup(record: UsageRecord, mode: string): { key: string; label: string; path?: string } {
  const cwd = record.cwd;
  if (!cwd) {
    const name = record.project ?? 'unknown';
    return { key: foldCase(name), label: name };
  }
  if (mode === 'flat') {
    return { key: normalizeKey(cwd), label: path.basename(cwd), path: cwd };
  }
  if (mode === 'git') {
    const root = gitRootFor(cwd) ?? cwd;
    return { key: normalizeKey(root), label: path.basename(root), path: root };
  }
  const base = path.basename(cwd);
  return { key: foldCase(base), label: base };
}

export function summarizeByProject(records: UsageRecord[], mode = 'git'): GroupSummary[] {
  const groups = new Map<string, { label: string; path?: string; records: UsageRecord[] }>();
  for (const record of records) {
    const { key, label, path: groupPath } = projectGroup(record, mode);
    const existing = groups.get(key);
    if (existing) {
      existing.records.push(record);
    } else {
      groups.set(key, { label, path: groupPath, records: [record] });
    }
  }
  const labelCounts = new Map<string, number>();
  for (const group of groups.values()) {
    labelCounts.set(group.label, (labelCounts.get(group.label) ?? 0) + 1);
  }
  return [...groups.values()]
    .map((group) => {
      let label = group.label;
      if ((labelCounts.get(group.label) ?? 0) > 1 && group.path) {
        const parent = path.basename(path.dirname(group.path));
        if (parent) {
          label = `${group.label} (${parent})`;
        }
      }
      return { key: label, summary: summarize(group.records) };
    })
    .sort((a, b) => b.summary.costUsd - a.summary.costUsd);
}

export interface BranchSummary {
  branch: string;
  project: string;
  summary: UsageSummary;
}

export function summarizeByBranch(records: UsageRecord[]): BranchSummary[] {
  const groups = new Map<string, { branch: string; project: string; records: UsageRecord[] }>();
  for (const record of records) {
    if (!record.branch) {
      continue;
    }
    const project = record.project ?? 'unknown';
    const key = `${foldCase(project)}\u0000${record.branch}`;
    const existing = groups.get(key);
    if (existing) {
      existing.records.push(record);
    } else {
      groups.set(key, { branch: record.branch, project, records: [record] });
    }
  }
  return [...groups.values()]
    .map((group) => ({ branch: group.branch, project: group.project, summary: summarize(group.records) }))
    .sort((a, b) => b.summary.costUsd - a.summary.costUsd);
}

export interface SessionSummary {
  session: string;
  title: string;
  project: string;
  startMs: number;
  endMs: number;
  activeMs: number;
  peakContextPct: number;
  summary: UsageSummary;
}

// Gaps longer than this are treated as the session being put down and resumed,
// not active work, so they are excluded from the active-time total.
const ACTIVE_GAP_MS = 15 * 60 * 1000;

export function summarizeBySession(records: UsageRecord[]): SessionSummary[] {
  const groups = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const key = record.session;
    if (!key) {
      continue;
    }
    const list = groups.get(key);
    if (list) {
      list.push(record);
    } else {
      groups.set(key, [record]);
    }
  }
  const sessions: SessionSummary[] = [];
  for (const [session, group] of groups) {
    let startMs = Infinity;
    let endMs = -Infinity;
    let peak = 0;
    let title: string | undefined;
    let project: string | undefined;
    for (const record of group) {
      startMs = Math.min(startMs, record.timestamp);
      endMs = Math.max(endMs, record.timestamp);
      if (!title && record.sessionTitle) {
        title = record.sessionTitle;
      }
      if (!project && record.project) {
        project = record.project;
      }
      const ctx = record.tokens.input + record.tokens.cacheRead + record.tokens.cacheWrite;
      if (ctx > 0) {
        peak = Math.max(peak, (ctx / contextWindowFor(record.model, ctx)) * 100);
      }
    }
    const times = group.map((record) => record.timestamp).sort((a, b) => a - b);
    let activeMs = 0;
    for (let i = 1; i < times.length; i++) {
      const gap = times[i] - times[i - 1];
      if (gap <= ACTIVE_GAP_MS) {
        activeMs += gap;
      }
    }
    sessions.push({
      session,
      title: title ?? formatSessionStart(startMs),
      project: project ?? 'unknown',
      startMs,
      endMs,
      activeMs,
      peakContextPct: peak,
      summary: summarize(group),
    });
  }
  return sessions.sort((a, b) => b.summary.costUsd - a.summary.costUsd);
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) {
    return '<1m';
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatSessionStart(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return 'session';
  }
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
