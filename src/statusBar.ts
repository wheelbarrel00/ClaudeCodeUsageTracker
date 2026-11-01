import * as vscode from 'vscode';
import { UsageSummary, totalTokens } from './types';
import { ContextInfo } from './dataLoader';
import {
  PlanLimits,
  LimitWindow,
  ExtraUsage,
  SeverityBand,
  severityBand,
  formatReset,
  formatAge,
  formatExtraSpend,
  topScoped,
} from './limitsReader';
import { PredictionView } from './prediction';
import { hasSubscription } from './credentials';
import { sanitizeThresholds } from './burnRate';
import { formatCurrency } from './format';

const CONFIG_SECTION = 'claudeCodeUsageTracker';
const ICON = '$(ccut-claude)';

export class StatusBarController {
  private readonly fiveHour: vscode.StatusBarItem;
  private readonly weekly: vscode.StatusBarItem;
  private readonly modelWeekly: vscode.StatusBarItem;
  private readonly main: vscode.StatusBarItem;

  constructor() {
    this.fiveHour = this.createItem('fiveHourLimit', 'Claude Usage: 5-Hour Limit', 104);
    this.weekly = this.createItem('weeklyLimit', 'Claude Usage: Weekly Limit', 103);
    this.modelWeekly = this.createItem('modelWeeklyLimit', 'Claude Usage: Model Weekly Limit', 102);
    this.main = this.createItem('main', 'Claude Usage', 101);
    this.main.text = `${ICON} Claude usage`;
    this.main.show();
  }

  private createItem(id: string, name: string, priority: number): vscode.StatusBarItem {
    const item = vscode.window.createStatusBarItem(`${CONFIG_SECTION}.${id}`, vscode.StatusBarAlignment.Right, priority);
    item.name = name;
    item.command = `${CONFIG_SECTION}.showDashboard`;
    item.tooltip = 'Claude Code Usage Tracker';
    return item;
  }

  render(summary: UsageSummary, limits?: PlanLimits, context?: ContextInfo, prediction?: PredictionView): void {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const showLimits = cfg.get<boolean>('showLimits', true);
    const showModelWeekly = cfg.get<boolean>('showModelWeekly', false) || cfg.get<boolean>('showOpusWeekly', false);
    const showContext = cfg.get<boolean>('showContext', true);
    const showCost = cfg.get<boolean>('showCost', true);
    const showTokens = cfg.get<boolean>('showTokens', true);
    const showExtraUsage = cfg.get<boolean>('showExtraUsage', false);
    const decimals = cfg.get<number>('decimalPlaces', 2);
    const currency = cfg.get<string>('currency', 'USD');

    const extra = showExtraUsage && limits?.extraUsage?.isEnabled ? limits.extraUsage : undefined;
    const pred = prediction?.enabled ? prediction : undefined;
    const subscription = hasSubscription(limits);
    const thresholds = sanitizeThresholds(cfg.get<number[]>('predictiveAlerts.warnThresholds', [75, 90]));
    const predTip = pred ? predictionTooltip(pred, currency, decimals, subscription) : undefined;
    const tooltip = buildTooltip(showLimits ? limits : undefined, showContext ? context : undefined, extra, predTip);

    const live = showLimits ? limits : undefined;
    this.renderLimit(this.fiveHour, '5h', live?.fiveHour, thresholds, tooltip, pred?.fiveHour?.segment);
    this.renderLimit(this.weekly, 'wk', live?.sevenDay, thresholds, tooltip, pred?.sevenDay?.segment);
    const model = showModelWeekly && live ? topScoped(live) : undefined;
    this.renderLimit(this.modelWeekly, model?.label.toLowerCase() ?? '', model, thresholds, tooltip);

    const parts: string[] = [];
    if (showContext && context) {
      parts.push(`ctx ${Math.round(context.percent)}%`);
    }
    if (showCost) {
      parts.push(formatCurrency(summary.costUsd, currency, decimals));
    }
    if (showTokens) {
      parts.push(`${formatTokens(totalTokens(summary.tokens))} tok`);
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
    thresholds: number[],
    tooltip: string,
    segment?: string
  ): void {
    if (!window) {
      item.hide();
      return;
    }
    const suffix = segment ? ` ${segment}` : '';
    item.text = `${ICON} ${label} ${Math.round(window.utilization)}%${suffix}`;
    item.color = bandColor(severityBand(window, thresholds));
    item.tooltip = tooltip;
    item.show();
  }

  dispose(): void {
    this.fiveHour.dispose();
    this.weekly.dispose();
    this.modelWeekly.dispose();
    this.main.dispose();
  }
}

function bandColor(band: SeverityBand): vscode.ThemeColor {
  switch (band) {
    case 'error':
      return new vscode.ThemeColor('charts.red');
    case 'warning':
      return new vscode.ThemeColor('charts.yellow');
    default:
      return new vscode.ThemeColor('charts.green');
  }
}

interface PredictionTooltip {
  fiveHourDetail?: string;
  sevenDayDetail?: string;
  burnLines?: string[];
}

function predictionTooltip(
  pred: PredictionView,
  currency: string,
  decimals: number,
  subscription: boolean
): PredictionTooltip {
  let burnLines: string[] | undefined;
  const burn = pred.burn;
  if (burn && burn.recordCount > 0) {
    const minutes = Math.round(burn.windowMs / 60000);
    const rate = `${formatCurrency(burn.costPerMin, currency, decimals)}/min`;
    const parts = [
      `${formatTokens(Math.round(burn.newTokensPerMin))} new tok/min`,
      `${formatTokens(Math.round(burn.cacheReadPerMin))}/min context re-read`,
      subscription ? `≈ ${rate} at API rates` : rate,
    ];
    burnLines = [`Burn · last ${minutes}m`, parts.join('  ·  ')];
  }
  return { fiveHourDetail: pred.fiveHour?.detail, sevenDayDetail: pred.sevenDay?.detail, burnLines };
}

function buildTooltip(limits?: PlanLimits, context?: ContextInfo, extra?: ExtraUsage, pred?: PredictionTooltip): string {
  const lines: string[] = [];
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
      const age = formatAge(limits.fetchedAt);
      if (age) {
        lines.push(`Updated ${age}`);
      }
    }
  }
  if (pred?.burnLines?.length) {
    if (lines.length) {
      lines.push('');
    }
    lines.push(...pred.burnLines);
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

function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}k`;
  }
  return String(count);
}
