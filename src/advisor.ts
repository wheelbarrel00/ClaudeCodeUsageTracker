// Pure, VS Code-free usage advisor (so it stays unit-testable). A `money` formatter
// is injected so insights read self-contained without the module touching VS Code or locale.

import { UsageRecord } from './types';
import { estimateCost } from './pricing';
import { cheaperTier } from './burnRate';
import type { SessionSummary } from './dataLoader';

export type InsightSeverity = 'info' | 'tip' | 'warning';

export interface Insight {
  id: string; // 'model-mix' | 'cache-efficiency' | 'context-bloat' | 'spend-forecast'
  severity: InsightSeverity;
  title: string;
  detail: string;
  action?: string;
  savingsUsd?: number; // estimated saving; drives ranking + the badge
  evidence?: string;
}

export interface AdvisorInput {
  records: UsageRecord[]; // dashboard passes the current month
  sessions: SessionSummary[]; // sessions over the same period
  now: number;
  // On a subscription the dollar figures are estimated API-equivalent cost (a usage
  // gauge), not a bill — the priced insights reframe toward session limits when set.
  subscription?: boolean;
}

export type Money = (usd: number) => string;

// A turn this short is routine enough that a cheaper tier could likely serve it.
const MODEL_MAX_OUTPUT = 300;
const MODEL_MIN_TURNS = 5;
const MODEL_MIN_SAVINGS = 1.0;

// Judged per session so many short, fresh sessions (low reuse by nature, not waste) don't trip it.
const CACHE_MIN_MESSAGES = 10;
const CACHE_MIN_SESSION_TOKENS = 2_000_000;
const CACHE_LOW_HIT = 0.4;
const CACHE_MIN_SESSIONS = 2;

// A couple of sessions regularly running hot is a habit worth flagging, not a one-off.
const HOT_CONTEXT_PCT = 80;
const HOT_MIN_SESSIONS = 2;

const FORECAST_MIN_DAY = 2; // don't extrapolate a month from a single day
const FORECAST_MIN_SPEND = 1.0;

const SEVERITY_RANK: Record<InsightSeverity, number> = { warning: 0, tip: 1, info: 2 };

function modelFamily(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('opus')) {
    return 'Opus';
  }
  if (m.includes('sonnet')) {
    return 'Sonnet';
  }
  if (m.includes('fable')) {
    return 'Fable';
  }
  if (m.includes('haiku')) {
    return 'Haiku';
  }
  return model;
}

// Concrete cheaper model id to re-price the same tokens against, mirroring cheaperTier()'s step.
function cheaperModelId(model: string): string | undefined {
  const m = model.toLowerCase();
  if (m.includes('opus')) {
    return 'claude-sonnet-4-6';
  }
  if (m.includes('fable')) {
    return 'claude-sonnet-4-6';
  }
  if (m.includes('sonnet')) {
    return 'claude-haiku-4-5';
  }
  return undefined;
}

interface ModelAgg {
  count: number;
  currentCost: number;
  cheaperCost: number;
  output: number;
}

// Re-prices short-output turns one tier down (context included, so a big cached context on a
// short answer counts) and reports the single model with the largest realisable saving.
function modelMixInsight(records: UsageRecord[], money: Money, subscription: boolean): Insight | undefined {
  const agg = new Map<string, ModelAgg>();
  for (const r of records) {
    const cheaper = cheaperModelId(r.model);
    if (!cheaper || r.tokens.output > MODEL_MAX_OUTPUT) {
      continue;
    }
    const a = agg.get(r.model) ?? { count: 0, currentCost: 0, cheaperCost: 0, output: 0 };
    a.count += 1;
    a.currentCost += estimateCost(r.tokens, r.model);
    a.cheaperCost += estimateCost(r.tokens, cheaper);
    a.output += r.tokens.output;
    agg.set(r.model, a);
  }

  let bestModel: string | undefined;
  let best: ModelAgg | undefined;
  let bestSavings = 0;
  for (const [model, a] of agg) {
    const savings = a.currentCost - a.cheaperCost;
    if (savings > bestSavings) {
      bestSavings = savings;
      best = a;
      bestModel = model;
    }
  }
  if (!best || bestModel === undefined || best.count < MODEL_MIN_TURNS || bestSavings < MODEL_MIN_SAVINGS) {
    return undefined;
  }

  const family = modelFamily(bestModel);
  const label = cheaperTier(bestModel)!;
  const avgOut = Math.round(best.output / best.count);
  return {
    id: 'model-mix',
    severity: 'tip',
    title: `Route routine ${family} turns to ${label}`,
    detail:
      `You ran ${best.count} short ${family} turns (averaging ${avgOut} output tokens) this period — ` +
      `routine work a cheaper model usually handles well. At the same token counts, those turns on ${label} ` +
      (subscription
        ? `are about ${money(bestSavings)} cheaper at API-equivalent rates — and on a subscription, routing routine work to a lighter model stretches your 5-hour / weekly limits further.`
        : `would have cost about ${money(bestSavings)} less.`),
    action: `Switch to ${label} for quick edits, lookups, and other routine turns (the /model command).`,
    savingsUsd: bestSavings,
    evidence: `${best.count} turns · avg ${avgOut} output tokens`,
  };
}

// Qualitative (no savingsUsd) since the achievable improvement depends on workflow, so it
// ranks below the priced tips.
function sessionHitRate(s: SessionSummary): number {
  const t = s.summary.tokens;
  const denom = t.input + t.cacheWrite + t.cacheRead;
  return denom > 0 ? t.cacheRead / denom : 1;
}

function cacheInsight(sessions: SessionSummary[]): Insight | undefined {
  const churny = sessions.filter((s) => {
    const t = s.summary.tokens;
    const denom = t.input + t.cacheWrite + t.cacheRead;
    return (
      s.summary.messageCount >= CACHE_MIN_MESSAGES &&
      denom >= CACHE_MIN_SESSION_TOKENS &&
      sessionHitRate(s) < CACHE_LOW_HIT
    );
  });
  if (churny.length < CACHE_MIN_SESSIONS) {
    return undefined;
  }
  const pct = Math.round(Math.min(...churny.map(sessionHitRate)) * 100);
  return {
    id: 'cache-efficiency',
    severity: 'tip',
    title: 'Long sessions re-processing context uncached',
    detail:
      `${churny.length} long sessions reused little of their context from cache (as low as ${pct}%), ` +
      `so most of it was re-processed at full input price — cache reads cost roughly a tenth as much.`,
    action:
      'Keep a session’s early context stable — avoid editing CLAUDE.md mid-session and let Claude ' +
      're-read files in a consistent order so more of the context stays cached.',
    evidence: `${churny.length} sessions · as low as ${pct}% cache reuse`,
  };
}

function contextInsight(sessions: SessionSummary[]): Insight | undefined {
  const hot = sessions.filter((s) => s.peakContextPct >= HOT_CONTEXT_PCT);
  if (hot.length < HOT_MIN_SESSIONS) {
    return undefined;
  }
  const peak = Math.round(Math.max(...hot.map((s) => s.peakContextPct)));
  return {
    id: 'context-bloat',
    severity: 'tip',
    title: 'Sessions running near the context limit',
    detail:
      `${hot.length} sessions peaked above ${HOT_CONTEXT_PCT}% context this period (highest ${peak}%). ` +
      `Near the limit Claude has to compact or drop earlier context to keep going, which rebuilds the ` +
      `cache and can lose useful history.`,
    action: 'Run /compact around 60% context, or /clear and start fresh for unrelated work.',
    evidence: `${hot.length} sessions · peak ${peak}%`,
  };
}

// Linear month-end projection from the spend so far. Framed as "at your current
// pace" and withheld on day 1, where one day extrapolates wildly. On a subscription
// the figure is API-equivalent usage value, not a bill — reframed accordingly.
function forecastInsight(
  records: UsageRecord[],
  now: number,
  money: Money,
  subscription: boolean
): Insight | undefined {
  let total = 0;
  for (const r of records) {
    total += estimateCost(r.tokens, r.model);
  }
  if (total < FORECAST_MIN_SPEND) {
    return undefined;
  }
  const date = new Date(now);
  const dayOfMonth = date.getDate();
  if (dayOfMonth < FORECAST_MIN_DAY) {
    return undefined;
  }
  const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const projected = total * (daysInMonth / dayOfMonth);
  if (subscription) {
    return {
      id: 'spend-forecast',
      severity: 'info',
      title: 'Usage this month, at API-equivalent rates',
      detail:
        `Your usage so far is worth about ${money(total)} at pay-as-you-go API prices, on track to ` +
        `~${money(projected)} by month end. You're on a subscription with a flat fee, so treat this as a ` +
        `usage gauge — your real limit is the 5-hour / weekly session caps, not a bill.`,
      evidence: `≈ ${money(projected)} API-equivalent`,
    };
  }
  return {
    id: 'spend-forecast',
    severity: 'info',
    title: 'Month-end spend forecast',
    detail:
      `At your current pace this month is on track to reach about ${money(projected)} ` +
      `(${money(total)} over the first ${dayOfMonth} days).`,
    evidence: `projected ${money(projected)}`,
  };
}

export interface SavingsBadge {
  text: string; // e.g. "~$12.00" or "≈ $12.00"
  title: string;
  gauge: boolean; // true on a subscription: a usage gauge, not a cash saving (render muted, not green)
}

// On a subscription the figure is estimated API-equivalent usage, not money off a flat-fee
// bill, so it's badged as a neutral gauge (not green) to match the reframed copy.
export function savingsBadge(insight: Insight, money: Money, subscription = false): SavingsBadge | undefined {
  if (!insight.savingsUsd || insight.savingsUsd <= 0) {
    return undefined;
  }
  const amount = money(insight.savingsUsd);
  if (subscription) {
    return {
      text: `≈ ${amount}`,
      title: 'Usage value at pay-as-you-go API rates — a gauge of intensity, not your subscription bill.',
      gauge: true,
    };
  }
  return { text: `~${amount}`, title: 'Estimated saving over this period', gauge: false };
}

// Ranked: larger dollar saving first, then severity (warning, tip, info).
export function analyze(input: AdvisorInput, money: Money): Insight[] {
  const subscription = input.subscription ?? false;
  const insights = [
    modelMixInsight(input.records, money, subscription),
    cacheInsight(input.sessions),
    contextInsight(input.sessions),
    forecastInsight(input.records, input.now, money, subscription),
  ].filter((x): x is Insight => x !== undefined);

  return insights.sort((a, b) => {
    const sa = a.savingsUsd ?? -1;
    const sb = b.savingsUsd ?? -1;
    if (sb !== sa) {
      return sb - sa;
    }
    return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  });
}
