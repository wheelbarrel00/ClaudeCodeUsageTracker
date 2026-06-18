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
  const data = raw?.data;
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

  const fiveHour = windowFromLimit(byKind.get('session')) ?? windowFromTop(data.five_hour);
  const sevenDay = windowFromLimit(byKind.get('weekly_all')) ?? windowFromTop(data.seven_day);

  const scoped: ScopedLimit[] = [];
  for (const entry of scopedRaw) {
    const utilization = num(entry.percent);
    if (utilization === undefined) {
      continue;
    }
    scoped.push({
      label: scopeLabel(entry.scope),
      utilization: Math.max(0, utilization),
      resetsAt: parseResetsAt(entry.resets_at),
      severity: severityOf(entry.severity),
    });
  }
  if (scoped.length === 0) {
    pushTopScoped(scoped, 'Opus', data.seven_day_opus);
    pushTopScoped(scoped, 'Sonnet', data.seven_day_sonnet);
  }

  if (!fiveHour && !sevenDay && scoped.length === 0) {
    return undefined;
  }
  return { fiveHour, sevenDay, scoped, fetchedAt: num(raw.fetchedAt) };
}

export function formatReset(resetsAt?: number): string {
  if (resetsAt === undefined) {
    return '';
  }
  const ms = resetsAt - Date.now();
  if (ms <= 0) {
    return 'resetting now';
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

function pushTopScoped(out: ScopedLimit[], label: string, raw: any): void {
  const win = windowFromTop(raw);
  if (win) {
    out.push({ label, ...win });
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
