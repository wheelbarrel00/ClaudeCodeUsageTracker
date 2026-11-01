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
  weeklyShare?: number;
}

export interface ExtraUsage {
  isEnabled: boolean;
  usedCredits?: number; // minor units (e.g. cents)
  monthlyLimit?: number;
  utilization?: number;
  currency?: string;
  decimalPlaces?: number;
}

export interface PlanLimits {
  fiveHour?: LimitWindow;
  sevenDay?: LimitWindow;
  scoped: ScopedLimit[];
  extraUsage?: ExtraUsage;
  fetchedAt?: number;
  // Separate from fiveHour, which is also undefined when a reading has merely gone stale.
  hasSessionLimit: boolean;
}

const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_PAYLOAD_AGE_MS = SEVEN_DAY_MS;

const ROLLOVER_GRACE_MS = 15 * 60 * 1000;

// A future timestamp is clock skew: its negative age would clear every gate below.
const CLOCK_SKEW_MS = 60 * 1000;

export type SeverityBand = 'normal' | 'warning' | 'error';

export function severityBand(window: LimitWindow, thresholds: number[]): SeverityBand {
  if (window.severity === 'critical' || window.severity === 'error') {
    return 'error';
  }
  const shown = Math.round(window.utilization);
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

  // The rows say which limits apply, so weekly rows with no session row mean no 5-hour limit.
  const hasSessionRow = byKind.has('session');
  const hasWeeklyRows = byKind.has('weekly_all') || scopedRaw.length > 0;
  const session =
    windowFromLimit(byKind.get('session')) ??
    (hasSessionRow || !hasWeeklyRows ? windowFromTop(data.five_hour) : undefined);
  const hasSessionLimit = hasSessionRow || (!hasWeeklyRows && data.five_hour !== null);
  const fiveHour = applyExpiry(session, now, 0, fetchedAt);
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
        weeklyShare: weeklyShareOf(data, entry),
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
  return { fiveHour, sevenDay, scoped, extraUsage, fetchedAt, hasSessionLimit };
}

export function topScoped(limits: PlanLimits): ScopedLimit | undefined {
  return limits.scoped.reduce<ScopedLimit | undefined>(
    (top, scoped) => (!top || scoped.utilization > top.utilization ? scoped : top),
    undefined
  );
}

export function formatWeeklyShare(limit: ScopedLimit): string {
  const share = Math.round(limit.weeklyShare ?? 0);
  return share > 0 ? `Up to ${share}% of your weekly limit` : '';
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

// rollMs > 0 projects the next weekly boundary; 0 clears the 5-hour window's unknown reset.
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
  const name = scope?.model?.display_name || scope?.surface?.display_name;
  return typeof name === 'string' && name ? name : 'Scoped';
}

function weeklyShareOf(data: any, entry: any): number | undefined {
  if (!Array.isArray(data.weekly_scoped_shares)) {
    return undefined;
  }
  const index = data.limits.indexOf(entry);
  const share = data.weekly_scoped_shares.find((candidate: any) => candidate?.limit_index === index);
  return num(share?.allowance_percent_of_weekly);
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
