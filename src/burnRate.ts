// Prediction math for the predictive-alerts feature. Pure and VS Code-free so it
// can be unit-tested in isolation: the token/cost burn rate from usage records, and
// the time-to-limit ETA / breach / threshold logic from each plan-limit window's
// utilization. The ETA is anchored to the window's OWN period (5h / 7d), not a
// short rolling slope, so a 7-day window is judged over days rather than minutes.

import { UsageRecord, TokenCounts } from './types';
import { estimateCost } from './pricing';

export interface BurnRate {
  tokensPerMin: number;
  costPerMin: number;
  windowTokens: number;
  windowCostUsd: number;
  windowMs: number;
  recordCount: number;
}

function totalTokens(t: TokenCounts): number {
  return t.input + t.output + t.cacheWrite + t.cacheRead;
}

// Average token/cost burn over the trailing window. Records outside
// (now - windowMs, now] are ignored; the denominator is the full window, so the
// rate decays to zero as activity stops rather than spiking on a lone old burst.
export function burnRate(records: UsageRecord[], now: number, windowMs: number): BurnRate {
  const start = now - windowMs;
  let windowTokens = 0;
  let windowCostUsd = 0;
  let recordCount = 0;
  for (const record of records) {
    if (record.timestamp <= start || record.timestamp > now) {
      continue;
    }
    windowTokens += totalTokens(record.tokens);
    windowCostUsd += estimateCost(record.tokens, record.model);
    recordCount++;
  }
  const minutes = windowMs / 60000;
  const tokensPerMin = minutes > 0 ? windowTokens / minutes : 0;
  const costPerMin = minutes > 0 ? windowCostUsd / minutes : 0;
  return { tokensPerMin, costPerMin, windowTokens, windowCostUsd, windowMs, recordCount };
}

// A utilization drop larger than this (percentage points) is read as the window
// having reset/rolled over rather than measurement jitter. A real reset drops the
// number far (typically to ~0), so this sits well above sample noise.
const RESET_DROP_PTS = 5;

// The fixed length of each Claude limit window, used to anchor the average-rate
// ETA (windowStart = resetsAt - period). The session (5-hour) and weekly (7-day)
// windows are fixed-period and reset at resets_at.
export const FIVE_HOUR_PERIOD_MS = 5 * 60 * 60 * 1000;
export const SEVEN_DAY_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

// Don't project a limit ETA until at least this fraction of the window has elapsed:
// early in a window a tiny slice of behavior extrapolates wildly.
const MIN_ELAPSED_FRACTION = 0.1;

// A breach *warning* (popup) needs a far more trustworthy projection than the
// gauge: only once this fraction of the window has elapsed does the average rate
// reliably predict the rest. Below it, a heavy-then-idle start would falsely read
// as "on track to breach" — the early on-pace line is met by any small lead.
const BREACH_MIN_ELAPSED_FRACTION = 0.5;

// Milliseconds until utilization reaches 100%, extrapolating the AVERAGE consumption
// rate over the window so far — rate = utilization / elapsed, where the window
// started at (resetsAt - periodMs). This judges each window on its own timescale
// (a 7-day window over days, a 5-hour window over hours), so a single percentage
// tick can't manufacture an absurd ETA the way a short rolling slope did. Undefined
// when the window hasn't run long enough to project, is already full, or idle.
export function etaFromAverageRate(
  utilization: number,
  resetsAt: number | undefined,
  periodMs: number,
  now: number
): number | undefined {
  // Gate the 0/100 boundary on the rounded (displayed) value so a window shown as
  // "100%" never also advertises an ETA, and one shown as "0%" never does. Also bail
  // once the window has already reset (resetsAt in the past): the average-rate model
  // is only defined within the window, and a stale fallback reading could otherwise
  // present a past resets_at with non-zero utilization.
  const shown = Math.round(utilization);
  if (resetsAt === undefined || resetsAt <= now || periodMs <= 0 || shown <= 0 || shown >= 100) {
    return undefined;
  }
  const elapsed = now - (resetsAt - periodMs);
  if (elapsed < MIN_ELAPSED_FRACTION * periodMs) {
    return undefined;
  }
  const ratePerMs = utilization / elapsed; // percent per ms
  return (100 - utilization) / ratePerMs;
}

// Projected end-of-window utilization at the current average pace: where the
// percentage lands by reset if you keep going as you have this window so far
// (utilization extrapolated over the whole period). A live "how hard am I working"
// meter that stays coherent on any window — always a percentage, never a multi-day
// number — and works on any plan. Note projectedUtilization > 100 is exactly the
// breach condition, so the meter and the popup agree. Undefined when the window has
// reset, hasn't run long enough to project, or hasn't been used / is already full.
export function projectedUtilization(
  utilization: number,
  resetsAt: number | undefined,
  periodMs: number,
  now: number
): number | undefined {
  const shown = Math.round(utilization);
  if (resetsAt === undefined || resetsAt <= now || periodMs <= 0 || shown <= 0 || shown >= 100) {
    return undefined;
  }
  const elapsed = now - (resetsAt - periodMs);
  if (elapsed < MIN_ELAPSED_FRACTION * periodMs) {
    return undefined;
  }
  return (utilization * periodMs) / elapsed;
}

// True when the projected time-to-limit lands before the window's own reset, i.e.
// the user is on track to be cut off mid-window.
export function predictsBreachBeforeReset(
  etaMs: number | undefined,
  resetsAt: number | undefined,
  now: number
): boolean {
  if (etaMs === undefined || resetsAt === undefined) {
    return false;
  }
  const timeToReset = resetsAt - now;
  if (timeToReset <= 0) {
    return false;
  }
  return etaMs < timeToReset;
}

// The configured warning thresholds the current utilization has reached, ascending.
// Compares the rounded (status-bar-displayed) value so a shown "10%" matches a 10%
// threshold, rather than the raw underlying number disagreeing with the display.
export function crossedThresholds(utilization: number, thresholds: number[]): number[] {
  const shown = Math.round(utilization);
  return thresholds
    .filter((threshold) => shown >= threshold)
    .sort((a, b) => a - b);
}

export function formatEta(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60000));
  if (totalMinutes < 60) {
    return `~${totalMinutes}m`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    return `~${totalHours}h${String(totalMinutes % 60).padStart(2, '0')}m`;
  }
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours ? `~${days}d${hours}h` : `~${days}d`;
}

// Per-window state carried across refreshes by the controller: just the alert
// debounce and enough to detect a rollover. The ETA itself is stateless (derived
// from the window's current utilization, reset time, and period), so it is correct
// instantly on reload — no sample history to warm up.
export interface WindowState {
  firedThresholds: number[];
  breachWarned: boolean;
  lastResetsAt?: number;
  lastUtil?: number;
}

// How a window's forecast is presented in the status bar:
//  'projection' — always-on pace meter: the projected end-of-window % (used for 5h).
//  'risk'       — a time-to-limit ETA, shown only when genuinely on track to breach
//                 before reset and you're actively burning (used for the weekly).
//  'off'        — show nothing, and suppress that window's breach popup.
export type EtaMode = 'projection' | 'risk' | 'off';

export interface WindowInput {
  utilization: number;
  resetsAt?: number;
  periodMs: number; // the window's full length (5h / 7d), anchoring the ETA
  now: number;
  thresholds: number[];
  predictBreach: boolean;
  etaMode: EtaMode;
  // Whether usage has been recorded in the recent trailing window. The average-rate
  // ETA can't tell whether you're *still* burning; this does, so an idle window that
  // front-loaded its usage can't keep advertising "you'll hit it at this rate".
  recentlyActive: boolean;
}

export interface WindowOutcome {
  state: WindowState;
  etaMs?: number; // time-to-limit (for the breach message and the 'risk' annotation)
  projectedUtil?: number; // projected end-of-window % (for the 'projection' annotation)
  annotation: 'projection' | 'eta' | 'none'; // what, if anything, to show by the %
  fireThreshold?: number; // a threshold to notify on this tick, else undefined
  fireBreach: boolean;
}

export function emptyWindowState(): WindowState {
  return { firedThresholds: [], breachWarned: false };
}

// Folds one fresh limit reading into the prior window state: recomputes the ETA
// from the window's average rate and decides which alerts — if any — should fire.
// Each threshold/breach fires once per window; the debounce lives in memory per
// window (re-armed on reload). A reset (rising resetsAt or a large utilization
// drop) re-arms everything.
export function evaluateWindow(prev: WindowState, input: WindowInput): WindowOutcome {
  const { utilization, resetsAt, periodMs, now, thresholds, predictBreach, etaMode, recentlyActive } = input;

  const resetMoved =
    prev.lastResetsAt !== undefined && resetsAt !== undefined && resetsAt > prev.lastResetsAt;
  // The 5-hour window clears its resets_at right after rolling over (applyExpiry).
  // Only treat a vanished resets_at as a rollover when utilization corroborates it
  // (i.e. it didn't stay high) — otherwise resets_at merely dropping out of a payload
  // at unchanged high utilization would spuriously re-arm and re-fire a threshold.
  const resetCleared =
    prev.lastResetsAt !== undefined &&
    resetsAt === undefined &&
    (prev.lastUtil === undefined || utilization < prev.lastUtil);
  const dropped = prev.lastUtil !== undefined && utilization < prev.lastUtil - RESET_DROP_PTS;
  const rolledOver = resetMoved || resetCleared || dropped;

  let firedThresholds = rolledOver ? [] : prev.firedThresholds;
  let breachWarned = rolledOver ? false : prev.breachWarned;

  const etaMs = etaFromAverageRate(utilization, resetsAt, periodMs, now);
  const projectedUtil = projectedUtilization(utilization, resetsAt, periodMs, now);

  const crossed = crossedThresholds(utilization, thresholds);
  const newly = crossed.filter((threshold) => !firedThresholds.includes(threshold));
  const fireThreshold = newly.length ? Math.max(...newly) : undefined;
  firedThresholds = Array.from(new Set([...firedThresholds, ...crossed])).sort((a, b) => a - b);

  // "On track" = projected to hit the limit before reset (equivalently, projected
  // end-of-window % > 100). "At risk" additionally requires enough of the window to
  // have elapsed for that projection to be trustworthy, so an early heavy-then-idle
  // start can't read as on-track. The breach popup needs at-risk + recent activity.
  // The 5h 'projection' meter shows whenever a sane number can be computed (it self-
  // corrects as you idle); the weekly 'risk' ETA shows only when at-risk and active.
  const onTrack = predictsBreachBeforeReset(etaMs, resetsAt, now);
  const elapsed = resetsAt !== undefined ? now - (resetsAt - periodMs) : -1;
  const trustworthy = elapsed >= BREACH_MIN_ELAPSED_FRACTION * periodMs;
  const atRisk = onTrack && trustworthy;

  let annotation: 'projection' | 'eta' | 'none' = 'none';
  if (etaMode === 'projection' && projectedUtil !== undefined) {
    annotation = 'projection';
  } else if (etaMode === 'risk' && atRisk && recentlyActive && etaMs !== undefined) {
    annotation = 'eta';
  }

  const fireBreach = predictBreach && etaMode !== 'off' && atRisk && recentlyActive && !breachWarned;
  if (fireBreach) {
    breachWarned = true;
  }

  return {
    state: { firedThresholds, breachWarned, lastResetsAt: resetsAt, lastUtil: utilization },
    etaMs,
    projectedUtil,
    annotation,
    fireThreshold,
    fireBreach,
  };
}

/** Clean a user-supplied threshold list: drop non-numbers / out-of-range, dedup, sort. */
export function sanitizeThresholds(raw: unknown): number[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const valid = raw.filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 100
  );
  return Array.from(new Set(valid)).sort((a, b) => a - b);
}

export interface ModelAdvice {
  model: string;
  cheaperLabel: string;
  windowCostUsd: number; // total spend in the window
  modelCostUsd: number; // spend on the flagged model
  share: number; // flagged model's share of window spend (0-1)
  avgOutputTokens: number;
  messageCount: number;
  windowMs: number;
}

export interface AdviceOptions {
  minMessages?: number;
  minCostShare?: number;
  maxAvgOutput?: number;
  minWindowCostUsd?: number;
}

const ADVICE_DEFAULTS: Required<AdviceOptions> = {
  minMessages: 5,
  minCostShare: 0.6,
  maxAvgOutput: 300,
  minWindowCostUsd: 0.5,
};

// The next cheaper tier to suggest for a model, or undefined when it is already a
// budget tier (or unknown), in which case there is nothing to advise.
export function cheaperTier(model: string): string | undefined {
  const m = model.toLowerCase();
  if (m.includes('opus')) {
    return 'Sonnet';
  }
  if (m.includes('fable')) {
    return 'Opus or Sonnet';
  }
  if (m.includes('sonnet')) {
    return 'Haiku';
  }
  return undefined;
}

interface ModelAgg {
  cost: number;
  output: number;
  count: number;
}

// Flags when a window's spend is dominated by an expensive model that is mostly
// producing short replies — i.e. routine turns that a cheaper tier could serve.
// Returns undefined unless every guard (min spend, min turns, cost share, low
// average output) is met, so it stays a rare, deliberate hint rather than noise.
export function modelAdvice(
  records: UsageRecord[],
  now: number,
  windowMs: number,
  opts: AdviceOptions = {}
): ModelAdvice | undefined {
  const o = { ...ADVICE_DEFAULTS, ...opts };
  const start = now - windowMs;
  const groups = new Map<string, ModelAgg>();
  let total = 0;
  for (const record of records) {
    if (record.timestamp <= start || record.timestamp > now) {
      continue;
    }
    const cost = estimateCost(record.tokens, record.model);
    total += cost;
    const agg = groups.get(record.model) ?? { cost: 0, output: 0, count: 0 };
    agg.cost += cost;
    agg.output += record.tokens.output;
    agg.count += 1;
    groups.set(record.model, agg);
  }
  if (total < o.minWindowCostUsd) {
    return undefined;
  }

  let bestModel: string | undefined;
  let best: ModelAgg | undefined;
  for (const [model, agg] of groups) {
    if (!cheaperTier(model)) {
      continue;
    }
    if (!best || agg.cost > best.cost) {
      best = agg;
      bestModel = model;
    }
  }
  if (!best || bestModel === undefined) {
    return undefined;
  }

  const share = best.cost / total;
  const avgOutputTokens = best.count > 0 ? best.output / best.count : 0;
  if (best.count < o.minMessages || share < o.minCostShare || avgOutputTokens > o.maxAvgOutput) {
    return undefined;
  }
  return {
    model: bestModel,
    cheaperLabel: cheaperTier(bestModel)!,
    windowCostUsd: total,
    modelCostUsd: best.cost,
    share,
    avgOutputTokens,
    messageCount: best.count,
    windowMs,
  };
}
