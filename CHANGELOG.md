# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com), and the project
aims to follow [Semantic Versioning](https://semver.org).

## [1.6.0] - 2026-09-06

### Fixed
- **The weekly limit no longer shows a reset that hasn't happened.** When a limits
  reading was older than the window it described, the extension assumed the window
  had rolled over and reported it as **0% used, with a fresh countdown** — visually
  identical to a live reading. Since Claude Code stopped refreshing
  `~/.claude/usage-cache.json`, that stale file could be *months* old and still be
  presented as current. A window is now only reported empty when the reset and the
  reading are both recent; otherwise it is hidden rather than guessed at.
- **Context % no longer falls as your context grows.** The window size was inferred
  from the token count itself, so a conversation at 190k tokens showed **95%** and
  one message later, at 205k, showed **20%**. The window now comes from the model:
  1M on Sonnet 4.6 / Opus 4.6 and later, 200K on Haiku and every earlier model.
- **Context % now describes your conversation, not its subagents.** Subagent turns
  carry the parent session's details and are usually the most recent entry, so the
  headline jumped by tens of points every time a subagent ran and back again when it
  finished. Their usage still counts everywhere costs are reported.
- **The 5-hour pace meter no longer says "on pace" when you are burning far too fast.**
  Early in a window the projection is deliberately damped so a thin slice cannot look
  alarming — but the "on pace" verdict was being read off the damped number. Using 36%
  of a 5-hour window in its first 30 minutes is a pace that exhausts it in under an
  hour, and the status bar called that "on pace to use this window fully".
- **Live limits can no longer show a different account's usage.** After signing out and
  back in as another account, a cached access token kept being used — successfully, so
  nothing ever corrected it — and the status bar could report the previous account's
  limits for hours.
- **Claude Fable 5.1 cache reads were billed at 4× the real rate** ($1.00 rather than
  $0.25 per million), inherited from Claude Fable 5. Cache reads dominate token volume
  in Claude Code sessions, so this noticeably overstated Fable 5.1 usage.
- **Opus fast mode was priced at half its real cost.** Fast mode bills at premium rates
  and is reported per message; that signal was being discarded.
- **"Explain with AI" works again on current Claude models.** The token budget was small
  enough that newer models, which reason before answering, could spend all of it before
  producing any visible text — returning "The model returned no text." on a billed request.
- **Warning popups no longer fire twice.** A momentary dip in a reported percentage could
  be mistaken for the window resetting, re-arming every alert and immediately re-firing it.
- **A window at 100% is never shown in green.** Clearing the warning-threshold list
  silently disabled all colouring and every alert.
- **The dashboard no longer rebuilds itself on every log write.** With the dashboard open
  during an active session it recomputed everything up to several times a second, which
  could make the whole editor feel sluggish.
- **"Explain with AI" can no longer get stuck on "Analyzing your usage…"** after the
  dashboard is closed and reopened mid-request.
- **Live limits are shared between windows more reliably.** Publishing the shared reading
  could silently fail when another window was reading it at that moment — on Windows,
  often. Each window then fell back to making its own request, which is what the shared
  reading exists to avoid. A rate-limit pause is now shared too, instead of every window
  discovering it separately.
- **The dashboard stays where you put it** instead of jumping into the active editor group.
- **A log file locked mid-write no longer skips a refresh.**

### Changed
- **Your context % will read differently after this release.** On current models
  (Sonnet 4.6 / Opus 4.6 and later) a conversation under 200k tokens now reads far
  lower, because it is measured against the full 1M window. On Haiku and pre-4.6
  models it is unchanged. The new figures are the correct ones.
- The AI Advisor now defaults to **Claude Sonnet 5**, which is both cheaper and stronger
  than the previous default. Set `advisor.ai.model` to an Opus id for deeper analysis.
- The extension now runs in **Restricted Mode** windows. It only ever reads usage data
  from your home directory and never executes anything from a workspace.
- An AI answer cut short by the token limit now says so, instead of appearing complete.
- If Anthropic rejects your stored API key, the extension now offers to update it rather
  than repeating the same error.

### Security
- **Prompt samples are limited to the folders open in your window.** The opt-in
  "include prompt text" setting collected from *every* Claude Code project on the
  machine, so prompts from an unrelated repository could be sent under a consent dialog
  that mentioned only "your recent prompts". Samples are now matched to the open
  workspace, and none are sent when there is no folder open. The confirmation dialog
  now names the workspace it is drawing from.

## [1.5.1] - 2026-07-19

### Fixed
- **Live plan limits and subscription detection now work on macOS.** Claude Code
  stores its OAuth credentials in the login **Keychain** on macOS, not in
  `~/.claude/.credentials.json` — so the live-limits fetch found no token and
  silently fell back to the on-disk cache (which can sit hours stale). The
  extension now reads the token from the Keychain (the same
  `Claude Code-credentials` item Claude Code itself writes) **read-only**, and
  still prefers the credentials file when one is present. Windows and Linux are
  unchanged.

## [1.5.0] - 2026-07-14

### Fixed
- **1-hour cache writes were undercounted by 37.5%.** Anthropic bills prompt-cache writes
  with the 1-hour TTL at **2× input**, versus 1.25× for the 5-minute TTL — and Claude Code
  sessions use the 1-hour TTL. The extension priced *all* cache writes at the 5-minute
  rate. It now splits the 1-hour portion out of every usage record and prices it at 2×.
  **Your cache-write cost figures will step up after this release** — the new numbers are
  the correct ones, not an increase in your actual usage.
- **Sonnet 5 is priced correctly** ($2 / $10 per MTok introductory pricing, through
  2026-08-31) — it previously fell through to the $3 / $15 default, overstating Sonnet 5
  usage by ~50%. Model matching is also more robust: Bedrock-style prefixed ids
  (`anthropic.` / `us.anthropic.`) now match, and an unlisted or future id is priced by
  its family (a future Opus prices as Opus) instead of silently billing at the mid-tier
  default.
- **Totals no longer dip or zero out on transient file errors.** Three separate causes,
  all fixed to keep the last good data and retry: a session file locked mid-write (common
  on Windows) was cached as *empty* until its next change; a failed listing of the log
  directory purged every parsed file and published zeros; and a failed stat on one file
  silently dropped its contribution for a pass.
- **Today's bar no longer disappears from the Daily chart for the rest of the month**
  after a DST spring-forward in timezones where the clocks skip midnight (e.g. Havana,
  Santiago, the Azores).
- **Case-distinct projects on Linux no longer merge.** `/dev/API` and `/dev/api` are
  different directories on a case-sensitive filesystem and now group separately in
  **By project**; Windows and macOS keep folding case, matching their filesystems.
- **The status bar's four items are now distinguishable in the right-click "Hide" menu.**
  They used to appear as four identical unnamed entries sharing one visibility setting;
  each now has its own name and remembers its own visibility.
- **"Explain with AI" can no longer get stuck on "Analyzing your usage…"** — an
  unexpected failure now surfaces as an error box in the panel.
- **A relocated `CLAUDE_CONFIG_DIR` is honored everywhere.** The log reader, the limits
  cache, credentials, and the shared multi-window cache all resolve from the same root;
  previously the live-limits fetch honored the override while the log and cache readers
  kept reading `~/.claude`, splitting the two sources.

### Changed
- **Much lighter on long, heavy histories.** The active session file is no longer re-read
  and re-parsed in full on every assistant turn — only the newly appended lines are read
  and folded into the parsed cache (with truncation/rewrites detected and re-parsed in
  full). Cold startup streams files in chunks instead of loading each as one giant string,
  and yields to the editor while parsing. A refresh that finds nothing changed reuses the
  previous result instead of rebuilding the record set, repeated strings (model ids,
  paths, session ids) are stored once, and the dashboard webview is released while hidden
  and rebuilt on reveal — with the last AI explanation preserved — instead of keeping a
  full browser context alive in memory.
- **The limit colors are now yours.** The status-bar sunburst and the dashboard bars turn
  yellow at your first `predictiveAlerts.warnThresholds` value and red at your last
  (75% / 90% by default), so the colors always agree with your warning notifications. An
  explicit warning from Anthropic can still escalate a color, never downgrade one — and
  the status bar and dashboard can no longer disagree with each other.
- **The 5-hour pace meter is visible again for the whole window.** 1.4.0 stopped it from
  crying wolf, but overshot: it hid the projection for the first half of every window and
  whenever you paused for a few minutes, so most of the time there was simply no estimate —
  the meter looked broken. It now shows from early in the window and stays put while you're
  idle. Early on, the projection is *damped* toward your current utilization instead of
  hidden: a thin early slice extrapolates wildly (`5h 15%` at 30 min in would read a raw
  `→ 150%`), so the meter is shrunk toward where you actually are and firms up to the plain
  projection by the time the window is half over. Past the half-mark the number is exactly
  what 1.4.0 showed. The breach **popup** is unchanged — it still fires only once the window
  is at least half over, you're actively burning, and you're clear of the on-pace band — so
  an always-on meter never brings back false "you'll breach" warnings.

## [1.4.0] - 2026-07-13

### Fixed
- **Output tokens (and cost) were undercounted by ~20%.** Claude Code writes an assistant
  message to its transcript once per streamed content block; the interim lines carry a
  placeholder `output_tokens` and only the final line reports the settled figure. The
  extension was keeping the *first* line of each message and discarding the rest, so it
  banked the placeholder and threw the real output count away. It now takes the final,
  settled usage. **Your output-token and cost figures will step up after this release** —
  the new numbers are the correct ones, not an increase in your actual usage.

### Changed
- **The 5-hour pace meter no longer cries wolf.** It was a bare extrapolation
  (`utilization ÷ elapsed`), which is a knife-edge at exactly the moment it matters: being
  a point or two ahead of an even pace rendered as a confident `→ 104%`, and one idle
  minute later as `→ 99%`. Three changes:
  - **It waits until the window is half over.** The meter was shown from 10% elapsed, but
    the breach warning already refused to fire before 50% *because the projection isn't
    reliable before then* — so the extension was printing a number it was too suspicious of
    to warn on. Both now share one gate. Early in a window you see just `5h 15%`.
  - **New `· on pace` reading.** Within ten points of 100% the projection is noise, so the
    meter now says `5h 53% · on pace` instead of committing to a number that flips on the
    next refresh. Clearly under or over pace still shows the figure (`5h 23% → 45%`,
    `5h 95% → 119%`). The breach warning clears the same band, so a popup can no longer
    contradict an "on pace" meter.
  - **It hides when you stop.** The meter ignored whether you were still burning, so a
    heavy start followed by an hour of idling kept projecting a breach. It now disappears
    when you're idle, like the weekly ETA and the warnings already did.
- **The burn readout says what it actually measures.** `Burn: 1.6M tok/min` was ~95% cache
  reads — a long session re-reads its whole context every turn — so the headline tracked
  context size × turn count rather than anything you consume, and it sat under the "Claude
  plan limits" heading as though it drove the pace projection (it never did). It is now its
  own tooltip block, split into new work versus context re-reads, with the rate labeled as
  an API-equivalent estimate on a subscription, matching the dashboard:
  `49.5k new tok/min · 849.1k/min context re-read · ≈ $0.80/min at API rates`.

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
