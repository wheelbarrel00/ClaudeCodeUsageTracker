import * as vscode from 'vscode';
import { UsageSummary } from './types';

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
  render(summary: UsageSummary): void {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const showCost = cfg.get<boolean>('showCost', true);
    const showTokens = cfg.get<boolean>('showTokens', true);
    const decimals = cfg.get<number>('decimalPlaces', 2);
    const currency = cfg.get<string>('currency', 'USD');

    const parts: string[] = [];
    if (showCost) {
      parts.push(formatCurrency(summary.costUsd, currency, decimals));
    }
    if (showTokens) {
      parts.push(`${formatTokens(totalTokens(summary))} tok`);
    }
    this.item.text = `$(graph) ${parts.join('  ') || 'Claude usage'}`;
  }

  dispose(): void {
    this.item.dispose();
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
