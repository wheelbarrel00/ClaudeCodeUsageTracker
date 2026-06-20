import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

export type Severity = string;

export interface LimitWindow {
  utilization: number;
  resetsAt?: number;
  severity: Severity;
}

export interface ScopedLimit extends LimitWindow {
  label: string;
}

export interface PlanLimits {
  fiveHour?: LimitWindow;
  sevenDay?: LimitWindow;
  scoped: ScopedLimit[];
  fetchedAt?: number;
}

const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

export function usageCachePath(): string {
  return path.join(os.homedir(), '.claude', 'usage-cache.json');
}

export async function loadPlanLimits(): Promise<PlanLimits | undefined> {
  let text: string;
  try {
    text = await fs.promises.readFile(usageCachePath(), 'utf8');
  } catch {
    return undefined;
  }
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  return mapUsageData(raw?.data, num(raw?.fetchedAt));
}

// Maps the raw usage payload (the `data` object Claude Code writes to
// usage-cache.json, which is also the body the live /api/oauth/usage endpoint
// returns) into PlanLimits. Pure and I/O-free so both the cache reader and the
// live fetcher share one parser.
export function mapUsageData(data: any, fetchedAt?: number): PlanLimits | undefined {
  if (!data || typeof data !== 'object') {
    return undefined;
  }

  const byKind = new Map<string, any>();
  const scopedRaw: any[] = [];
  if (Array.isArray(data.limits)) {
    for (const entry of data.limits) {
      if (!entry || typeof entry !== 'object' || typeof entry.kind !== 'string') {
        continue;
      }
      if (entry.kind === 'weekly_scoped') {
        scopedRaw.push(entry);
      } else if (!byKind.has(entry.kind)) {
        byKind.set(entry.kind, entry);
      }
    }
  }

  const now = Date.now();
  const fiveHour = applyExpiry(windowFromLimit(byKind.get('session')) ?? windowFromTop(data.five_hour), now, 0);
  const sevenDay = applyExpiry(windowFromLimit(byKind.get('weekly_all')) ?? windowFromTop(data.seven_day), now, SEVEN_DAY_MS);

  const scoped: ScopedLimit[] = [];
  for (const entry of scopedRaw) {
    const utilization = num(entry.percent);
    if (utilization === undefined) {
      continue;
    }
    const win = applyExpiry<ScopedLimit>(
      {
        label: scopeLabel(entry.scope),
        utilization: Math.max(0, utilization),
        resetsAt: parseResetsAt(entry.resets_at),
        severity: severityOf(entry.severity),
      },
      now,
      SEVEN_DAY_MS
    );
    if (win) {
      scoped.push(win);
    }
  }
  if (scoped.length === 0) {
    pushTopScoped(scoped, 'Opus', data.seven_day_opus, now);
    pushTopScoped(scoped, 'Sonnet', data.seven_day_sonnet, now);
  }

  if (!fiveHour && !sevenDay && scoped.length === 0) {
    return undefined;
  }
  return { fiveHour, sevenDay, scoped, fetchedAt };
}

// A window whose reset time has passed rolled over since the data was fetched,
// so the old utilization no longer applies: report a fresh, empty 0% window.
// rollMs > 0 projects the next weekly boundary (best-effort, assuming a fixed
// 7-day cadence); rollMs = 0 clears the reset for the usage-anchored 5-hour
// window, whose next reset is unknown until it is used again.
function applyExpiry<T extends LimitWindow>(window: T | undefined, now: number, rollMs: number): T | undefined {
  if (!window || window.resetsAt === undefined || window.resetsAt > now) {
    return window;
  }
  let resetsAt: number | undefined;
  if (rollMs > 0) {
    const periods = Math.floor((now - window.resetsAt) / rollMs) + 1;
    resetsAt = window.resetsAt + periods * rollMs;
  }
  return { ...window, utilization: 0, severity: 'normal', resetsAt };
}

export function formatAge(fetchedAt?: number, now = Date.now()): string {
  if (fetchedAt === undefined) {
    return '';
  }
  const ms = now - fetchedAt;
  if (ms < 90 * 1000) {
    return '';
  }
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatReset(resetsAt?: number): string {
  if (resetsAt === undefined) {
    return '';
  }
  const ms = resetsAt - Date.now();
  if (ms <= 0) {
    return ms < -60000 ? '' : 'resetting now';
  }
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) {
    return `resets in ${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `resets in ${hours}h ${minutes % 60}m`;
  }
  const days = Math.floor(hours / 24);
  return `resets in ${days}d ${hours % 24}h`;
}

function windowFromLimit(entry: any): LimitWindow | undefined {
  if (!entry) {
    return undefined;
  }
  const utilization = num(entry.percent);
  if (utilization === undefined) {
    return undefined;
  }
  return {
    utilization: Math.max(0, utilization),
    resetsAt: parseResetsAt(entry.resets_at),
    severity: severityOf(entry.severity),
  };
}

function windowFromTop(raw: any): LimitWindow | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const utilization = num(raw.utilization);
  if (utilization === undefined) {
    return undefined;
  }
  return {
    utilization: Math.max(0, utilization),
    resetsAt: parseResetsAt(raw.resets_at),
    severity: 'normal',
  };
}

function pushTopScoped(out: ScopedLimit[], label: string, raw: any, now: number): void {
  const win = windowFromTop(raw);
  if (win) {
    const scoped = applyExpiry<ScopedLimit>({ label, ...win }, now, SEVEN_DAY_MS);
    if (scoped) {
      out.push(scoped);
    }
  }
}

function scopeLabel(scope: any): string {
  const name = scope?.model?.display_name;
  return typeof name === 'string' && name ? name : 'Scoped';
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseResetsAt(value: unknown): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

function severityOf(value: unknown): Severity {
  return typeof value === 'string' && value ? value : 'normal';
}
