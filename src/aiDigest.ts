// vscode/network/secret-free so it can be unit-tested directly; network + secrets live in aiAdvisor.ts.

import * as fs from 'fs';
import * as path from 'path';
import { UsageRecord } from './types';
import type { PlanLimits } from './limitsReader';
import {
  claudeLogRoot,
  summarize,
  summarizeByModel,
  summarizeBySession,
} from './dataLoader';
import { analyze } from './advisor';

const SAMPLE_MAX_SESSIONS = 5;
const SAMPLE_PER_SESSION = 3;
const SAMPLE_MAX_TOTAL = 12;
const SAMPLE_MAX_LEN = 280;

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

// `monthRecords` is pre-scoped by the caller; no prompt text is sent unless the caller passes opt-in samples.
export function buildDigest(
  monthRecords: UsageRecord[],
  limits: PlanLimits | undefined,
  now: number,
  promptSamples: string[] = [],
  subscription = false
): string {
  const lines: string[] = [];
  const date = new Date(now);
  const dayOfMonth = date.getDate();
  const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();

  if (subscription) {
    lines.push(
      'Billing: this user is on a Claude subscription (flat monthly fee with 5-hour / weekly session limits) ' +
        'and does NOT pay per token. Every dollar figure below is estimated pay-as-you-go API-equivalent cost — ' +
        'a gauge of usage intensity, not their bill. Frame advice around stretching the subscription and staying ' +
        'under the session limits, not around lowering a bill.'
    );
  }

  const summary = summarize(monthRecords);
  const t = summary.tokens;
  const ctxDenom = t.input + t.cacheWrite + t.cacheRead;
  const cacheShare = ctxDenom > 0 ? Math.round((t.cacheRead / ctxDenom) * 100) : 0;

  lines.push(`Period: this month so far (day ${dayOfMonth} of ${daysInMonth}).`);
  lines.push(`Total spend: ${usd(summary.costUsd)} over ${summary.messageCount} assistant turns.`);
  lines.push(
    `Tokens: input ${t.input.toLocaleString('en-US')}, output ${t.output.toLocaleString('en-US')}, ` +
      `cache-write ${t.cacheWrite.toLocaleString('en-US')}, cache-read ${t.cacheRead.toLocaleString('en-US')} ` +
      `(cache-read share ${cacheShare}%).`
  );

  const byModel = summarizeByModel(monthRecords);
  if (byModel.length) {
    lines.push('Spend by model:');
    for (const g of byModel.slice(0, 6)) {
      const avgOut = g.summary.messageCount > 0 ? Math.round(g.summary.tokens.output / g.summary.messageCount) : 0;
      lines.push(`  - ${g.key}: ${usd(g.summary.costUsd)}, ${g.summary.messageCount} turns, avg output ${avgOut} tok`);
    }
  }

  const sessions = summarizeBySession(monthRecords);
  const hot = sessions.filter((s) => s.peakContextPct >= 80).length;
  lines.push(`Sessions: ${sessions.length} this month; ${hot} peaked above 80% context.`);

  if (limits?.fiveHour || limits?.sevenDay) {
    const five = limits?.fiveHour ? `${Math.round(limits.fiveHour.utilization)}%` : 'n/a';
    const week = limits?.sevenDay ? `${Math.round(limits.sevenDay.utilization)}%` : 'n/a';
    lines.push(`Plan limits now: 5-hour ${five}, weekly ${week}.`);
  }

  const insights = analyze({ records: monthRecords, sessions, now, subscription }, usd);
  if (insights.length) {
    lines.push('Locally-computed insights:');
    for (const i of insights) {
      const save = i.savingsUsd && i.savingsUsd > 0 ? ` (est. saving ${usd(i.savingsUsd)})` : '';
      lines.push(`  - ${i.title}${save}: ${i.detail}`);
    }
  }

  if (promptSamples.length) {
    lines.push('Recent user prompts (samples, truncated — included with consent):');
    promptSamples.forEach((p, idx) => lines.push(`  ${idx + 1}. ${p}`));
  }

  return lines.join('\n');
}

export function systemPrompt(includePrompts: boolean, subscription = false): string {
  const base =
    "You are a cost-and-efficiency coach for Claude Code, Anthropic's terminal coding agent. " +
    "Given a summary of the user's recent token usage, give specific, prioritized, actionable advice to cut " +
    'token waste. Reference their actual numbers. Name concrete levers where they apply: routing routine ' +
    'turns to a cheaper model (Haiku/Sonnet vs Opus/Fable), prompt caching and keeping early context stable, ' +
    '/compact and /clear to control context growth, trimming CLAUDE.md, avoiding redundant file reads, and scoping ' +
    'subagents. Be concise — a short prioritized list, not an essay. Do not invent numbers that are not provided. ' +
    'End with the single highest-impact change to make next.';
  const billing = subscription
    ? ' IMPORTANT: this user is on a flat-fee Claude subscription with 5-hour / weekly session limits and does NOT ' +
      'pay per token — the dollar figures are estimated API-equivalent usage, not a bill. Do NOT tell them they are ' +
      'spending or will be billed that money or frame savings as cash back. Frame everything around stretching their ' +
      'subscription and staying under their session limits; dollars are only a gauge of usage intensity.'
    : '';
  const prompts = includePrompts
    ? ' Some recent user prompts are included; also give brief, concrete tips to write tighter, more effective prompts based on them.'
    : '';
  return base + billing + prompts;
}

// Skips non-typed prompts: tool results, sidechains, and command/system wrappers (which start with '<').
export function extractUserPrompt(line: string): string | undefined {
  let raw: any;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!raw || raw.type !== 'user' || raw.isSidechain || raw.isMeta) {
    return undefined;
  }
  const content = raw.message?.content;
  let text: string | undefined;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    if (content.some((b: any) => b?.type === 'tool_result')) {
      return undefined;
    }
    text = content
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join(' ');
  }
  if (!text) {
    return undefined;
  }
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean || clean.startsWith('<')) {
    return undefined;
  }
  return clean.length > SAMPLE_MAX_LEN ? `${clean.slice(0, SAMPLE_MAX_LEN - 1)}…` : clean;
}

async function recentJsonlFiles(root: string): Promise<string[]> {
  const all: { file: string; mtime: number }[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const st = await fs.promises.stat(full);
          all.push({ file: full, mtime: st.mtimeMs });
        } catch {
          /* unreadable file */
        }
      }
    }
  }
  await walk(root);
  all.sort((a, b) => b.mtime - a.mtime);
  return all.slice(0, SAMPLE_MAX_SESSIONS).map((x) => x.file);
}

// Only called after the user has opted in and confirmed.
export async function collectPromptSamples(): Promise<string[]> {
  let files: string[];
  try {
    files = await recentJsonlFiles(claudeLogRoot());
  } catch {
    return [];
  }
  const samples: string[] = [];
  for (const file of files) {
    if (samples.length >= SAMPLE_MAX_TOTAL) {
      break;
    }
    let text: string;
    try {
      text = await fs.promises.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    let perSession = 0;
    for (let i = lines.length - 1; i >= 0 && perSession < SAMPLE_PER_SESSION && samples.length < SAMPLE_MAX_TOTAL; i--) {
      const trimmed = lines[i].trim();
      if (!trimmed) {
        continue;
      }
      const prompt = extractUserPrompt(trimmed);
      if (prompt) {
        samples.push(prompt);
        perSession += 1;
      }
    }
  }
  return samples;
}
