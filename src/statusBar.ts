import * as vscode from 'vscode';
import { UsageSummary } from './types';
import { ContextInfo } from './dataLoader';
import { PlanLimits, LimitWindow, ScopedLimit, formatReset } from './limitsReader';

const CONFIG_SECTION = 'claudeCodeUsageTracker';
const ICON = '$(ccut-claude)';

/** Owns the status-bar presentation for the extension. */
export class StatusBarController {
  private readonly fiveHour: vscode.StatusBarItem;
  private readonly weekly: vscode.StatusBarItem;
  private readonly opus: vscode.StatusBarItem;
  private readonly main: vscode.StatusBarItem;

  constructor() {
    this.fiveHour = this.createItem(104);
    this.weekly = this.createItem(103);
    this.opus = this.createItem(102);
    this.main = this.createItem(101);
    this.main.text = `${ICON} Claude usage`;
    this.main.show();
  }

  private createItem(priority: number): vscode.StatusBarItem {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, priority);
    item.command = `${CONFIG_SECTION}.showDashboard`;
    item.tooltip = 'Claude Code Usage Tracker';
    return item;
  }

  /** Render a usage summary, honouring the user's display settings. */
  render(summary: UsageSummary, limits?: PlanLimits, context?: ContextInfo): void {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const showLimits = cfg.get<boolean>('showLimits', true);
    const showOpusWeekly = cfg.get<boolean>('showOpusWeekly', false);
    const showContext = cfg.get<boolean>('showContext', true);
    const showCost = cfg.get<boolean>('showCost', true);
    const showTokens = cfg.get<boolean>('showTokens', true);
    const decimals = cfg.get<number>('decimalPlaces', 2);
    const currency = cfg.get<string>('currency', 'USD');

    const tooltip = buildTooltip(showLimits ? limits : undefined, showContext ? context : undefined);

    const live = showLimits ? limits : undefined;
    this.renderLimit(this.fiveHour, '5h', live?.fiveHour, tooltip);
    this.renderLimit(this.weekly, 'wk', live?.sevenDay, tooltip);
    this.renderLimit(this.opus, 'opus', showOpusWeekly && live ? opusWindow(live) : undefined, tooltip);

    const parts: string[] = [];
    if (showContext && context) {
      parts.push(`ctx ${Math.round(context.percent)}%`);
    }
    if (showCost) {
      parts.push(formatCurrency(summary.costUsd, currency, decimals));
    }
    if (showTokens) {
      parts.push(`${formatTokens(totalTokens(summary))} tok`);
    }
    if (parts.length) {
      this.main.text = parts.join('  ');
      this.main.tooltip = tooltip;
      this.main.show();
    } else {
      this.main.hide();
    }
  }

  private renderLimit(
    item: vscode.StatusBarItem,
    label: string,
    window: LimitWindow | undefined,
    tooltip: string
  ): void {
    if (!window) {
      item.hide();
      return;
    }
    item.text = `${ICON} ${label} ${Math.round(window.utilization)}%`;
    item.color = severityColor(window.severity);
    item.tooltip = tooltip;
    item.show();
  }

  dispose(): void {
    this.fiveHour.dispose();
    this.weekly.dispose();
    this.opus.dispose();
    this.main.dispose();
  }
}

function opusWindow(limits: PlanLimits): ScopedLimit | undefined {
  return limits.scoped.find((scoped) => /opus/i.test(scoped.label));
}

function severityColor(severity?: string): vscode.ThemeColor | undefined {
  switch (severity) {
    case 'critical':
    case 'error':
      return new vscode.ThemeColor('charts.red');
    case 'warning':
      return new vscode.ThemeColor('charts.yellow');
    case 'normal':
      return new vscode.ThemeColor('charts.green');
    default:
      return undefined;
  }
}

function buildTooltip(limits?: PlanLimits, context?: ContextInfo): string {
  const lines: string[] = [];
  if (limits) {
    const limitLines: string[] = [];
    if (limits.fiveHour) {
      limitLines.push(limitLine('5h', limits.fiveHour));
    }
    if (limits.sevenDay) {
      limitLines.push(limitLine('Week', limits.sevenDay));
    }
    for (const scoped of limits.scoped) {
      limitLines.push(limitLine(scoped.label, scoped));
    }
    if (limitLines.length) {
      lines.push('Claude plan limits', ...limitLines);
    }
  }
  if (context) {
    if (lines.length) {
      lines.push('');
    }
    lines.push(
      `Context: ${Math.round(context.percent)}%  ·  ${context.tokens.toLocaleString('en-US')} / ${context.windowTokens.toLocaleString('en-US')} tokens`
    );
  }
  return lines.length ? lines.join('\n') : 'Claude Code Usage Tracker';
}

function limitLine(label: string, window: LimitWindow): string {
  const reset = formatReset(window.resetsAt);
  const pct = `${Math.round(window.utilization)}%`;
  return reset ? `${label}: ${pct}  ·  ${reset}` : `${label}: ${pct}`;
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
