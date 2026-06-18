<p align="center">
  <img src="icon.png" alt="Claude Code Usage Tracker" width="120" />
</p>

<h1 align="center">Claude Code Usage Tracker</h1>

<p align="center">
  A VS Code / Cursor extension that tracks your Claude Code token usage and
  estimated cost from your local logs &mdash; in the status bar and a dashboard.
</p>

## Features

- **Status bar** &mdash; today's estimated cost and token count, always visible. Click to open the dashboard.
- **Live updates** &mdash; a file watcher refreshes the moment Claude Code writes new logs, with a timer as a fallback.
- **Dashboard** &mdash; Today / This Month / All Time cards with a full input / output / cache-write / cache-read token breakdown.
- **Per-model and per-project breakdowns** &mdash; see where your tokens and spend actually go.
- **Cost estimates** &mdash; from a per-model price table, with prefix matching for dated and suffixed model ids.

## How it works

Claude Code writes a JSONL transcript per session under `~/.claude/projects`. The
extension walks those logs, parses each line into a per-message usage record, and
deduplicates the entries that repeat once per content block. Records are
aggregated by day, month, and all-time, and grouped by model and project, then
priced with a per-model rate table.

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

MIT &mdash; see [LICENSE](./LICENSE).
