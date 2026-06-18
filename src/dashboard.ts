import * as vscode from 'vscode';
import { UsageRecord, UsageSummary } from './types';
import {
  summarize,
  filterToday,
  filterMonth,
  summarizeByModel,
  summarizeByProject,
  GroupSummary,
} from './dataLoader';

const CONFIG_SECTION = 'claudeCodeUsageTracker';

interface TimeWindow {
  title: string;
  summary: UsageSummary;
}

export class Dashboard {
  private panel: vscode.WebviewPanel | undefined;
  private records: UsageRecord[] = [];

  show(records: UsageRecord[]): void {
    this.records = records;
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'claudeCodeUsageTracker.dashboard',
        'Claude Code Usage',
        vscode.ViewColumn.Active,
        { enableScripts: false, retainContextWhenHidden: true }
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
    }
    this.rerender();
  }

  update(records: UsageRecord[]): void {
    this.records = records;
    if (this.panel) {
      this.rerender();
    }
  }

  private rerender(): void {
    if (!this.panel) {
      return;
    }
    this.panel.webview.html = renderHtml(this.panel.webview, this.records);
  }

  dispose(): void {
    this.panel?.dispose();
  }
}

function renderHtml(webview: vscode.Webview, records: UsageRecord[]): string {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const decimals = cfg.get<number>('decimalPlaces', 2);
  const currency = cfg.get<string>('currency', 'USD');
  const money = (value: number): string => formatCurrency(value, currency, decimals);

  const windows: TimeWindow[] = [
    { title: 'Today', summary: summarize(filterToday(records)) },
    { title: 'This Month', summary: summarize(filterMonth(records)) },
    { title: 'All Time', summary: summarize(records) },
  ];
  const cards = windows.map((w) => card(w, money)).join('\n');
  const models = breakdownTable('By model — all time', 'Model', summarizeByModel(records), money);
  const projects = breakdownTable('By project — all time', 'Project', summarizeByProject(records), money);
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline';`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Claude Code Usage</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 1.5rem; }
    h1 { font-size: 1.3rem; margin: 0 0 1rem; }
    h2.section { font-size: 0.95rem; margin: 1.75rem 0 0.5rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 1rem 1.25rem; background: var(--vscode-editorWidget-background); }
    .card h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; margin: 0 0 0.5rem; }
    .cost { font-size: 1.8rem; font-weight: 600; }
    .messages { opacity: 0.7; margin-bottom: 0.75rem; font-size: 0.85rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    td, th { padding: 0.15rem 0; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    tr.total td { border-top: 1px solid var(--vscode-panel-border); padding-top: 0.35rem; font-weight: 600; }
    table.breakdown th { text-align: left; opacity: 0.7; font-weight: 600; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 0.35rem; }
    table.breakdown th.num { text-align: right; }
    table.breakdown td { padding: 0.25rem 0.75rem 0.25rem 0; }
    .note { margin-top: 1.25rem; font-size: 0.8rem; opacity: 0.65; max-width: 64ch; line-height: 1.45; }
  </style>
</head>
<body>
  <h1>Claude Code Usage</h1>
  <div class="grid">
${cards}
  </div>
  ${models}
  ${projects}
  <p class="note">Token counts are dominated by <strong>cache reads</strong> &mdash; the conversation
  context that is re-read on every request. They are the cheapest token type (about $0.50 per million
  on Opus), so a large total token figure usually accounts for only a small share of cost.</p>
</body>
</html>`;
}

function card(window: TimeWindow, money: (value: number) => string): string {
  const t = window.summary.tokens;
  const total = t.input + t.output + t.cacheWrite + t.cacheRead;
  const row = (label: string, value: number): string =>
    `<tr><td>${label}</td><td class="num">${value.toLocaleString('en-US')}</td></tr>`;
  return `    <section class="card">
      <h2>${window.title}</h2>
      <div class="cost">${money(window.summary.costUsd)}</div>
      <div class="messages">${window.summary.messageCount.toLocaleString('en-US')} messages</div>
      <table>
        ${row('Input', t.input)}
        ${row('Output', t.output)}
        ${row('Cache write', t.cacheWrite)}
        ${row('Cache read', t.cacheRead)}
        <tr class="total"><td>Total tokens</td><td class="num">${total.toLocaleString('en-US')}</td></tr>
      </table>
    </section>`;
}

function breakdownTable(
  title: string,
  firstColumn: string,
  groups: GroupSummary[],
  money: (value: number) => string
): string {
  if (groups.length === 0) {
    return '';
  }
  const rows = groups
    .map((group) => {
      const t = group.summary.tokens;
      const total = t.input + t.output + t.cacheWrite + t.cacheRead;
      return `      <tr><td>${esc(group.key)}</td><td class="num">${group.summary.messageCount.toLocaleString('en-US')}</td><td class="num">${total.toLocaleString('en-US')}</td><td class="num">${money(group.summary.costUsd)}</td></tr>`;
    })
    .join('\n');
  return `<h2 class="section">${esc(title)}</h2>
  <table class="breakdown">
    <thead><tr><th>${esc(firstColumn)}</th><th class="num">Messages</th><th class="num">Tokens</th><th class="num">Cost</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>`;
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

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  );
}
