# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com), and the project
aims to follow [Semantic Versioning](https://semver.org).

## [1.3.1] - 2026-06-29

### Changed
- **Per-table totals.** Replaced the all-time grand-total strip (added in 1.3.0) with a
  **totals row at the foot of each dashboard breakdown** — By model, By project, and By
  branch now sum their Messages, Tokens, and Cost columns, in the same format as the rows
  above. The All Time card already serves as the grand total, so the separate strip was
  redundant; per-section totals are more useful.

## [1.3.0] - 2026-06-28

### Added
- **Grand total** — a strip beneath the Today / This Month / All Time cards in the
  dashboard, summing your **all-time spend, messages, and active time** in one place.
  Active time reuses the session active-time measure (idle gaps longer than 15 minutes
  are excluded), so it reflects time actually spent working, not wall-clock. On a
  subscription the spend is labeled "≈ API" to match the rest of the dashboard.

### Fixed
- **Plan limits now stay live across multiple editor windows.** With more than one
  window open (and especially on a Max plan), each window used to poll Anthropic's
  usage endpoint independently; the extra traffic could get a window rate-limited
  (HTTP 429) and stuck showing a stale "Updated Nd ago" reading until you reloaded it.
  A successful fetch is now published to a small shared file that every window reads,
  so all open windows share one fetch (~one request between them instead of one each),
  and a rate-limited window shows a sibling window's fresh data instead of falling back
  to a stale cache. The shared file holds only the usage figures and a timestamp — never
  your credentials — and lives alongside Claude's own files (honoring `CLAUDE_CONFIG_DIR`)
  so Cursor and VS Code on the same account coordinate too.

## [1.2.0] - 2026-06-23

### Added
- **Advisor** — a new panel in the dashboard with ranked, money-quantified tips to
  cut waste, computed entirely from your local usage data (no network, no API key,
  no prompt text). Toggle with `advisor.enabled` (on by default). It surfaces:
  - **Routing routine turns to a cheaper model** — when a period's spend includes a
    run of short turns on an expensive model, it estimates what those same turns
    would have cost one tier down (e.g. Opus → Sonnet) and shows the saving.
  - **Long sessions re-processing context uncached** — sessions with many turns but
    low prompt-cache reuse, where context was paid for at full input price instead
    of read back at ~1/10th.
  - **Sessions running near the context limit** — a habit of peaking above 80%
    context, where Claude has to compact or drop earlier context to keep going.
  - **A month-end spend forecast** at your current pace.
  - **Subscription-aware framing** — on a Pro/Max plan (flat fee, no per-token billing)
    the dollar figures are labeled *estimated API-equivalent usage* (a gauge, not a
    bill) and the advice — local cards and the AI explanation alike — is framed around
    your 5-hour / weekly session limits instead of a bill. The Today / This Month /
    All Time cost cards also carry a subtle "≈ API-equivalent" caption.
- **Explain with AI** (opt-in) — a button on the Advisor panel that turns the
  computed signals into written, prioritized coaching. It calls Anthropic's Messages
  API with **your own** API key (stored in VS Code Secret Storage via the new *Set
  Anthropic API Key* command; never the Claude Code OAuth token). Only usage metadata
  is sent by default; prompt text is included only if you enable
  `advisor.ai.includePrompts` and confirm each time. The model is configurable with
  `advisor.ai.model` (default Sonnet). Needs a pay-as-you-go Anthropic API key (a
  Pro/Max subscription doesn't include API credit); the call surfaces Anthropic's
  actual error — e.g. a 400 "credit balance is too low" with a one-click link to
  billing — instead of a bare status code.

## [1.1.1] - 2026-06-21

### Changed
- Clarified the new status-bar **pace meter** in the README and Marketplace overview:
  `5h 42% → 53%` is the projected end-of-window utilization at your current pace
  (here, on track to finish the 5-hour window at 53%). Spelled out in the hero
  caption and the Predictive alerts feature description so it reads clearly before
  install. No functional change.

## [1.1.0] - 2026-06-21

### Added
- **Predictive alerts** — the extension now forecasts when you'll hit a plan limit
  and warns you before you do, so you don't get cut off mid-session. On by default;
  turn the whole feature off with `predictiveAlerts.enabled`. It runs entirely on
  the usage figures already shown and makes no network calls of its own.
  - **Status-bar pace forecast**, computed from your *average* consumption over the
    current window so far — so each window is judged on its own timescale (the 5-hour
    window over hours, the 7-day window over days) and a single percentage tick can't
    manufacture an alarming number. The **5-hour** window shows a live pace meter: the
    projected end-of-window utilization at your current rate (`5h 24% → 48%`). The
    **weekly** window shows a time-to-limit ETA only when you're on a trustworthy
    track to breach it before reset. Toggle each with `predictiveAlerts.showFiveHourEta`
    and `predictiveAlerts.showWeeklyEta`.
  - **Proactive warnings.** A notification fires when a window crosses a configurable
    utilization threshold — 75% and 90% by default (`predictiveAlerts.warnThresholds`)
    — and, with `predictiveAlerts.predictBreach` on, when your current pace projects
    you'll hit a limit before it resets. Each warning fires once per window, re-arms
    when the window resets, and only fires while you're actually burning, so an idle
    window never nags.
  - **Burn rate** in the status-bar tooltip: tokens/min and cost/min over a
    configurable trailing window (`predictiveAlerts.windowMinutes`, default 15).
  - **Model-cost advisor** (`predictiveAlerts.modelAdvisor.enabled`, **off by
    default**): when recent turns show heavy spend on an expensive model for little
    output, a one-time, dismissible hint suggests a cheaper model for routine work.

## [1.0.5] - 2026-06-20

### Added
- Pay-as-you-go **extra usage** monitoring (`showExtraUsage`, off by default).
  When your account has extra usage enabled, your spend beyond plan limits is
  shown as `extra <spent> / <cap>` in the status bar, with detail in the tooltip
  and an Extra usage section in the dashboard. Read from Anthropic's usage
  response (`extra_usage`: minor units + currency); nothing is shown when your
  account has extra usage disabled.

## [1.0.4] - 2026-06-19

### Changed
- A limit window whose reset has already passed now shows a normal green `0%`
  instead of a muted `—`. With live fetching on by default the real current
  value is shown almost always; `0%` is just the baseline for a freshly reset
  window. The "Updated X ago" note in the tooltip and dashboard still flags a
  reading that fell back to a stale cache.

## [1.0.3] - 2026-06-19

### Added
- Live plan-limit fetching. The extension now reads your current 5-hour and
  weekly usage directly from Anthropic's usage endpoint — the same call Claude
  Code makes — authenticated with the OAuth token already in
  `~/.claude/.credentials.json`. The only previous source was
  `~/.claude/usage-cache.json`, which Claude Code rewrites just on startup and on
  `/usage`, so during a long session the limits could sit hours stale. The live
  fetch keeps them current with no session needed and falls back to the cache
  file on any failure. Controlled by `claudeCodeUsageTracker.useLiveApi` (default
  on) and throttled by `claudeCodeUsageTracker.liveApiMinIntervalSeconds`
  (default 180). Network requests are throttled to that interval whether they
  succeed or fail, a 429 backs off further (honoring `Retry-After`), and the live
  call is hard-timed-out so it can never stall the refresh loop. The throttle and
  token are per editor window. The access token is refreshed in memory only; the
  credentials file is never modified.

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
