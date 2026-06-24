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
  summarizeDaily,
  summarizeMonthly,
  formatDuration,
  costBreakdown,
  CostParts,
  GroupSummary,
  BranchSummary,
  SessionSummary,
  TrendBucket,
} from './dataLoader';
import { PlanLimits, LimitWindow, ExtraUsage, formatReset, formatAge, formatExtraSpend } from './limitsReader';
import { analyze, Insight, savingsBadge } from './advisor';
import { AiAdvisor, AiResult } from './aiAdvisor';
import { isSubscription } from './credentials';

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
  private aiInFlight = false;

  constructor(private readonly ai?: AiAdvisor) {}

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
      if (!message) {
        return;
      }
      if (message.type === 'ready') {
        this.ready = true;
        this.post();
      } else if (message.type === 'explainWithAI') {
        void this.runAi();
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
      this.panel.webview.postMessage(buildPayload(this.records, this.limits, this.ai !== undefined));
    }
  }

  private async runAi(): Promise<void> {
    if (!this.ai || this.aiInFlight) {
      return;
    }
    this.aiInFlight = true;
    try {
      const result = await this.ai.explain(this.records, this.limits);
      if (this.panel && this.ready) {
        this.panel.webview.postMessage({ type: 'aiResult', html: renderAiHtml(result) });
      }
    } finally {
      this.aiInFlight = false;
    }
  }

  dispose(): void {
    this.panel?.dispose();
  }
}

interface ChartSet {
  daily: { cost: string; tokens: string };
  monthly: { cost: string; tokens: string };
}

function buildPayload(
  records: UsageRecord[],
  limits: PlanLimits | undefined,
  aiEnabled: boolean
): { limitsHtml: string; advisorHtml: string; cardsHtml: string; charts: ChartSet; tables: Record<string, string> } {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const decimals = cfg.get<number>('decimalPlaces', 2);
  const currency = cfg.get<string>('currency', 'USD');
  const groupingMode = cfg.get<string>('projectGroupingMode', 'git');
  const money = (value: number): string => formatCurrency(value, currency, decimals);
  const subscription = isSubscription() || !!(limits?.fiveHour || limits?.sevenDay);

  const monthRecords = filterMonth(records);
  const windows: Record<string, WindowData> = {
    today: windowData('Today', filterToday(records), groupingMode),
    month: windowData('This Month', monthRecords, groupingMode),
    all: windowData('All Time', records, groupingMode),
  };
  const order = ['today', 'month', 'all'];
  const cardsHtml = order.map((key) => card(windows[key], money, subscription)).join('\n');
  const tables: Record<string, string> = {};
  for (const key of order) {
    tables[key] =
      breakdownTable('By model', 'Model', windows[key].byModel, money) +
      breakdownTable('By project', 'Project', windows[key].byProject, money) +
      branchesTable(windows[key].byBranch, money) +
      sessionsTable(windows[key].sessions, money);
  }
  const showExtraUsage = cfg.get<boolean>('showExtraUsage', false);
  const limitsHtml = limitsSection(limits) + extraUsageSection(showExtraUsage ? limits?.extraUsage : undefined);
  const advisorHtml = cfg.get<boolean>('advisor.enabled', true)
    ? advisorSection(
        analyze({ records: monthRecords, sessions: windows.month.sessions, now: Date.now(), subscription }, money),
        money,
        aiEnabled,
        subscription
      )
    : '';
  return { limitsHtml, advisorHtml, cardsHtml, charts: chartSet(records, money), tables };
}

function advisorSection(
  insights: Insight[],
  money: (value: number) => string,
  aiEnabled: boolean,
  subscription: boolean
): string {
  const body = insights.length
    ? `<div class="advisor-list">\n${insights.map((insight) => advisorItem(insight, money, subscription)).join('\n')}\n    </div>`
    : `<div class="advisor-empty">No actionable insights right now — your recent usage looks efficient.</div>`;
  const explain = aiEnabled
    ? `<button id="advisor-explain" class="advisor-explain" title="Send your usage summary to Anthropic with your own API key for a written explanation">Explain with AI</button>`
    : '';
  const note = subscription
    ? `<div class="advisor-note">Dollar figures are estimated pay-as-you-go API cost — a gauge of usage, not your subscription bill. Your real limit is the 5-hour / weekly caps above.</div>`
    : '';
  return `<section class="advisor">
    <div class="advisor-head-row"><h2 class="section">Advisor</h2>${explain}</div>
    ${body}
    ${note}
  </section>`;
}

export function renderAiHtml(result: AiResult): string {
  if (!result.ok) {
    return `<div class="ai-box ai-error">${esc(result.error)}</div>`;
  }
  return `<div class="ai-box">
    <div class="ai-box-head">AI advisor <span class="ai-model">${esc(result.model)}</span></div>
    <div class="ai-body">${renderMarkdownish(result.text)}</div>
  </div>`;
}

// CSP-safe: escape everything first, then re-apply a small markdown subset.
function renderMarkdownish(text: string): string {
  const inline = (s: string): string =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  const out: string[] = [];
  let inList = false;
  const closeList = (): void => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const item = trimmed.match(/^(?:[-*]|\d+\.)\s+(.*)$/);
    if (item) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(item[1])}</li>`);
      continue;
    }
    closeList();
    if (!trimmed) {
      continue;
    }
    const heading = trimmed.match(/^#{1,6}\s+(.*)$/);
    out.push(heading ? `<p class="ai-h">${inline(heading[1])}</p>` : `<p>${inline(trimmed)}</p>`);
  }
  closeList();
  return out.join('');
}

function advisorItem(insight: Insight, money: (value: number) => string, subscription: boolean): string {
  const b = savingsBadge(insight, money, subscription);
  const badge = b
    ? `<span class="advisor-savings${b.gauge ? ' gauge' : ''}" title="${esc(b.title)}">${esc(b.text)}</span>`
    : '';
  const action = insight.action ? `<div class="advisor-action">${esc(insight.action)}</div>` : '';
  const evidence = insight.evidence ? `<div class="advisor-meta">${esc(insight.evidence)}</div>` : '';
  return `      <div class="advisor-item sev-${esc(insight.severity)}">
        <div class="advisor-head"><span class="advisor-title">${esc(insight.title)}</span>${badge}</div>
        <div class="advisor-detail">${esc(insight.detail)}</div>
        ${action}
        ${evidence}
      </div>`;
}

function extraUsageSection(extra: ExtraUsage | undefined): string {
  if (!extra || !extra.isEnabled) {
    return '';
  }
  const spend = formatExtraSpend(extra);
  if (!spend) {
    return '';
  }
  let bar = '';
  if (extra.utilization !== undefined) {
    const pct = Math.max(0, Math.round(extra.utilization));
    const ofCap = extra.monthlyLimit !== undefined ? ' of monthly cap' : ' used';
    bar = `
        <div class="bar-track"><div class="bar-fill normal" style="width:${Math.min(100, pct)}%"></div></div>
        <div class="bar-sub">${pct}%${ofCap}</div>`;
  }
  return `<section class="limits">
    <h2 class="section">Extra usage</h2>
    <div class="bars">
      <div class="bar-row">
        <div class="bar-head"><span>Pay-as-you-go</span><span class="bar-pct">${esc(spend)}</span></div>${bar}
      </div>
    </div>
  </section>`;
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
  const age = formatAge(limits.fetchedAt);
  const note = age ? `\n    <div class="limits-age">Updated ${esc(age)}</div>` : '';
  return `<section class="limits">
    <h2 class="section">Plan limits</h2>
    <div class="bars">
${rows.join('\n')}
    </div>${note}
  </section>`;
}

function barRow(label: string, window: LimitWindow): string {
  const pct = Math.round(window.utilization);
  const width = Math.min(100, Math.max(0, pct));
  const reset = formatReset(window.resetsAt);
  const sub = reset ? `\n        <div class="bar-sub">${esc(reset)}</div>` : '';
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

function card(win: WindowData, money: (value: number) => string, subscription: boolean): string {
  const t = win.summary.tokens;
  const total = t.input + t.output + t.cacheWrite + t.cacheRead;
  const row = (label: string, value: number): string =>
    `<tr><td>${label}</td><td class="num">${value.toLocaleString('en-US')}</td></tr>`;
  const messages = `${win.summary.messageCount.toLocaleString('en-US')} messages · ${Math.round(cacheHitRate(t))}% cache hit`;
  const apiNote = subscription
    ? `<div class="cost-note" title="Estimated at pay-as-you-go API rates. On a subscription you pay a flat fee, so this gauges usage, not a bill.">≈ API-equivalent</div>`
    : '';
  return `    <section class="card">
      <h2>${win.title}</h2>
      <div class="cost">${money(win.summary.costUsd)}</div>
      ${apiNote}
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

type Period = 'daily' | 'monthly';
type Metric = 'cost' | 'tokens';

function chartSet(records: UsageRecord[], money: (value: number) => string): ChartSet {
  const daily = summarizeDaily(records);
  const monthly = summarizeMonthly(records);
  return {
    daily: {
      cost: chartHtml(daily, 'daily', 'cost', money),
      tokens: chartHtml(daily, 'daily', 'tokens', money),
    },
    monthly: {
      cost: chartHtml(monthly, 'monthly', 'cost', money),
      tokens: chartHtml(monthly, 'monthly', 'tokens', money),
    },
  };
}

function bucketValue(bucket: TrendBucket, metric: Metric): number {
  if (metric === 'cost') {
    return bucket.summary.costUsd;
  }
  const t = bucket.summary.tokens;
  return t.input + t.output + t.cacheWrite + t.cacheRead;
}

function chartHtml(
  buckets: TrendBucket[],
  period: Period,
  metric: Metric,
  money: (value: number) => string
): string {
  if (buckets.length === 0) {
    return '<div class="chart-empty">No usage in this range yet.</div>';
  }
  const fmt = (value: number): string => (metric === 'cost' ? money(value) : `${compactTokens(value)} tok`);
  const values = buckets.map((bucket) => bucketValue(bucket, metric));
  const max = Math.max(...values, 0);
  const cols = buckets
    .map((bucket, i) => {
      const value = values[i];
      const height = max > 0 ? (value / max) * 100 : 0;
      const label = period === 'daily' ? dayLabel(bucket.startMs, i === 0) : monthLabel(bucket.startMs, i === 0);
      const full = period === 'daily' ? fullDay(bucket.startMs) : fullMonth(bucket.startMs);
      const today = period === 'daily' && isToday(bucket.startMs) ? ' today' : '';
      return `      <div class="col${today}" title="${esc(full)} — ${esc(fmt(value))}">
        <div class="col-track"><div class="col-fill" style="height:${height.toFixed(1)}%"></div></div>
        <div class="col-label">${esc(label)}</div>
      </div>`;
    })
    .join('\n');
  let summary = '';
  if (max > 0) {
    const total = values.reduce((sum, value) => sum + value, 0);
    const peak = buckets[values.indexOf(max)];
    const when = period === 'daily' ? fullDay(peak.startMs) : fullMonth(peak.startMs);
    const unit = period === 'daily' ? 'day' : 'month';
    const plural = buckets.length === 1 ? '' : 's';
    summary = `Total ${esc(fmt(total))} · peak ${esc(fmt(max))} (${esc(when)}) · ${buckets.length} ${unit}${plural}`;
  }
  return `<div class="chart-summary">${summary}</div>
    <div class="chart-bars ${metric}">
${cols}
    </div>`;
}

function dayLabel(ms: number, first: boolean): string {
  const date = new Date(ms);
  const day = date.getDate();
  if (first || day === 1 || day % 5 === 0 || isToday(ms)) {
    return String(day);
  }
  return '';
}

function monthLabel(ms: number, first: boolean): string {
  const date = new Date(ms);
  const month = date.toLocaleDateString('en-US', { month: 'short' });
  if (first || date.getMonth() === 0) {
    return `${month} ’${String(date.getFullYear()).slice(-2)}`;
  }
  return month;
}

function fullDay(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function fullMonth(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function isToday(ms: number): boolean {
  const date = new Date(ms);
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

function compactTokens(value: number): string {
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1)}B`;
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return String(Math.round(value));
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
    .cost-note { font-size: 0.7rem; opacity: 0.5; margin: -0.1rem 0 0.35rem; cursor: help; }
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
    .limits-age { margin-top: 0.7rem; font-size: 0.78rem; opacity: 0.55; }
    .advisor { margin: 0 0 1.75rem; }
    .advisor h2.section { margin-top: 0; }
    .advisor-list { display: flex; flex-direction: column; gap: 0.6rem; max-width: 640px; }
    .advisor-item { border: 1px solid var(--vscode-panel-border); border-left-width: 3px; border-radius: 5px; padding: 0.6rem 0.85rem; background: var(--vscode-editorWidget-background); }
    .advisor-item.sev-warning { border-left-color: var(--vscode-charts-red, #d33); }
    .advisor-item.sev-tip { border-left-color: var(--vscode-charts-yellow, #d7a000); }
    .advisor-item.sev-info { border-left-color: var(--vscode-charts-blue, #4e95d9); }
    .advisor-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.6rem; }
    .advisor-title { font-weight: 600; font-size: 0.9rem; }
    .advisor-savings { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--vscode-charts-green, #5db075); white-space: nowrap; }
    .advisor-savings.gauge { color: var(--vscode-foreground); opacity: 0.6; }
    .advisor-detail { font-size: 0.84rem; opacity: 0.85; margin-top: 0.3rem; line-height: 1.45; }
    .advisor-action { font-size: 0.82rem; margin-top: 0.4rem; }
    .advisor-meta { font-size: 0.74rem; opacity: 0.55; margin-top: 0.35rem; font-variant-numeric: tabular-nums; }
    .advisor-empty { font-size: 0.85rem; opacity: 0.65; }
    .advisor-note { font-size: 0.76rem; opacity: 0.55; margin-top: 0.7rem; max-width: 640px; line-height: 1.4; }
    .advisor-head-row { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
    .advisor-head-row h2.section { margin: 0; }
    .advisor-explain { font: inherit; font-size: 0.8rem; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 4px; padding: 0.3rem 0.8rem; cursor: pointer; }
    .advisor-explain:hover { background: var(--vscode-button-hoverBackground); }
    .advisor-explain:disabled { opacity: 0.6; cursor: default; }
    .ai-pending { font-size: 0.84rem; opacity: 0.7; margin: 0.75rem 0 0; max-width: 640px; }
    .ai-box { margin: 0.75rem 0 0; max-width: 640px; border: 1px solid var(--vscode-panel-border); border-left: 3px solid var(--vscode-charts-blue, #4e95d9); border-radius: 5px; padding: 0.75rem 0.95rem; background: var(--vscode-editorWidget-background); }
    .ai-box.ai-error { border-left-color: var(--vscode-charts-red, #d33); font-size: 0.84rem; }
    .ai-box-head { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; margin-bottom: 0.4rem; }
    .ai-model { text-transform: none; letter-spacing: 0; opacity: 0.8; }
    .ai-body { font-size: 0.86rem; line-height: 1.5; }
    .ai-body p { margin: 0 0 0.5rem; }
    .ai-body p.ai-h { font-weight: 600; margin-top: 0.6rem; }
    .ai-body ul { margin: 0 0 0.5rem; padding-left: 1.2rem; }
    .ai-body li { margin: 0.15rem 0; }
    .ai-body code { background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.18)); padding: 0 0.25rem; border-radius: 3px; }
    .trend { margin: 1.9rem 0 0; }
    .trend-head { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem; }
    .trend-head h2.section { margin: 0; }
    .switchers { display: flex; gap: 0.5rem; }
    .switch { display: inline-flex; border: 1px solid var(--vscode-panel-border); border-radius: 4px; overflow: hidden; }
    .switch button { font: inherit; font-size: 0.78rem; color: var(--vscode-foreground); background: transparent; border: 0; padding: 0.25rem 0.7rem; cursor: pointer; }
    .switch button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .switch button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .chart-summary { font-size: 0.8rem; opacity: 0.7; margin: 0.6rem 0; min-height: 1rem; }
    .chart-bars { display: flex; align-items: stretch; gap: 3px; height: 150px; }
    .col { flex: 1 1 0; display: flex; flex-direction: column; align-items: center; min-width: 0; }
    .col-track { flex: 1; width: 100%; display: flex; align-items: flex-end; min-height: 0; }
    .col-fill { width: 100%; min-height: 2px; border-radius: 2px 2px 0 0; background: var(--vscode-charts-blue, #4e95d9); }
    .chart-bars.tokens .col-fill { background: var(--vscode-charts-purple, #b180d7); }
    .col.today .col-fill { outline: 1px solid var(--vscode-foreground); outline-offset: -1px; }
    .col-label { font-size: 0.62rem; opacity: 0.55; margin-top: 0.3rem; height: 0.9rem; line-height: 0.9rem; white-space: nowrap; overflow: hidden; }
    .chart-empty { opacity: 0.6; font-size: 0.85rem; padding: 1.5rem 0; }
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
  <div id="advisor"></div>
  <div id="advisor-ai"></div>
  <div id="cards" class="grid"></div>
  <section class="trend">
    <div class="trend-head">
      <h2 class="section">Trend</h2>
      <div class="switchers">
        <div class="switch" id="trend-period">
          <button data-period="daily">Daily</button>
          <button data-period="monthly">Monthly</button>
        </div>
        <div class="switch" id="trend-metric">
          <button data-metric="cost">Cost</button>
          <button data-metric="tokens">Tokens</button>
        </div>
      </div>
    </div>
    <div id="chart"></div>
  </section>
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
    const saved = vscode.getState() || {};
    let sel = saved.window || 'all';
    let period = saved.period || 'daily';
    let metric = saved.metric || 'cost';
    let tables = null;
    let charts = null;
    const tablesEl = document.getElementById('tables');
    const chartEl = document.getElementById('chart');
    const advisorEl = document.getElementById('advisor');
    const aiEl = document.getElementById('advisor-ai');
    const tabButtons = Array.from(document.querySelectorAll('#tabs button'));
    const periodButtons = Array.from(document.querySelectorAll('#trend-period button'));
    const metricButtons = Array.from(document.querySelectorAll('#trend-metric button'));
    function saveState() {
      vscode.setState({ window: sel, period: period, metric: metric });
    }
    function paint() {
      tablesEl.innerHTML = tables ? (tables[sel] || '') : '';
      tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.window === sel));
    }
    function paintChart() {
      chartEl.innerHTML = charts && charts[period] ? (charts[period][metric] || '') : '';
      periodButtons.forEach((b) => b.classList.toggle('active', b.dataset.period === period));
      metricButtons.forEach((b) => b.classList.toggle('active', b.dataset.metric === metric));
    }
    tabButtons.forEach((b) => {
      b.addEventListener('click', () => {
        sel = b.dataset.window;
        saveState();
        paint();
      });
    });
    periodButtons.forEach((b) => {
      b.addEventListener('click', () => {
        period = b.dataset.period;
        saveState();
        paintChart();
      });
    });
    metricButtons.forEach((b) => {
      b.addEventListener('click', () => {
        metric = b.dataset.metric;
        saveState();
        paintChart();
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
    advisorEl.addEventListener('click', (event) => {
      const btn = event.target.closest('#advisor-explain');
      if (!btn || !advisorEl.contains(btn)) {
        return;
      }
      btn.disabled = true;
      aiEl.innerHTML = '<div class="ai-pending">Analyzing your usage…</div>';
      vscode.postMessage({ type: 'explainWithAI' });
    });
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (data && data.type === 'aiResult') {
        aiEl.innerHTML = data.html || '';
        return;
      }
      document.getElementById('limits').innerHTML = data.limitsHtml || '';
      document.getElementById('advisor').innerHTML = data.advisorHtml || '';
      document.getElementById('cards').innerHTML = data.cardsHtml;
      charts = data.charts;
      tables = data.tables;
      paintChart();
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
