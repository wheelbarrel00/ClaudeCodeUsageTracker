# Claude Code Usage Tracker

A VS Code / Cursor extension that tracks your Claude Code token usage and
estimated cost from your local logs, and shows it at a glance in the status bar.

> Status: early development. This is a skeleton — the data layer and dashboard
> are stubbed out and being built milestone by milestone.

## Features

**Now (scaffold)**
- Status-bar item (click to open the dashboard).
- Settings for refresh interval, currency, decimal places, and toggling the
  cost / token figures.

**Planned**
- Parse `~/.claude/projects/**/*.jsonl`, with live refresh via a file watcher.
- Today / This Month / All Time totals in a dashboard webview.
- Estimated cost from a per-model price table.
- Optional live 5-hour / weekly limit indicator.
- Per-project breakdown and simple charts.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claudeCodeUsageTracker.refreshIntervalSeconds` | `30` | How often to refresh usage data. |
| `claudeCodeUsageTracker.currency` | `USD` | Currency code for cost formatting. |
| `claudeCodeUsageTracker.decimalPlaces` | `2` | Decimal places for cost figures. |
| `claudeCodeUsageTracker.showCost` | `true` | Show today's estimated cost. |
| `claudeCodeUsageTracker.showTokens` | `true` | Show today's token count. |

## Development

```bash
npm install --include=dev   # install dev dependencies
npm run compile             # type-check + build to ./out
# then press F5 in VS Code / Cursor to launch the Extension Development Host
```

`npm run watch` keeps the compiler running while you work.

## License

MIT — see [LICENSE](./LICENSE).
