import * as vscode from 'vscode';
import { UsageSummary } from './types';

/** Opens (or reveals) the dashboard webview. Minimal scaffold for now. */
export class Dashboard {
  private panel: vscode.WebviewPanel | undefined;

  show(summary: UsageSummary): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'claudeCodeUsageTracker.dashboard',
        'Claude Code Usage',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
    }
    this.panel.webview.html = this.render(summary);
  }

  // TODO (later milestone): build a real dashboard — Today / This Month /
  // All Time totals, per-project breakdown, and charts. Pull the markup into
  // a proper webview with a content security policy and a script bundle.
  private render(summary: UsageSummary): string {
    const cost = summary.costUsd.toFixed(2);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Claude Code Usage</title>
</head>
<body style="font-family: var(--vscode-font-family); padding: 1.5rem;">
  <h1>Claude Code Usage</h1>
  <p>Dashboard scaffold &mdash; real metrics coming soon.</p>
  <p>Today (estimated): <strong>$${cost}</strong> across ${summary.messageCount} messages.</p>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
