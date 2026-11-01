import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import * as os from 'os';
import * as path from 'path';
import { __setKeychainReaderForTests } from './credentials';
import { mapUsageData, PlanLimits } from './limitsReader';
import { emptySummary } from './types';

interface StubItem {
  id: string;
  text: string;
  visible: boolean;
  show(): void;
  hide(): void;
  dispose(): void;
}

const warnings: string[] = [];
let settings: Record<string, unknown> = {};
let items: StubItem[] = [];

const vscodeStub = {
  StatusBarAlignment: { Right: 2 },
  ThemeColor: class {
    constructor(readonly id: string) {}
  },
  window: {
    createStatusBarItem(id: string): StubItem {
      const item: StubItem = {
        id,
        text: '',
        visible: false,
        show() {
          this.visible = true;
        },
        hide() {
          this.visible = false;
        },
        dispose() {},
      };
      items.push(item);
      return item;
    },
    showWarningMessage(message: string): Promise<undefined> {
      warnings.push(message);
      return Promise.resolve(undefined);
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => (key in settings ? settings[key] : fallback),
    }),
  },
};

const moduleInternals = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const realLoad = moduleInternals._load;
moduleInternals._load = function (this: unknown, request: string, ...rest: unknown[]) {
  return request === 'vscode' ? vscodeStub : realLoad.call(this, request, ...rest);
};

process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), 'ccut-definitely-missing', String(process.pid));
__setKeychainReaderForTests(async () => undefined);

const { PredictionController } = require('./prediction');
const { StatusBarController } = require('./statusBar');
const { limitsSection } = require('./dashboard');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function row(kind: string, percent: number, resetsInMs: number, scope: unknown = null) {
  return {
    kind,
    group: kind === 'session' ? 'session' : 'weekly',
    percent,
    severity: 'normal',
    resets_at: new Date(Date.now() + resetsInMs).toISOString(),
    scope,
    is_active: false,
  };
}

const FABLE = { model: { id: null, display_name: 'Fable' }, surface: null };
const OPUS = { model: { id: null, display_name: 'Opus' }, surface: null };

function limitsFrom(rows: unknown[], fetchedAgoMs = 0): PlanLimits {
  return mapUsageData({ limits: rows }, Date.now() - fetchedAgoMs)!;
}

function reset(overrides: Record<string, unknown> = {}): void {
  warnings.length = 0;
  settings = overrides;
  items = [];
}

function render(limits: PlanLimits): StubItem[] {
  const prediction = new PredictionController().update([], limits);
  new StatusBarController().render(emptySummary(), limits, undefined, prediction);
  return items;
}

function itemText(id: string): string | undefined {
  const item = items.find((candidate) => candidate.id.endsWith(`.${id}`));
  return item?.visible ? item.text : undefined;
}

const WEEK_MIDWAY = 3 * DAY_MS;

test('with no 5-hour limit the status bar hides 5h and shows a weekly pace meter', () => {
  reset();
  render(limitsFrom([row('weekly_all', 30, WEEK_MIDWAY)]));
  assert.equal(itemText('fiveHourLimit'), undefined);
  assert.match(itemText('weeklyLimit') ?? '', /wk 30% → \d+%$/);
});

test('with a 5-hour limit the weekly stays quiet', () => {
  reset();
  render(limitsFrom([row('session', 5, 4 * HOUR_MS), row('weekly_all', 30, WEEK_MIDWAY)]));
  assert.match(itemText('fiveHourLimit') ?? '', /5h 5%/);
  assert.match(itemText('weeklyLimit') ?? '', /wk 30%$/);
});

test('a stale 5-hour reading never turns on the weekly pace meter', () => {
  reset();
  render(limitsFrom([row('session', 5, -45 * 60 * 1000), row('weekly_all', 30, WEEK_MIDWAY)], 50 * 60 * 1000));
  assert.equal(itemText('fiveHourLimit'), undefined);
  assert.match(itemText('weeklyLimit') ?? '', /wk 30%$/);
});

test('turning off showWeeklyEta hides the weekly pace meter too', () => {
  reset({ 'predictiveAlerts.showWeeklyEta': false });
  render(limitsFrom([row('weekly_all', 30, WEEK_MIDWAY)]));
  assert.match(itemText('weeklyLimit') ?? '', /wk 30%$/);
});

test('crossing a threshold on the Fable limit warns once per window', () => {
  reset();
  const limits = limitsFrom([row('weekly_all', 30, WEEK_MIDWAY), row('weekly_scoped', 80, WEEK_MIDWAY, FABLE)]);
  const predictor = new PredictionController();
  predictor.update([], limits);
  predictor.update([], limits);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^Claude Fable weekly limit at 80% \(warning at 75%\)/);
});

test('two limits with the same name keep separate warning state', () => {
  reset();
  const limits = limitsFrom([row('weekly_scoped', 80, WEEK_MIDWAY, FABLE), row('weekly_scoped', 3, WEEK_MIDWAY, FABLE)]);
  const predictor = new PredictionController();
  predictor.update([], limits);
  predictor.update([], limits);
  predictor.update([], limits);
  assert.equal(warnings.length, 1);
});

test('a per-model limit keeps its warning state when the rows change order', () => {
  reset();
  const fable = row('weekly_scoped', 80, WEEK_MIDWAY, FABLE);
  const opus = row('weekly_scoped', 80, WEEK_MIDWAY, OPUS);
  const predictor = new PredictionController();
  predictor.update([], limitsFrom([fable, opus]));
  predictor.update([], limitsFrom([opus, fable]));
  assert.equal(warnings.length, 2);
});

test('a per-model limit keeps its warning state when an earlier row goes unreadable', () => {
  reset();
  const fable = row('weekly_scoped', 80, WEEK_MIDWAY, FABLE);
  const opus = row('weekly_scoped', 80, WEEK_MIDWAY, OPUS);
  const predictor = new PredictionController();
  predictor.update([], limitsFrom([opus, fable]));
  predictor.update([], limitsFrom([{ ...opus, percent: null }, fable]));
  assert.equal(warnings.length, 2);
});

test('a per-model limit never fires a pace warning', () => {
  reset();
  const limits = limitsFrom([row('weekly_all', 1, WEEK_MIDWAY), row('weekly_scoped', 70, WEEK_MIDWAY, FABLE)]);
  const records = [{ timestamp: Date.now(), model: 'claude-fable-5-1', tokens: { input: 1, output: 1, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 } }];
  new PredictionController().update(records, limits);
  assert.deepEqual(warnings, []);
});

test('the model limit stays off the status bar by default', () => {
  reset();
  render(limitsFrom([row('weekly_all', 30, WEEK_MIDWAY), row('weekly_scoped', 12, WEEK_MIDWAY, FABLE)]));
  assert.equal(itemText('modelWeeklyLimit'), undefined);
});

test('showModelWeekly shows the most-used model limit by its own name', () => {
  reset({ showModelWeekly: true });
  render(limitsFrom([row('weekly_scoped', 12, WEEK_MIDWAY, FABLE), row('weekly_scoped', 40, WEEK_MIDWAY, OPUS)]));
  assert.match(itemText('modelWeeklyLimit') ?? '', /opus 40%$/);
});

test('the deprecated showOpusWeekly still turns the model limit on', () => {
  reset({ showOpusWeekly: true });
  render(limitsFrom([row('weekly_scoped', 12, WEEK_MIDWAY, FABLE)]));
  assert.match(itemText('modelWeeklyLimit') ?? '', /fable 12%$/);
});

test('no model limit means no model item, even with the setting on', () => {
  reset({ showModelWeekly: true });
  render(limitsFrom([row('weekly_all', 30, WEEK_MIDWAY)]));
  assert.equal(itemText('modelWeeklyLimit'), undefined);
});

test('the dashboard shows what a per-model limit covers, beside its reset', () => {
  const limits = mapUsageData(
    {
      five_hour: null,
      limits: [row('weekly_all', 10, WEEK_MIDWAY), row('weekly_scoped', 0, WEEK_MIDWAY, FABLE)],
      weekly_scoped_shares: [{ limit_index: 1, allowance_percent_of_weekly: 50 }],
    },
    Date.now()
  );
  const html = limitsSection(limits, [75, 90]);
  assert.match(html, /Weekly · Fable/);
  assert.match(html, /Up to 50% of your weekly limit · resets in 3d/);
  assert.doesNotMatch(html, /5-hour/);
});
