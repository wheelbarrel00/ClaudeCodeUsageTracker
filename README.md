<p align="center">
  <img src="icon.png" alt="Claude Code Usage Tracker" width="120" />
</p>

<h1 align="center">Claude Code Usage Tracker</h1>

<p align="center">
  A VS Code / Cursor extension that tracks your Claude Code plan-limit usage,
  token counts, and estimated cost from your local logs &mdash; in the status
  bar and a dashboard.
</p>

<p align="center">
  <img src="images/stats.png" alt="Claude Code Usage dashboard" width="900" />
</p>

## Features

- **Status bar** &mdash; plan-limit utilization (5-hour + weekly), today's estimated cost, and token count, always visible. Each segment toggles independently, and the bar tints when Claude flags you as near a limit. Click to open the dashboard.
- **Plan limits** &mdash; real 5h / weekly usage read from Claude Code's own server-computed cache, with reset times, per-model scoped windows, and an optional weekly-Opus readout.
- **Dashboard** &mdash; a Plan limits section (bars + reset times) above Today / This Month / All Time cards with a full input / output / cache-write / cache-read token breakdown.
- **Per-model and per-project breakdowns** &mdash; see where your tokens and spend actually go.
- **Live updates** &mdash; file watchers over your logs and the limits cache refresh the moment Claude Code writes, with a timer as a fallback.
- **Cost estimates** &mdash; from a per-model price table, with prefix matching for dated and suffixed model ids.

## How it works

Claude Code writes a JSONL transcript per session under `~/.claude/projects`. The
extension walks those logs, parses each line into a per-message usage record, and
deduplicates the entries that repeat once per content block. Records are
aggregated by day, month, and all-time, and grouped by model and project, then
priced with a per-model rate table.

Plan limits come from a second source: `~/.claude/usage-cache.json`, the live
cache Claude Code keeps of the server's own limit math. Its 5-hour and weekly
utilization figures are already 0&ndash;100, so the extension shows them as-is
(and mirrors the server's severity for the warning tint) rather than inventing
thresholds of its own.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claudeCodeUsageTracker.refreshIntervalSeconds` | `30` | How often to refresh usage data. |
| `claudeCodeUsageTracker.currency` | `USD` | Currency code for cost formatting. |
| `claudeCodeUsageTracker.decimalPlaces` | `2` | Decimal places for cost figures. |
| `claudeCodeUsageTracker.showLimits` | `true` | Show 5-hour and weekly plan-limit utilization. |
| `claudeCodeUsageTracker.showOpusWeekly` | `false` | Also append the weekly Opus limit (`opus NN%`) when a live Opus window exists. |
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
