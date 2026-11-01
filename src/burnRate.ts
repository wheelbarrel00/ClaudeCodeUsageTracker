import { UsageRecord, TokenCounts, totalTokens } from './types';
import { estimateCost, cheaperTier } from './pricing';

export interface BurnRate {
  tokensPerMin: number;
  newTokensPerMin: number;
  cacheReadPerMin: number;
  costPerMin: number;
  windowTokens: number;
  windowCostUsd: number;
  windowMs: number;
  recordCount: number;
}

function newTokens(t: TokenCounts): number {
  return t.input + t.output + t.cacheWrite;
}

export function burnRate(records: UsageRecord[], now: number, windowMs: number): BurnRate {
  const start = now - windowMs;
  let windowTokens = 0;
  let windowNewTokens = 0;
  let windowCostUsd = 0;
  let recordCount = 0;
  for (const record of records) {
    if (record.timestamp <= start || record.timestamp > now) {
      continue;
    }
    windowTokens += totalTokens(record.tokens);
    windowNewTokens += newTokens(record.tokens);
    windowCostUsd += estimateCost(record.tokens, record.model, record.speed);
    recordCount++;
  }
  const minutes = windowMs / 60000;
  const per = (total: number): number => (minutes > 0 ? total / minutes : 0);
  return {
    tokensPerMin: per(windowTokens),
    newTokensPerMin: per(windowNewTokens),
    cacheReadPerMin: per(windowTokens - windowNewTokens),
    costPerMin: per(windowCostUsd),
    windowTokens,
    windowCostUsd,
    windowMs,
    recordCount,
  };
}

const RESET_DROP_PTS = 5;

const RESET_FLOOR_PCT = 10;

export const FIVE_HOUR_PERIOD_MS = 5 * 60 * 60 * 1000;
export const SEVEN_DAY_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

const PROJECTION_MIN_ELAPSED_FRACTION = 0.1;

const CONFIDENCE_FULL_FRACTION = 0.5;

export const ON_PACE_BAND_PTS = 10;

export function etaFromAverageRate(
  utilization: number,
  resetsAt: number | undefined,
  periodMs: number,
  now: number
): number | undefined {
  // NaN slips past every comparison below.
  const shown = Math.round(utilization);
  if (
    resetsAt === undefined ||
    resetsAt <= now ||
    periodMs <= 0 ||
    !Number.isFinite(utilization) ||
    shown <= 0 ||
    shown >= 100
  ) {
    return undefined;
  }
  const elapsed = now - (resetsAt - periodMs);
  if (elapsed < CONFIDENCE_FULL_FRACTION * periodMs) {
    return undefined;
  }
  const ratePerMs = utilization / elapsed;
  return (100 - utilization) / ratePerMs;
}

// The meter shows damped; verdicts use raw, so damping never turns an alarm into reassurance.
function projections(
  utilization: number,
  resetsAt: number | undefined,
  periodMs: number,
  now: number
): { raw: number; damped: number } | undefined {
  const shown = Math.round(utilization);
  if (
    resetsAt === undefined ||
    resetsAt <= now ||
    periodMs <= 0 ||
    !Number.isFinite(utilization) ||
    shown <= 0 ||
    shown >= 100
  ) {
    return undefined;
  }
  const elapsed = now - (resetsAt - periodMs);
  if (elapsed < PROJECTION_MIN_ELAPSED_FRACTION * periodMs) {
    return undefined;
  }
  const raw = (utilization * periodMs) / elapsed;
  const confidence = Math.min(1, elapsed / (CONFIDENCE_FULL_FRACTION * periodMs));
  return { raw, damped: utilization + (raw - utilization) * confidence };
}

export function projectedUtilization(
  utilization: number,
  resetsAt: number | undefined,
  periodMs: number,
  now: number
): number | undefined {
  return projections(utilization, resetsAt, periodMs, now)?.damped;
}

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

// Rounded like the status bar, so a shown "10%" trips a 10% threshold.
export function crossedThresholds(utilization: number, thresholds: number[]): number[] {
  const shown = Math.round(utilization);
  return thresholds
    .filter((threshold) => shown >= threshold)
    .sort((a, b) => a - b);
}

export function describeProjection(
  projectedUtil: number,
  rawUtil = projectedUtil
): { segment: string; detail: string } {
  if (Math.abs(rawUtil - 100) <= ON_PACE_BAND_PTS) {
    return { segment: '· on pace', detail: 'on pace to use this window fully' };
  }
  const pct = Math.round(Math.min(projectedUtil, 999));
  return { segment: `→ ${pct}%`, detail: `projected ~${pct}% by reset` };
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

export interface WindowState {
  firedThresholds: number[];
  breachWarned: boolean;
  lastResetsAt?: number;
  lastUtil?: number;
}

export type EtaMode = 'projection' | 'risk' | 'off';

export function effectiveWeeklyMode(configured: EtaMode, hasSessionLimit: boolean): EtaMode {
  return configured === 'risk' && !hasSessionLimit ? 'projection' : configured;
}

export interface WindowInput {
  utilization: number;
  resetsAt?: number;
  periodMs: number;
  now: number;
  thresholds: number[];
  predictBreach: boolean;
  etaMode: EtaMode;
  recentlyActive: boolean;
}

export interface WindowOutcome {
  state: WindowState;
  etaMs?: number;
  projectedUtil?: number;
  rawProjectedUtil?: number;
  annotation: 'projection' | 'eta' | 'none';
  fireThreshold?: number;
  fireBreach: boolean;
}

export function emptyWindowState(): WindowState {
  return { firedThresholds: [], breachWarned: false };
}

export function evaluateWindow(prev: WindowState, input: WindowInput): WindowOutcome {
  const { utilization, resetsAt, periodMs, now, thresholds, predictBreach, etaMode, recentlyActive } = input;

  // resets_at jitters sub-second between fetches; a real rollover moves it about a full period.
  const resetMoved =
    prev.lastResetsAt !== undefined && resetsAt !== undefined && resetsAt - prev.lastResetsAt > periodMs / 2;
  // The 5-hour window clears its resets_at right after rolling over (applyExpiry).
  const resetCleared =
    prev.lastResetsAt !== undefined &&
    resetsAt === undefined &&
    (prev.lastUtil === undefined || utilization <= RESET_FLOOR_PCT);
  const dropped =
    prev.lastUtil !== undefined &&
    utilization < prev.lastUtil - RESET_DROP_PTS &&
    utilization <= RESET_FLOOR_PCT;
  const resetAppeared =
    prev.lastResetsAt === undefined &&
    resetsAt !== undefined &&
    prev.lastUtil !== undefined &&
    utilization < prev.lastUtil - RESET_DROP_PTS;
  const rolledOver = resetMoved || resetCleared || resetAppeared || dropped;

  let firedThresholds = rolledOver ? [] : prev.firedThresholds;
  let breachWarned = rolledOver ? false : prev.breachWarned;

  const etaMs = etaFromAverageRate(utilization, resetsAt, periodMs, now);
  const projection = projections(utilization, resetsAt, periodMs, now);
  const projectedUtil = projection?.damped;

  const crossed = crossedThresholds(utilization, thresholds);
  const newly = crossed.filter((threshold) => !firedThresholds.includes(threshold));
  const fireThreshold = newly.length ? Math.max(...newly) : undefined;
  firedThresholds = Array.from(new Set([...firedThresholds, ...crossed])).sort((a, b) => a - b);

  // Past the on-pace band, so a breach popup never contradicts an "on pace" meter.
  const atRisk =
    predictsBreachBeforeReset(etaMs, resetsAt, now) &&
    projectedUtil !== undefined &&
    projectedUtil > 100 + ON_PACE_BAND_PTS;

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
    rawProjectedUtil: projection?.raw,
    annotation,
    fireThreshold,
    fireBreach,
  };
}

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
  windowCostUsd: number;
  modelCostUsd: number;
  share: number;
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

interface ModelAgg {
  cost: number;
  output: number;
  count: number;
}

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
    const cost = estimateCost(record.tokens, record.model, record.speed);
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
