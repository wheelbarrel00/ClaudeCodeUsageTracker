import * as vscode from 'vscode';
import { UsageRecord } from './types';
import { PlanLimits, LimitWindow, formatReset } from './limitsReader';
import { familyLabel } from './pricing';
import { formatCurrency } from './format';
import { numberSetting, ACTIVITY_WINDOW_MIN } from './settings';
import {
  burnRate,
  evaluateWindow,
  emptyWindowState,
  sanitizeThresholds,
  modelAdvice,
  describeProjection,
  formatEta,
  FIVE_HOUR_PERIOD_MS,
  SEVEN_DAY_PERIOD_MS,
  BurnRate,
  EtaMode,
  ModelAdvice,
  WindowState,
} from './burnRate';

const CONFIG_SECTION = 'claudeCodeUsageTracker';
const ADVICE_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const DONT_SHOW_AGAIN = "Don't show again";

export interface WindowEta {
  etaMs?: number;
  segment?: string;
  detail?: string;
}

export interface PredictionView {
  enabled: boolean;
  burn?: BurnRate;
  fiveHour?: WindowEta;
  sevenDay?: WindowEta;
}

interface PredictionConfig {
  enabled: boolean;
  windowMs: number;
  thresholds: number[];
  predictBreach: boolean;
  fiveHourEtaMode: EtaMode;
  weeklyEtaMode: EtaMode;
  modelAdvisor: boolean;
  currency: string;
  decimals: number;
}

const FIVE_HOUR = 'fiveHour';
const SEVEN_DAY = 'sevenDay';

export class PredictionController {
  private readonly states = new Map<string, WindowState>();
  private advisedAt = 0;

  update(records: UsageRecord[], limits: PlanLimits | undefined, now = Date.now()): PredictionView {
    const cfg = readConfig();
    if (!cfg.enabled) {
      this.states.clear();
      return { enabled: false };
    }
    if (cfg.modelAdvisor) {
      this.maybeAdvise(modelAdvice(records, now, cfg.windowMs), cfg, now);
    }
    const burn = burnRate(records, now, cfg.windowMs);
    const recentlyActive = burn.recordCount > 0;
    return {
      enabled: true,
      burn,
      fiveHour: this.evaluate(FIVE_HOUR, '5-hour', limits?.fiveHour, FIVE_HOUR_PERIOD_MS, cfg.fiveHourEtaMode, recentlyActive, cfg, now),
      sevenDay: this.evaluate(SEVEN_DAY, 'weekly', limits?.sevenDay, SEVEN_DAY_PERIOD_MS, cfg.weeklyEtaMode, recentlyActive, cfg, now),
    };
  }

  private maybeAdvise(advice: ModelAdvice | undefined, cfg: PredictionConfig, now: number): void {
    if (!advice) {
      return;
    }
    if (now - this.advisedAt < ADVICE_COOLDOWN_MS) {
      return;
    }
    this.advisedAt = now;
    notifyAdvice(advice, cfg.currency, cfg.decimals);
  }

  private evaluate(
    id: string,
    label: string,
    window: LimitWindow | undefined,
    periodMs: number,
    etaMode: EtaMode,
    recentlyActive: boolean,
    cfg: PredictionConfig,
    now: number
  ): WindowEta | undefined {
    if (!window) {
      // Keep the debounce through a brief data gap so the window's reappearance doesn't re-fire an alert.
      return undefined;
    }
    const outcome = evaluateWindow(this.states.get(id) ?? emptyWindowState(), {
      utilization: window.utilization,
      resetsAt: window.resetsAt,
      periodMs,
      now,
      thresholds: cfg.thresholds,
      predictBreach: cfg.predictBreach,
      etaMode,
      recentlyActive,
    });
    this.states.set(id, outcome.state);

    if (outcome.fireThreshold !== undefined) {
      notifyThreshold(label, outcome.fireThreshold, window);
    }
    if (outcome.fireBreach && outcome.etaMs !== undefined) {
      notifyBreach(label, outcome.etaMs, window);
    }

    let segment: string | undefined;
    let detail: string | undefined;
    if (outcome.annotation === 'projection' && outcome.projectedUtil !== undefined) {
      ({ segment, detail } = describeProjection(outcome.projectedUtil, outcome.rawProjectedUtil));
    } else if (outcome.annotation === 'eta' && outcome.etaMs !== undefined) {
      const eta = formatEta(outcome.etaMs);
      segment = `· ${eta}`;
      detail = `${eta} to limit`;
    }
    return { etaMs: outcome.etaMs, segment, detail };
  }

  dispose(): void {
    this.states.clear();
  }
}

function notifyThreshold(label: string, threshold: number, window: LimitWindow): void {
  const reset = formatReset(window.resetsAt);
  const tail = reset ? ` — ${reset}.` : '.';
  void vscode.window.showWarningMessage(
    `Claude ${label} limit at ${Math.round(window.utilization)}% (warning at ${threshold}%)${tail}`
  );
}

function notifyBreach(label: string, etaMs: number, window: LimitWindow): void {
  const reset = formatReset(window.resetsAt);
  const tail = reset ? `, before it ${reset}` : '';
  void vscode.window.showWarningMessage(
    `At this rate you'll hit the Claude ${label} limit in ${formatEta(etaMs)}${tail}.`
  );
}

function notifyAdvice(advice: ModelAdvice, currency: string, decimals: number): void {
  const minutes = Math.round(advice.windowMs / 60000);
  const spend = formatCurrency(advice.modelCostUsd, currency, decimals);
  const message =
    `Mostly short ${familyLabel(advice.model)} turns lately (${spend} over ~${minutes}m). ` +
    `A cheaper model like ${advice.cheaperLabel} could handle routine work for less.`;
  void vscode.window.showInformationMessage(message, DONT_SHOW_AGAIN).then((choice) => {
    if (choice === DONT_SHOW_AGAIN) {
      void vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .update('predictiveAlerts.modelAdvisor.enabled', false, vscode.ConfigurationTarget.Global);
    }
  });
}

function readConfig(): PredictionConfig {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const minutes = numberSetting(cfg.get('predictiveAlerts.windowMinutes'), ACTIVITY_WINDOW_MIN);
  const fiveHourEtaMode: EtaMode = cfg.get<boolean>('predictiveAlerts.showFiveHourEta', true) ? 'projection' : 'off';
  const weeklyEtaMode: EtaMode = cfg.get<boolean>('predictiveAlerts.showWeeklyEta', true) ? 'risk' : 'off';
  return {
    enabled: cfg.get<boolean>('predictiveAlerts.enabled', true),
    windowMs: minutes * 60000,
    thresholds: sanitizeThresholds(cfg.get<number[]>('predictiveAlerts.warnThresholds', [75, 90])),
    predictBreach: cfg.get<boolean>('predictiveAlerts.predictBreach', true),
    fiveHourEtaMode,
    weeklyEtaMode,
    modelAdvisor: cfg.get<boolean>('predictiveAlerts.modelAdvisor.enabled', false),
    currency: cfg.get<string>('currency', 'USD'),
    decimals: cfg.get<number>('decimalPlaces', 2),
  };
}
