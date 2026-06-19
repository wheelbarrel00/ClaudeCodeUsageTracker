import * as vscode from 'vscode';
import { UsageRecord, UsageSummary, TokenCounts } from './types';
import {
  summarize,
  filterToday,
  filterMonth,
  summarizeByModel,
  summarizeByProject,
  summarizeByBranch,
  summarizeBySession,
  formatDuration,
  costBreakdown,
  CostParts,
  GroupSummary,
  BranchSummary,
  SessionSummary,
} from './dataLoader';
import { PlanLimits, LimitWindow, formatReset } from './limitsReader';

const CONFIG_SECTION = 'claudeCodeUsageTracker';

interface WindowData {
  title: string;
  summary: UsageSummary;
  costParts: CostParts;
  byModel: GroupSummary[];
  byProject: GroupSummary[];
  byBranch: BranchSummary[];
  sessions: SessionSummary[];
}

export class Dashboard {
  private panel: vscode.WebviewPanel | undefined;
  private records: UsageRecord[] = [];
  private limits: PlanLimits | undefined;
  private ready = false;

  show(records: UsageRecord[], limits?: PlanLimits): void {
    this.records = records;
    this.limits = limits;
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      if (this.ready) {
        this.post();
      }
      return;
    }
    this.ready = false;
    this.panel = vscode.window.createWebviewPanel(
      'claudeCodeUsageTracker.dashboard',
      'Claude Code Usage',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.ready = false;
    });
    this.panel.webview.onDidReceiveMessage((message) => {
      if (message && message.type === 'ready') {
        this.ready = true;
        this.post();
      }
    });
    this.panel.webview.html = shellHtml(this.panel.webview);
  }

  update(records: UsageRecord[], limits?: PlanLimits): void {
    this.records = records;
    this.limits = limits;
    if (this.panel && this.ready) {
      this.post();
    }
  }

  private post(): void {
    if (this.panel) {
      this.panel.webview.postMessage(buildPayload(this.records, this.limits));
    }
  }

  dispose(): void {
    this.panel?.dispose();
  }
}

function buildPayload(
  records: UsageRecord[],
  limits: PlanLimits | undefined
): { limitsHtml: string; cardsHtml: string; tables: Record<string, string> } {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const decimals = cfg.get<number>('decimalPlaces', 2);
  const currency = cfg.get<string>('currency', 'USD');
  const groupingMode = cfg.get<string>('projectGroupingMode', 'git');
  const money = (value: number): string => formatCurrency(value, currency, decimals);

  const windows: Record<string, WindowData> = {
    today: windowData('Today', filterToday(records), groupingMode),
    month: windowData('This Month', filterMonth(records), groupingMode),
    all: windowData('All Time', records, groupingMode),
  };
  const order = ['today', 'month', 'all'];
  const cardsHtml = order.map((key) => card(windows[key], money)).join('\n');
  const tables: Record<string, string> = {};
  for (const key of order) {
    tables[key] =
      breakdownTable('By model', 'Model', windows[key].byModel, money) +
      breakdownTable('By project', 'Project', windows[key].byProject, money) +
      branchesTable(windows[key].byBranch, money) +
      sessionsTable(windows[key].sessions, money);
  }
  return { limitsHtml: limitsSection(limits), cardsHtml, tables };
}

function limitsSection(limits: PlanLimits | undefined): string {
  if (!limits) {
    return '';
  }
  const rows: string[] = [];
  if (limits.fiveHour) {
    rows.push(barRow('5-hour session', limits.fiveHour));
  }
  if (limits.sevenDay) {
    rows.push(barRow('Weekly · all models', limits.sevenDay));
  }
  for (const scoped of limits.scoped) {
    rows.push(barRow(`Weekly · ${scoped.label}`, scoped));
  }
  if (rows.length === 0) {
    return '';
  }
  return `<section class="limits">
    <h2 class="section">Plan limits</h2>
    <div class="bars">
${rows.join('\n')}
    </div>
  </section>`;
}

function barRow(label: string, window: LimitWindow): string {
  const pct = Math.round(window.utilization);
  const width = Math.min(100, Math.max(0, pct));
  const reset = formatReset(window.resetsAt);
  const sub = reset ? `\n        <div class="bar-sub">${reset}</div>` : '';
  return `      <div class="bar-row">
        <div class="bar-head"><span>${esc(label)}</span><span class="bar-pct">${pct}%</span></div>
        <div class="bar-track"><div class="bar-fill ${severityClass(window.severity)}" style="width:${width}%"></div></div>${sub}
      </div>`;
}

function severityClass(severity: string): string {
  switch (severity) {
    case 'critical':
    case 'error':
      return 'error';
    case 'normal':
      return 'normal';
    default:
      return 'warning';
  }
}

function windowData(title: string, records: UsageRecord[], groupingMode: string): WindowData {
  return {
    title,
    summary: summarize(records),
    costParts: costBreakdown(records),
    byModel: summarizeByModel(records),
    byProject: summarizeByProject(records, groupingMode),
    byBranch: summarizeByBranch(records),
    sessions: summarizeBySession(records),
  };
}

function card(win: WindowData, money: (value: number) => string): string {
  const t = win.summary.tokens;
  const total = t.input + t.output + t.cacheWrite + t.cacheRead;
  const row = (label: string, value: number): string =>
    `<tr><td>${label}</td><td class="num">${value.toLocaleString('en-US')}</td></tr>`;
  const messages = `${win.summary.messageCount.toLocaleString('en-US')} messages · ${Math.round(cacheHitRate(t))}% cache hit`;
  return `    <section class="card">
      <h2>${win.title}</h2>
      <div class="cost">${money(win.summary.costUsd)}</div>
      <div class="messages">${messages}</div>
      <table>
        ${row('Input', t.input)}
        ${row('Output', t.output)}
        ${row('Cache write', t.cacheWrite)}
        ${row('Cache read', t.cacheRead)}
        <tr class="total"><td>Total tokens</td><td class="num">${total.toLocaleString('en-US')}</td></tr>
      </table>
      ${compositionBar(win.costParts)}
    </section>`;
}

function cacheHitRate(t: TokenCounts): number {
  const denom = t.input + t.cacheWrite + t.cacheRead;
  return denom > 0 ? (t.cacheRead / denom) * 100 : 0;
}

function compositionBar(parts: CostParts): string {
  const total = parts.input + parts.output + parts.cacheWrite + parts.cacheRead;
  if (total <= 0) {
    return '';
  }
  const segs = [
    { cls: 'seg-input', label: 'Input', value: parts.input },
    { cls: 'seg-output', label: 'Output', value: parts.output },
    { cls: 'seg-cw', label: 'Cache write', value: parts.cacheWrite },
    { cls: 'seg-cr', label: 'Cache read', value: parts.cacheRead },
  ].map((s) => ({ ...s, pct: (s.value / total) * 100 }));
  const bar = segs
    .map((s) => `<span class="seg ${s.cls}" style="width:${s.pct.toFixed(2)}%"></span>`)
    .join('');
  const legend = segs
    .map((s) => `<span class="comp-item"><i class="dot ${s.cls}"></i>${s.label} ${Math.round(s.pct)}%</span>`)
    .join('');
  return `<div class="composition" title="Cost by token type">
        <div class="comp-bar">${bar}</div>
        <div class="comp-legend">${legend}</div>
      </div>`;
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
      return `      <tr data-name="${esc(group.key)}" data-messages="${group.summary.messageCount}" data-tokens="${total}" data-cost="${group.summary.costUsd}"><td>${esc(group.key)}</td><td class="num">${group.summary.messageCount.toLocaleString('en-US')}</td><td class="num">${total.toLocaleString('en-US')}</td><td class="num">${money(group.summary.costUsd)}</td></tr>`;
    })
    .join('\n');
  return `<h2 class="section">${esc(title)}</h2>
  <table class="breakdown">
    <thead><tr><th class="sortable" data-sortkey="name">${esc(firstColumn)}</th><th class="num sortable" data-sortkey="messages">Messages</th><th class="num sortable" data-sortkey="tokens">Tokens</th><th class="num sortable sorted-desc" data-sortkey="cost">Cost</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>`;
}

function branchesTable(branches: BranchSummary[], money: (value: number) => string): string {
  if (branches.length === 0) {
    return '';
  }
  const rows = branches
    .map((b) => {
      const t = b.summary.tokens;
      const tokens = t.input + t.output + t.cacheWrite + t.cacheRead;
      return `      <tr data-name="${esc(b.branch)}" data-project="${esc(b.project)}" data-messages="${b.summary.messageCount}" data-tokens="${tokens}" data-cost="${b.summary.costUsd}"><td>${esc(b.branch)}</td><td>${esc(b.project)}</td><td class="num">${b.summary.messageCount.toLocaleString('en-US')}</td><td class="num">${tokens.toLocaleString('en-US')}</td><td class="num">${money(b.summary.costUsd)}</td></tr>`;
    })
    .join('\n');
  return `<h2 class="section">By branch</h2>
  <table class="breakdown">
    <thead><tr><th class="sortable" data-sortkey="name">Branch</th><th class="sortable" data-sortkey="project">Project</th><th class="num sortable" data-sortkey="messages">Messages</th><th class="num sortable" data-sortkey="tokens">Tokens</th><th class="num sortable sorted-desc" data-sortkey="cost">Cost</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>`;
}

const SESSION_LIMIT = 50;

function sessionsTable(sessions: SessionSummary[], money: (value: number) => string): string {
  if (sessions.length === 0) {
    return '';
  }
  const shown = sessions.slice(0, SESSION_LIMIT);
  const heading = sessions.length > SESSION_LIMIT ? `Sessions (top ${SESSION_LIMIT} by cost)` : 'Sessions';
  const rows = shown
    .map((s) => {
      const t = s.summary.tokens;
      const tokens = t.input + t.output + t.cacheWrite + t.cacheRead;
      const durationMs = s.activeMs;
      const started = new Date(s.startMs).toLocaleString();
      return `      <tr data-name="${esc(s.title)}" data-project="${esc(s.project)}" data-messages="${s.summary.messageCount}" data-tokens="${tokens}" data-peak="${s.peakContextPct}" data-cost="${s.summary.costUsd}" data-duration="${durationMs}"><td title="Started ${esc(started)}">${esc(s.title)}</td><td>${esc(s.project)}</td><td class="num">${s.summary.messageCount.toLocaleString('en-US')}</td><td class="num">${tokens.toLocaleString('en-US')}</td><td class="num">${Math.round(s.peakContextPct)}%</td><td class="num">${money(s.summary.costUsd)}</td><td class="num">${formatDuration(durationMs)}</td></tr>`;
    })
    .join('\n');
  return `<h2 class="section">${esc(heading)}</h2>
  <table class="breakdown">
    <thead><tr><th class="sortable" data-sortkey="name">Session</th><th class="sortable" data-sortkey="project">Project</th><th class="num sortable" data-sortkey="messages">Messages</th><th class="num sortable" data-sortkey="tokens">Tokens</th><th class="num sortable" data-sortkey="peak">Peak ctx</th><th class="num sortable sorted-desc" data-sortkey="cost">Cost</th><th class="num sortable" data-sortkey="duration">Duration</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>`;
}

function shellHtml(webview: vscode.Webview): string {
  const nonce = makeNonce();
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
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
    h2.section { font-size: 0.95rem; margin: 1.5rem 0 0.5rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 1rem 1.25rem; background: var(--vscode-editorWidget-background); }
    .card h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; margin: 0 0 0.5rem; }
    .cost { font-size: 1.8rem; font-weight: 600; }
    .messages { opacity: 0.7; margin-bottom: 0.75rem; font-size: 0.85rem; }
    .composition { margin-top: 0.7rem; }
    .comp-bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: var(--vscode-panel-border); }
    .comp-bar .seg { height: 100%; }
    .seg-input { background: var(--vscode-charts-blue, #4e95d9); }
    .seg-output { background: var(--vscode-charts-orange, #d9874e); }
    .seg-cw { background: var(--vscode-charts-purple, #b180d7); }
    .seg-cr { background: var(--vscode-charts-green, #5db075); }
    .comp-legend { display: flex; flex-wrap: wrap; gap: 0.3rem 0.7rem; margin-top: 0.45rem; font-size: 0.72rem; opacity: 0.75; }
    .comp-item { display: inline-flex; align-items: center; gap: 0.3rem; white-space: nowrap; }
    .comp-legend .dot { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    td, th { padding: 0.15rem 0; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    tr.total td { border-top: 1px solid var(--vscode-panel-border); padding-top: 0.35rem; font-weight: 600; }
    table.breakdown th { text-align: left; opacity: 0.7; font-weight: 600; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 0.35rem; }
    table.breakdown th.num { text-align: right; }
    table.breakdown th.sortable { cursor: pointer; user-select: none; }
    table.breakdown th.sortable:hover { opacity: 1; }
    table.breakdown th.sorted-asc::after { content: ' ▲'; font-size: 0.7em; }
    table.breakdown th.sorted-desc::after { content: ' ▼'; font-size: 0.7em; }
    table.breakdown td { padding: 0.25rem 0.75rem 0.25rem 0; }
    .limits { margin: 0 0 1.75rem; }
    .limits h2.section { margin-top: 0; }
    .bars { display: flex; flex-direction: column; gap: 0.85rem; max-width: 520px; }
    .bar-head { display: flex; justify-content: space-between; font-size: 0.85rem; margin-bottom: 0.25rem; }
    .bar-pct { font-variant-numeric: tabular-nums; opacity: 0.85; }
    .bar-track { height: 8px; border-radius: 4px; background: var(--vscode-panel-border); overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 4px; background: var(--vscode-progressBar-background); }
    .bar-fill.warning { background: var(--vscode-charts-yellow, #d7a000); }
    .bar-fill.error { background: var(--vscode-charts-red, #d33); }
    .bar-sub { margin-top: 0.2rem; font-size: 0.78rem; opacity: 0.6; }
    .tabs { display: flex; gap: 0.4rem; margin: 1.75rem 0 0.25rem; }
    .tabs button { font: inherit; color: var(--vscode-foreground); background: transparent; border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 0.3rem 0.8rem; cursor: pointer; }
    .tabs button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .tabs button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
    .note { margin-top: 1.25rem; font-size: 0.8rem; opacity: 0.65; max-width: 64ch; line-height: 1.45; }
  </style>
</head>
<body>
  <h1>Claude Code Usage</h1>
  <div id="limits"></div>
  <div id="cards" class="grid"></div>
  <div class="tabs" id="tabs">
    <button data-window="today">Today</button>
    <button data-window="month">This Month</button>
    <button data-window="all">All Time</button>
  </div>
  <div id="tables"></div>
  <p class="note">Token counts are dominated by <strong>cache reads</strong> &mdash; the conversation
  context re-read on every request. Per token they are the cheapest type (about $0.50 per million on
  Opus), but because the whole context is re-read each turn, the cost-composition bars above show they
  can still be a sizeable share of total spend.</p>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const saved = vscode.getState();
    let sel = (saved && saved.window) || 'all';
    let tables = null;
    const tablesEl = document.getElementById('tables');
    const buttons = Array.from(document.querySelectorAll('#tabs button'));
    function paint() {
      tablesEl.innerHTML = tables ? (tables[sel] || '') : '';
      buttons.forEach((b) => b.classList.toggle('active', b.dataset.window === sel));
    }
    buttons.forEach((b) => {
      b.addEventListener('click', () => {
        sel = b.dataset.window;
        vscode.setState({ window: sel });
        paint();
      });
    });
    tablesEl.addEventListener('click', (event) => {
      const th = event.target.closest('th.sortable');
      if (!th || !tablesEl.contains(th)) {
        return;
      }
      const table = th.closest('table');
      const dir = th.classList.contains('sorted-desc') ? 'asc' : 'desc';
      table.querySelectorAll('th').forEach((h) => h.classList.remove('sorted-asc', 'sorted-desc'));
      th.classList.add(dir === 'asc' ? 'sorted-asc' : 'sorted-desc');
      const key = th.dataset.sortkey;
      const tbody = table.querySelector('tbody');
      const rows = Array.from(tbody.children);
      rows.sort((a, b) => {
        const av = a.dataset[key];
        const bv = b.dataset[key];
        const an = parseFloat(av);
        const bn = parseFloat(bv);
        const cmp = !isNaN(an) && !isNaN(bn) ? an - bn : String(av).localeCompare(String(bv));
        return dir === 'asc' ? cmp : -cmp;
      });
      rows.forEach((r) => tbody.appendChild(r));
    });
    window.addEventListener('message', (event) => {
      const data = event.data;
      document.getElementById('limits').innerHTML = data.limitsHtml || '';
      document.getElementById('cards').innerHTML = data.cardsHtml;
      tables = data.tables;
      paint();
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 24; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
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
