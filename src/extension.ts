import * as path from 'path';
import * as vscode from 'vscode';
import { StatusBarController } from './statusBar';
import { Dashboard } from './dashboard';
import { loadUsageRecords, summarize, filterToday, currentContext, claudeLogRoot, ContextInfo } from './dataLoader';
import { loadPlanLimits, usageCachePath, PlanLimits } from './limitsReader';
import { fetchLiveLimits } from './usageApi';
import { UsageRecord, UsageSummary, emptySummary } from './types';

const CONFIG_SECTION = 'claudeCodeUsageTracker';

let statusBar: StatusBarController;
let dashboard: Dashboard;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let watchDebounce: ReturnType<typeof setTimeout> | undefined;
let refreshInFlight = false;
let refreshAgain = false;
let latest: UsageSummary = emptySummary();
let latestRecords: UsageRecord[] = [];
let latestLimits: PlanLimits | undefined;
let latestContext: ContextInfo | undefined;

export function activate(context: vscode.ExtensionContext): void {
  statusBar = new StatusBarController();
  dashboard = new Dashboard();

  context.subscriptions.push(
    statusBar,
    dashboard,
    { dispose: stopRefresh },
    vscode.commands.registerCommand(`${CONFIG_SECTION}.refresh`, () => void refresh()),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.showDashboard`, () => dashboard.show(latestRecords, latestLimits)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        statusBar.render(latest, latestLimits, latestContext);
        dashboard.update(latestRecords, latestLimits);
        scheduleRefresh();
      }
    })
  );

  void refresh();
  scheduleRefresh();
  startWatcher(context);
}

export function deactivate(): void {
  stopRefresh();
}

async function refresh(): Promise<void> {
  if (refreshInFlight) {
    refreshAgain = true;
    return;
  }
  refreshInFlight = true;
  try {
    do {
      refreshAgain = false;
      const [records, limits] = await Promise.all([loadUsageRecords(), getPlanLimits()]);
      latestRecords = records;
      latestLimits = limits;
      latestContext = currentContext(records);
      latest = summarize(filterToday(records));
      statusBar.render(latest, latestLimits, latestContext);
      dashboard.update(latestRecords, latestLimits);
    } while (refreshAgain);
  } finally {
    refreshInFlight = false;
  }
}

async function getPlanLimits(): Promise<PlanLimits | undefined> {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  if (cfg.get<boolean>('useLiveApi', true)) {
    const minInterval = Math.max(60, cfg.get<number>('liveApiMinIntervalSeconds', 180)) * 1000;
    try {
      const live = await withTimeout(fetchLiveLimits(minInterval), 30000);
      if (live) {
        return live;
      }
    } catch {
      // fall back to the on-disk cache
    }
  }
  return loadPlanLimits();
}

// Backstop so a stuck live fetch can never leave refreshInFlight wedged.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('live fetch timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function scheduleRefresh(): void {
  stopRefresh();
  const seconds = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<number>('refreshIntervalSeconds', 30);
  refreshTimer = setInterval(() => void refresh(), Math.max(5, seconds) * 1000);
}

function stopRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}

function startWatcher(context: vscode.ExtensionContext): void {
  context.subscriptions.push({ dispose: clearWatchDebounce });
  watchGlob(context, claudeLogRoot(), '**/*.jsonl');
  watchGlob(context, path.dirname(usageCachePath()), path.basename(usageCachePath()));
}

function watchGlob(context: vscode.ExtensionContext, base: string, glob: string): void {
  let watcher: vscode.FileSystemWatcher;
  try {
    const pattern = new vscode.RelativePattern(vscode.Uri.file(base), glob);
    watcher = vscode.workspace.createFileSystemWatcher(pattern);
  } catch {
    return;
  }
  const onActivity = () => scheduleWatchRefresh();
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(onActivity),
    watcher.onDidChange(onActivity),
    watcher.onDidDelete(onActivity)
  );
}

function scheduleWatchRefresh(): void {
  clearWatchDebounce();
  watchDebounce = setTimeout(() => {
    watchDebounce = undefined;
    void refresh();
  }, 750);
}

function clearWatchDebounce(): void {
  if (watchDebounce) {
    clearTimeout(watchDebounce);
    watchDebounce = undefined;
  }
}
