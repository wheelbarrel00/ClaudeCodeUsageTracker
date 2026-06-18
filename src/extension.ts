import * as vscode from 'vscode';
import { StatusBarController } from './statusBar';
import { Dashboard } from './dashboard';
import { loadUsageRecords, summarize, filterToday } from './dataLoader';
import { UsageSummary, emptySummary } from './types';

const CONFIG_SECTION = 'claudeCodeUsageTracker';

let statusBar: StatusBarController;
let dashboard: Dashboard;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let latest: UsageSummary = emptySummary();

export function activate(context: vscode.ExtensionContext): void {
  statusBar = new StatusBarController();
  dashboard = new Dashboard();

  context.subscriptions.push(
    statusBar,
    dashboard,
    { dispose: stopRefresh },
    vscode.commands.registerCommand(`${CONFIG_SECTION}.refresh`, () => void refresh()),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.showDashboard`, () => dashboard.show(latest)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        statusBar.render(latest);
        scheduleRefresh();
      }
    })
  );

  void refresh();
  scheduleRefresh();
}

export function deactivate(): void {
  stopRefresh();
}

async function refresh(): Promise<void> {
  const records = await loadUsageRecords();
  latest = summarize(filterToday(records));
  statusBar.render(latest);
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
