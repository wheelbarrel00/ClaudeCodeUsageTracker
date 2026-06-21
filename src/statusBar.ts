import * as vscode from 'vscode';
import { UsageSummary } from './types';
import { ContextInfo } from './dataLoader';
import { PlanLimits, LimitWindow, ScopedLimit, ExtraUsage, formatReset, formatAge, formatExtraSpend } from './limitsReader';
import { PredictionView } from './prediction';

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
  render(summary: UsageSummary, limits?: PlanLimits, context?: ContextInfo, prediction?: PredictionView): void {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const showLimits = cfg.get<boolean>('showLimits', true);
    const showOpusWeekly = cfg.get<boolean>('showOpusWeekly', false);
    const showContext = cfg.get<boolean>('showContext', true);
    const showCost = cfg.get<boolean>('showCost', true);
    const showTokens = cfg.get<boolean>('showTokens', true);
    const showExtraUsage = cfg.get<boolean>('showExtraUsage', false);
    const decimals = cfg.get<number>('decimalPlaces', 2);
    const currency = cfg.get<string>('currency', 'USD');

    const extra = showExtraUsage && limits?.extraUsage?.isEnabled ? limits.extraUsage : undefined;
    const pred = prediction?.enabled ? prediction : undefined;
    const predTip = pred ? predictionTooltip(pred, currency, decimals) : undefined;
    const tooltip = buildTooltip(showLimits ? limits : undefined, showContext ? context : undefined, extra, predTip);

    const live = showLimits ? limits : undefined;
    this.renderLimit(this.fiveHour, '5h', live?.fiveHour, tooltip, pred?.fiveHour?.segment);
    this.renderLimit(this.weekly, 'wk', live?.sevenDay, tooltip, pred?.sevenDay?.segment);
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
    if (extra) {
      const spend = formatExtraSpend(extra);
      if (spend) {
        parts.push(`extra ${spend}`);
      }
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
    tooltip: string,
    segment?: string
  ): void {
    if (!window) {
      item.hide();
      return;
    }
    const suffix = segment ? ` ${segment}` : '';
    item.text = `${ICON} ${label} ${Math.round(window.utilization)}%${suffix}`;
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

interface PredictionTooltip {
  fiveHourDetail?: string;
  sevenDayDetail?: string;
  burnLine?: string;
}

function predictionTooltip(pred: PredictionView, currency: string, decimals: number): PredictionTooltip {
  let burnLine: string | undefined;
  const burn = pred.burn;
  if (burn && burn.recordCount > 0) {
    const minutes = Math.round(burn.windowMs / 60000);
    const tokens = `${formatTokens(Math.round(burn.tokensPerMin))} tok/min`;
    const cost = `${formatCurrency(burn.costPerMin, currency, decimals)}/min`;
    burnLine = `Burn: ${tokens}  ·  ${cost}  ·  last ${minutes}m`;
  }
  return { fiveHourDetail: pred.fiveHour?.detail, sevenDayDetail: pred.sevenDay?.detail, burnLine };
}

function buildTooltip(limits?: PlanLimits, context?: ContextInfo, extra?: ExtraUsage, pred?: PredictionTooltip): string {
  const lines: string[] = [];
  let burnShown = false;
  if (limits) {
    const limitLines: string[] = [];
    if (limits.fiveHour) {
      limitLines.push(limitLine('5h', limits.fiveHour, pred?.fiveHourDetail));
    }
    if (limits.sevenDay) {
      limitLines.push(limitLine('Week', limits.sevenDay, pred?.sevenDayDetail));
    }
    for (const scoped of limits.scoped) {
      limitLines.push(limitLine(scoped.label, scoped));
    }
    if (limitLines.length) {
      lines.push('Claude plan limits', ...limitLines);
      if (pred?.burnLine) {
        lines.push(pred.burnLine);
        burnShown = true;
      }
      const age = formatAge(limits.fetchedAt);
      if (age) {
        lines.push(`Updated ${age}`);
      }
    }
  }
  if (pred?.burnLine && !burnShown) {
    if (lines.length) {
      lines.push('');
    }
    lines.push(pred.burnLine);
  }
  if (context) {
    if (lines.length) {
      lines.push('');
    }
    lines.push(
      `Context: ${Math.round(context.percent)}%  ·  ${context.tokens.toLocaleString('en-US')} / ${context.windowTokens.toLocaleString('en-US')} tokens`
    );
  }
  if (extra) {
    const spend = formatExtraSpend(extra);
    if (spend) {
      if (lines.length) {
        lines.push('');
      }
      const util = extra.utilization !== undefined ? `  ·  ${Math.max(0, Math.round(extra.utilization))}%` : '';
      lines.push(`Extra usage (pay-as-you-go): ${spend}${util}`);
    }
  }
  return lines.length ? lines.join('\n') : 'Claude Code Usage Tracker';
}

function limitLine(label: string, window: LimitWindow, detail?: string): string {
  const parts = [`${Math.round(window.utilization)}%`];
  const reset = formatReset(window.resetsAt);
  if (reset) {
    parts.push(reset);
  }
  if (detail) {
    parts.push(detail);
  }
  return `${label}: ${parts.join('  ·  ')}`;
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
