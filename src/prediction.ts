import * as vscode from 'vscode';
import { UsageRecord } from './types';
import { PlanLimits, LimitWindow, formatReset } from './limitsReader';
import { familyLabel } from './pricing';
import { formatCurrency } from './format';
import { t } from './l10n';
import { numberSetting, ACTIVITY_WINDOW_MIN } from './settings';
import {
  burnRate,
  evaluateWindow,
  emptyWindowState,
  effectiveWeeklyMode,
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
    const weeklyMode = effectiveWeeklyMode(cfg.weeklyEtaMode, limits?.hasSessionLimit ?? true);
    const sameName = new Map<string, number>();
    for (const scoped of limits?.scoped ?? []) {
      const occurrence = sameName.get(scoped.label) ?? 0;
      sameName.set(scoped.label, occurrence + 1);
      this.evaluate(`scoped:${scoped.label}:${occurrence}`, t('{0} weekly', scoped.label), scoped, SEVEN_DAY_PERIOD_MS, 'off', recentlyActive, cfg, now);
    }
    return {
      enabled: true,
      burn,
      fiveHour: this.evaluate(FIVE_HOUR, t('5-hour'), limits?.fiveHour, FIVE_HOUR_PERIOD_MS, cfg.fiveHourEtaMode, recentlyActive, cfg, now),
      sevenDay: this.evaluate(SEVEN_DAY, t('weekly'), limits?.sevenDay, SEVEN_DAY_PERIOD_MS, weeklyMode, recentlyActive, cfg, now),
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
      detail = t('{0} to limit', eta);
    }
    return { etaMs: outcome.etaMs, segment, detail };
  }

  dispose(): void {
    this.states.clear();
  }
}

function notifyThreshold(label: string, threshold: number, window: LimitWindow): void {
  const reset = formatReset(window.resetsAt);
  const used = Math.round(window.utilization);
  void vscode.window.showWarningMessage(
    reset
      ? t('Claude {0} limit at {1}% (warning at {2}%) — {3}.', label, used, threshold, reset)
      : t('Claude {0} limit at {1}% (warning at {2}%).', label, used, threshold)
  );
}

function notifyBreach(label: string, etaMs: number, window: LimitWindow): void {
  const reset = formatReset(window.resetsAt);
  const eta = formatEta(etaMs);
  void vscode.window.showWarningMessage(
    reset
      ? t("At this rate you'll hit the Claude {0} limit in {1}, before it {2}.", label, eta, reset)
      : t("At this rate you'll hit the Claude {0} limit in {1}.", label, eta)
  );
}

function notifyAdvice(advice: ModelAdvice, currency: string, decimals: number): void {
  const minutes = Math.round(advice.windowMs / 60000);
  const spend = formatCurrency(advice.modelCostUsd, currency, decimals);
  const message = t(
    'Mostly short {0} turns lately ({1} over ~{2}m). A cheaper model like {3} could handle routine work for less.',
    familyLabel(advice.model),
    spend,
    minutes,
    advice.cheaperLabel
  );
  const dontShowAgain = t("Don't show again");
  void vscode.window.showInformationMessage(message, dontShowAgain).then((choice) => {
    if (choice === dontShowAgain) {
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
