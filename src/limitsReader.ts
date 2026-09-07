import * as path from 'path';
import * as fs from 'fs';
import { claudeConfigDir } from './paths';

export type Severity = string;

export interface LimitWindow {
  utilization: number;
  resetsAt?: number;
  severity: Severity;
}

export interface ScopedLimit extends LimitWindow {
  label: string;
}

export interface ExtraUsage {
  isEnabled: boolean;
  usedCredits?: number; // minor units (e.g. cents)
  monthlyLimit?: number; // minor units
  utilization?: number; // 0-100
  currency?: string;
  decimalPlaces?: number; // minor-unit exponent
}

export interface PlanLimits {
  fiveHour?: LimitWindow;
  sevenDay?: LimitWindow;
  scoped: ScopedLimit[];
  extraUsage?: ExtraUsage;
  fetchedAt?: number;
}

const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

// One full weekly period: past it every window has necessarily rolled over at least once, so
// nothing in the payload can describe the present.
const MAX_PAYLOAD_AGE_MS = SEVEN_DAY_MS;

// Utilization is 0 only at the instant a window rolls over, so reporting a rolled-over
// window as empty is honest solely as a bridge from that reset to the next fetch.
const ROLLOVER_GRACE_MS = 15 * 60 * 1000;

// A future timestamp is clock skew, not freshness: a negative age exceeds no limit and would
// clear every gate below. Matches the skew tolerance in usageApi's shared-cache reader.
const CLOCK_SKEW_MS = 60 * 1000;

export type SeverityBand = 'normal' | 'warning' | 'error';

// One severity->color rule for both the status bar and dashboard. Bands come from the user's warn
// thresholds (warning = first, error = last); the API severity only escalates, unknown strings ignored.
export function severityBand(window: LimitWindow, thresholds: number[]): SeverityBand {
  if (window.severity === 'critical' || window.severity === 'error') {
    return 'error';
  }
  const shown = Math.round(window.utilization);
  // Thresholds can be emptied entirely from settings; an exhausted window is never green.
  if (shown >= 100) {
    return 'error';
  }
  let band: SeverityBand = 'normal';
  if (thresholds.length > 0) {
    if (shown >= thresholds[thresholds.length - 1]) {
      band = 'error';
    } else if (shown >= thresholds[0]) {
      band = 'warning';
    }
  }
  if (band === 'normal' && window.severity === 'warning') {
    return 'warning';
  }
  return band;
}

export function usageCachePath(): string {
  return path.join(claudeConfigDir(), 'usage-cache.json');
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
  const fetchedAt = num(raw?.fetchedAt);
  if (fetchedAt === undefined) {
    return undefined;
  }
  return mapUsageData(raw?.data, fetchedAt);
}

// Maps the raw usage payload (the `data` object Claude Code writes to usage-cache.json, which is
// also the body the live /api/oauth/usage endpoint returns) into PlanLimits. Pure and I/O-free so
// both the cache reader and the live fetcher share one parser.
export function mapUsageData(data: any, fetchedAt: number): PlanLimits | undefined {
  if (!data || typeof data !== 'object') {
    return undefined;
  }

  const now = Date.now();
  // NaN compares false against every bound, so reject it explicitly.
  const age = now - fetchedAt;
  if (!Number.isFinite(age) || age > MAX_PAYLOAD_AGE_MS || age < -CLOCK_SKEW_MS) {
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

  const fiveHour = applyExpiry(windowFromLimit(byKind.get('session')) ?? windowFromTop(data.five_hour), now, 0, fetchedAt);
  const sevenDay = applyExpiry(
    windowFromLimit(byKind.get('weekly_all')) ?? windowFromTop(data.seven_day),
    now,
    SEVEN_DAY_MS,
    fetchedAt
  );

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
      SEVEN_DAY_MS,
      fetchedAt
    );
    if (win) {
      scoped.push(win);
    }
  }
  if (scoped.length === 0) {
    pushTopScoped(scoped, 'Opus', data.seven_day_opus, now, fetchedAt);
    pushTopScoped(scoped, 'Sonnet', data.seven_day_sonnet, now, fetchedAt);
  }

  const extraUsage = parseExtraUsage(data.extra_usage);

  if (!fiveHour && !sevenDay && scoped.length === 0 && !extraUsage) {
    return undefined;
  }
  return { fiveHour, sevenDay, scoped, extraUsage, fetchedAt };
}

function parseExtraUsage(raw: any): ExtraUsage | undefined {
  if (!raw || typeof raw !== 'object' || raw.is_enabled !== true) {
    return undefined;
  }
  return {
    isEnabled: true,
    usedCredits: num(raw.used_credits),
    monthlyLimit: num(raw.monthly_limit),
    utilization: num(raw.utilization),
    currency: typeof raw.currency === 'string' && raw.currency ? raw.currency : undefined,
    decimalPlaces: num(raw.decimal_places),
  };
}

// Formats extra-usage spend as "$3.50" or "$3.50 / $50.00" (used / monthly cap).
// Anthropic reports money as minor units + an exponent (decimal_places).
export function formatExtraSpend(extra: ExtraUsage): string {
  if (extra.usedCredits === undefined) {
    return '';
  }
  const exponent = Math.min(100, Math.max(0, Math.round(extra.decimalPlaces ?? 2)));
  const divisor = Math.pow(10, exponent);
  const currency = extra.currency ?? 'USD';
  const money = (minor: number): string => {
    const value = minor / divisor;
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value);
    } catch {
      return `$${value.toFixed(exponent)}`;
    }
  };
  const cap = extra.monthlyLimit !== undefined ? ` / ${money(extra.monthlyLimit)}` : '';
  return `${money(extra.usedCredits)}${cap}`;
}

// A window whose reset time has passed rolled over since the data was fetched, so the old
// utilization no longer applies. "Empty" holds only while both the rollover and the fetch are
// recent (see ROLLOVER_GRACE_MS); beyond that it is dropped rather than guessed at 0%.
// rollMs > 0 projects the weekly boundary; rollMs = 0 clears the 5-hour window's unknown reset.
function applyExpiry<T extends LimitWindow>(
  window: T | undefined,
  now: number,
  rollMs: number,
  fetchedAt: number
): T | undefined {
  if (!window || window.resetsAt === undefined || window.resetsAt > now) {
    return window;
  }
  const lastBoundary =
    rollMs > 0
      ? window.resetsAt + Math.floor((now - window.resetsAt) / rollMs) * rollMs
      : window.resetsAt;
  if (now - Math.max(fetchedAt, lastBoundary) > ROLLOVER_GRACE_MS) {
    return undefined;
  }
  return {
    ...window,
    utilization: 0,
    severity: 'normal',
    resetsAt: rollMs > 0 ? lastBoundary + rollMs : undefined,
  };
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

function pushTopScoped(out: ScopedLimit[], label: string, raw: any, now: number, fetchedAt: number): void {
  const win = windowFromTop(raw);
  if (win) {
    const scoped = applyExpiry<ScopedLimit>({ label, ...win }, now, SEVEN_DAY_MS, fetchedAt);
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
