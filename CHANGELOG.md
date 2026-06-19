# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com), and the project
aims to follow [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed
- Plan-limit windows whose reset time has already passed are now treated as
  rolled over instead of showing the last cached utilization. `~/.claude/usage-cache.json`
  is only refreshed by Claude Code, so between refreshes an elapsed 5-hour window
  kept reading e.g. `27%` with a "resetting now" tooltip hours after it reset.
  Such windows now show `—` (the post-reset usage is unknown from a stale cache)
  in a muted color, the 5-hour reset is cleared (it is usage-anchored), and
  weekly/scoped windows roll their reset forward a week.
- The tooltip and dashboard now show an "Updated X ago" note, so a reading drawn
  from a stale cache is no longer styled like live data.
- `formatReset` no longer reports "resetting now" for a reset more than a minute
  in the past.

## [1.0.1] - 2026-06-18

### Changed
- Replaced the README banner PNG with a smaller JPEG (downscaled to 960px),
  cutting the packaged extension from ~2 MB to under 600 KB.

## [1.0.0] - 2026-06-18

### Added
- Status-bar item showing today's estimated cost and token count, with
  independent `showCost` / `showTokens` toggles. Click to open the dashboard.
- Plan-limit utilization in the status bar: 5-hour and weekly windows
  (`5h X% · wk Y%`) read from Claude Code's `~/.claude/usage-cache.json`, gated
  on `showLimits`. The tooltip lists each window's reset time and scoped models.
- Each plan-limit segment leads with a bundled Claude sunburst icon (an icon
  font) colored by the server's severity for that window &mdash; green (normal),
  yellow (warning), red (critical) &mdash; replacing the earlier whole-bar
  background tint. The limits, context, and cost/tokens now sit in separate
  status-bar items.
- `showOpusWeekly` opt-in (default off) that appends the weekly Opus limit
  (`opus Z%`) after the 5h / weekly figures when a live Opus window exists.
- Context-window fill indicator (`showContext`): the latest request's prompt
  size as a percent of the model's window, with the 1M tier inferred when the
  prompt exceeds 200K even if the `[1m]` marker is absent.
- Dashboard webview: Today / This Month / All Time cards with an input / output
  / cache-write / cache-read token breakdown, plus a Plan limits section with a
  progress bar, reset time, and severity color per window.
- Per-card cache-hit rate and a cost-composition bar splitting cost across
  input / output / cache-write / cache-read.
- Sortable breakdown tables (click a column header to sort), scoped by a Today /
  This Month / All Time tab that persists across refreshes.
- Breakdowns by model, by project, by git branch, and by session. Project
  grouping is configurable via `projectGroupingMode` (git repo / folder / path,
  default git). Sessions show the `ai-title`, peak context, and active-time
  duration (gaps over 15 minutes are excluded as step-aways).
- A Trend bar chart of usage over time: daily bars across the current month or
  monthly bars across all time, with a cost / tokens metric switcher, the current
  day highlighted, and a total + peak summary line. Empty days/months are filled
  so gaps in usage are visible. Period and metric selections persist across
  refreshes.
- Cost estimates from a per-model price table with prefix matching for dated /
  suffixed model ids.
- Live updates via file watchers over `~/.claude/projects` and
  `usage-cache.json`, with a polling timer as a fallback.
- Parsed logs cached per file by mtime to avoid re-reading unchanged sessions.

## [0.0.1] - 2026-06-18

### Added
- Project skeleton created.
