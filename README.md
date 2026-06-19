<p align="center">
  <img src="images/logo.png" alt="Claude Code Usage Tracker" width="480" />
</p>

<p align="center">
  A VS Code / Cursor extension that surfaces your Claude Code plan-limit usage,
  context window, token counts, estimated cost, and usage trends from your local
  logs &mdash; in the status bar and a dashboard.
</p>

<p align="center">
  <img src="images/statusbar.png" alt="Status bar showing plan limits, context, cost, and tokens" width="460" />
</p>

<p align="center">
  <sub>Plan limits, context, cost, and tokens at a glance &mdash; right in the editor status bar.</sub>
</p>

<p align="center">
  <img src="images/stats.png" alt="Claude Code Usage dashboard" width="900" />
</p>

## Features

- **Status bar** &mdash; plan-limit utilization (5-hour + weekly, optional weekly-Opus), each led by a Claude sunburst that turns green / yellow / red as Claude flags that window, plus the current session's context-window fill, today's estimated cost, and token count. Each segment toggles independently. Click any of them to open the dashboard.
- **Plan limits** &mdash; real 5h / weekly usage read from Claude Code's own server-computed cache, with reset times and per-model scoped windows, shown as bars in the dashboard.
- **Context window** &mdash; the latest request's prompt size as a percent of the model's window (like `/context`), with 1M-tier detection.
- **Dashboard** &mdash; Today / This Month / All Time cards with a full input / output / cache-write / cache-read token breakdown, cache-hit rate, and a cost-composition bar. Below them, sortable breakdowns: **by model**, **by project** (grouped by git repo, folder, or path), **by git branch**, and **by session** (titles, peak context, active-time duration).
- **Trend** &mdash; a bar chart of usage over time: daily across the current month or monthly across all time, switchable between cost and tokens, with the current day highlighted and a running total / peak summary. Empty days and months are filled in, so gaps in usage stay visible.
- **Live updates** &mdash; file watchers over your logs and the limits cache refresh the moment Claude Code writes, with a timer as a fallback.
- **Cost estimates** &mdash; from a per-model price table, with prefix matching for dated and suffixed model ids.

## How it works

Claude Code writes a JSONL transcript per session under `~/.claude/projects`. The
extension walks those logs and parses each line into a per-message usage record
&mdash; capturing model, working directory, git branch, and session id &mdash;
deduplicating the entries that repeat once per content block. Records are
aggregated by day, month, and all-time, and grouped by model, project, branch,
and session, then priced with a per-model rate table. The daily and monthly
aggregates feed the trend chart; the rest feed the cards and breakdown tables.

Plan limits come from a second source: `~/.claude/usage-cache.json`, the live
cache Claude Code keeps of the server's own limit math. Its 5-hour and weekly
utilization figures are already 0&ndash;100, so the extension shows them as-is
(and mirrors the server's severity for the warning tint) rather than inventing
thresholds of its own. The context-window figure is the most recent request's
prompt size (input + cache) over the model's window &mdash; 200K, or 1M when the
prompt or model marks the long-context tier.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claudeCodeUsageTracker.refreshIntervalSeconds` | `30` | How often to refresh usage data. |
| `claudeCodeUsageTracker.currency` | `USD` | Currency code for cost formatting. |
| `claudeCodeUsageTracker.decimalPlaces` | `2` | Decimal places for cost figures. |
| `claudeCodeUsageTracker.showLimits` | `true` | Show 5-hour and weekly plan-limit utilization. |
| `claudeCodeUsageTracker.showOpusWeekly` | `false` | Also append the weekly Opus limit (`opus NN%`) when a live Opus window exists. |
| `claudeCodeUsageTracker.showContext` | `true` | Show the current session's context-window fill (like `/context`). |
| `claudeCodeUsageTracker.showCost` | `true` | Show today's estimated cost. |
| `claudeCodeUsageTracker.showTokens` | `true` | Show today's token count. |
| `claudeCodeUsageTracker.projectGroupingMode` | `git` | Group the dashboard's By project breakdown by git repo, folder, or path. |

## Troubleshooting

**The dashboard or status bar is empty.**
Claude Code has to have been installed and used at least once &mdash; the
extension reads the JSONL transcripts it writes under `~/.claude/projects`. If
that folder doesn't exist or has no sessions yet, there's nothing to show.

**Plan-limit bars don't appear.**
The 5-hour / weekly figures come from `~/.claude/usage-cache.json`, the cache
Claude Code writes after it syncs limit usage with the server. If it isn't there
yet, run Claude Code once. The status-bar segments additionally honor the
`showLimits` setting and only appear while a limit window is live.

**Usage history is missing older days or months.**
Claude Code automatically deletes conversation logs older than `cleanupPeriodDays`
(default **30 days**), and once deleted they can't be recovered. To keep more
history, add this to `~/.claude/settings.json`:

```json
{ "cleanupPeriodDays": 365 }
```

This only affects logs kept from now on; already-deleted sessions can't be
restored.

**Token counts look lower than your provider's dashboard.**
Tokens and cost are reconstructed from local logs and are an estimate. Sub-agents
and background workflows write their own `.jsonl` files in sub-directories &mdash;
the extension reads them, but some proxy setups don't record agent-level usage,
so the totals here can run lower than the upstream count. Your real spend is
always on your provider's billing page.

**Numbers look stale.**
The extension refreshes when Claude Code writes to its logs, with a timer
fallback (`refreshIntervalSeconds`). To force an update, run **Claude Code Usage
Tracker: Refresh** from the Command Palette.

## Development

```bash
npm install --include=dev   # install dev dependencies
npm run compile             # type-check + build to ./out
# then press F5 in VS Code / Cursor to launch the Extension Development Host
```

`npm run watch` keeps the compiler running while you work.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for the full, dated history. The latest entry
covers plan-limit tracking, the context-window indicator, the dashboard cards and
sortable breakdowns, and the usage-trend chart added in this release.

## License

MIT &mdash; see [LICENSE](./LICENSE).
