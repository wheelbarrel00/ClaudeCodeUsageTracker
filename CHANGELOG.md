# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com), and the project
aims to follow [Semantic Versioning](https://semver.org).

## [Unreleased]

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
- Cost estimates from a per-model price table with prefix matching for dated /
  suffixed model ids.
- Live updates via file watchers over `~/.claude/projects` and
  `usage-cache.json`, with a polling timer as a fallback.
- Parsed logs cached per file by mtime to avoid re-reading unchanged sessions.

## [0.0.1] - 2026-06-18

### Added
- Project skeleton created.
