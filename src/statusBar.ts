import * as vscode from 'vscode';
import { UsageSummary } from './types';
import { PlanLimits, LimitWindow, ScopedLimit, formatReset } from './limitsReader';

const CONFIG_SECTION = 'claudeCodeUsageTracker';

/** Owns the status-bar presentation for the extension. */
export class StatusBarController {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = `${CONFIG_SECTION}.showDashboard`;
    this.item.tooltip = 'Claude Code Usage Tracker';
    this.item.text = '$(graph) Claude usage';
    this.item.show();
  }

  /** Render a usage summary, honouring the user's display settings. */
  render(summary: UsageSummary, limits?: PlanLimits): void {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const showLimits = cfg.get<boolean>('showLimits', true);
    const showOpusWeekly = cfg.get<boolean>('showOpusWeekly', false);
    const showCost = cfg.get<boolean>('showCost', true);
    const showTokens = cfg.get<boolean>('showTokens', true);
    const decimals = cfg.get<number>('decimalPlaces', 2);
    const currency = cfg.get<string>('currency', 'USD');

    const parts: string[] = [];
    let rank = 0;
    if (showLimits && limits) {
      const opus = showOpusWeekly ? opusWindow(limits) : undefined;
      const seg = formatLimits(limits, opus);
      if (seg) {
        parts.push(seg);
      }
      rank = Math.max(
        severityRank(limits.fiveHour?.severity),
        severityRank(limits.sevenDay?.severity),
        opus ? severityRank(opus.severity) : 0
      );
    }
    if (showCost) {
      parts.push(formatCurrency(summary.costUsd, currency, decimals));
    }
    if (showTokens) {
      parts.push(`${formatTokens(totalTokens(summary))} tok`);
    }

    const icon = rank >= 2 ? '$(error)' : rank >= 1 ? '$(warning)' : '$(graph)';
    this.item.text = `${icon} ${parts.join('  ') || 'Claude usage'}`;
    this.item.backgroundColor =
      rank >= 2
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : rank >= 1
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
    this.item.tooltip = showLimits ? buildTooltip(limits) : 'Claude Code Usage Tracker';
  }

  dispose(): void {
    this.item.dispose();
  }
}

function formatLimits(limits: PlanLimits, opus?: LimitWindow): string {
  const segs: string[] = [];
  if (limits.fiveHour) {
    segs.push(`5h ${Math.round(limits.fiveHour.utilization)}%`);
  }
  if (limits.sevenDay) {
    segs.push(`wk ${Math.round(limits.sevenDay.utilization)}%`);
  }
  if (opus) {
    segs.push(`opus ${Math.round(opus.utilization)}%`);
  }
  return segs.join(' · ');
}

function opusWindow(limits: PlanLimits): ScopedLimit | undefined {
  return limits.scoped.find((scoped) => /opus/i.test(scoped.label));
}

function buildTooltip(limits?: PlanLimits): string {
  if (!limits) {
    return 'Claude Code Usage Tracker';
  }
  const lines = ['Claude plan limits'];
  if (limits.fiveHour) {
    lines.push(limitLine('5h', limits.fiveHour));
  }
  if (limits.sevenDay) {
    lines.push(limitLine('Week', limits.sevenDay));
  }
  for (const scoped of limits.scoped) {
    lines.push(limitLine(scoped.label, scoped));
  }
  return lines.length > 1 ? lines.join('\n') : 'Claude Code Usage Tracker';
}

function limitLine(label: string, window: LimitWindow): string {
  const reset = formatReset(window.resetsAt);
  const pct = `${Math.round(window.utilization)}%`;
  return reset ? `${label}: ${pct}  ·  ${reset}` : `${label}: ${pct}`;
}

function severityRank(severity?: string): number {
  switch (severity) {
    case 'critical':
    case 'error':
      return 2;
    case undefined:
    case 'normal':
      return 0;
    default:
      return 1;
  }
}

function totalTokens(summary: UsageSummary): number {
  const t = summary.tokens;
  return t.input + t.output + t.cacheWrite + t.cacheRead;
}

function formatCurrency(value: number, currency: string, decimals: number): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value);
  } catch {
    return `$${value.toFixed(decimals)}`;
  }
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}k`;
  }
  return String(count);
}
