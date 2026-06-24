// The opt-in "Explain with AI" advisor. Holds the user's own Anthropic API key in
// VS Code Secret Storage and calls the Messages API directly with it — never the
// Claude Code OAuth token. Sends only the usage digest (metadata) unless the user
// has opted into including prompt samples, which is also confirmed per run.

import * as vscode from 'vscode';
import * as https from 'https';
import { UsageRecord } from './types';
import { PlanLimits } from './limitsReader';
import { filterMonth } from './dataLoader';
import { isSubscription } from './credentials';
import { buildDigest, systemPrompt, collectPromptSamples } from './aiDigest';

const CONFIG_SECTION = 'claudeCodeUsageTracker';
const SECRET_KEY = 'claudeCodeUsageTracker.anthropicApiKey';
const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const CONSOLE_KEYS_URL = 'https://console.anthropic.com/settings/keys';
const CONSOLE_BILLING_URL = 'https://console.anthropic.com/settings/billing';
const ANTHROPIC_VERSION = '2023-06-01';
const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 1024;

export type AiResult = { ok: true; text: string; model: string } | { ok: false; error: string };

interface HttpResult {
  status: number;
  body: string;
}

function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const payload = Buffer.from(JSON.stringify(body));
    let settled = false;
    let req: ReturnType<typeof https.request> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      try {
        req?.destroy();
      } catch {
        /* already settling */
      }
      action();
    };
    timer = setTimeout(() => finish(() => reject(new Error('request timed out'))), REQUEST_TIMEOUT_MS);
    req = https.request(
      {
        method: 'POST',
        hostname: target.hostname,
        path: target.pathname + target.search,
        headers: { ...headers, 'Content-Length': String(payload.length) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk as Buffer));
        res.on('end', () => finish(() => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })));
        res.on('error', (err) => finish(() => reject(err)));
        res.on('aborted', () => finish(() => reject(new Error('response aborted'))));
        res.on('close', () => finish(() => reject(new Error('connection closed before response completed'))));
      }
    );
    req.on('error', (err) => finish(() => reject(err)));
    req.write(payload);
    req.end();
  });
}

// Pull the human-readable message out of an Anthropic error body
// ({"type":"error","error":{"type":...,"message":...}}), if present.
function apiErrorMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body);
    const message = parsed?.error?.message;
    return typeof message === 'string' && message ? message : undefined;
  } catch {
    return undefined;
  }
}

export class AiAdvisor {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async setApiKey(): Promise<void> {
    const OPEN = 'Open Anthropic Console';
    const ENTER = 'I have a key';
    const choice = await vscode.window.showInformationMessage(
      'The AI Advisor uses your own Anthropic API key — a pay-as-you-go key from the Anthropic Console ' +
        '(console.anthropic.com → Settings → API keys), billed separately from your Claude Code / claude.ai subscription.',
      OPEN,
      ENTER
    );
    if (choice === OPEN) {
      await vscode.env.openExternal(vscode.Uri.parse(CONSOLE_KEYS_URL));
    } else if (choice !== ENTER) {
      return;
    }
    const key = await vscode.window.showInputBox({
      title: 'Anthropic API Key — AI Advisor',
      prompt: 'Paste your key from console.anthropic.com/settings/keys. Stored in VS Code Secret Storage; used only for the AI Advisor.',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'sk-ant-...',
      validateInput: (v) =>
        v && v.trim().startsWith('sk-ant-') ? undefined : 'That doesn’t look like an Anthropic API key (expected sk-ant-…).',
    });
    if (key && key.trim()) {
      await this.secrets.store(SECRET_KEY, key.trim());
      void vscode.window.showInformationMessage('Anthropic API key saved for the AI Advisor.');
    }
  }

  async clearApiKey(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
    void vscode.window.showInformationMessage('Anthropic API key cleared.');
  }

  async explain(records: UsageRecord[], limits: PlanLimits | undefined, now = Date.now()): Promise<AiResult> {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const model = cfg.get<string>('advisor.ai.model', DEFAULT_MODEL) || DEFAULT_MODEL;
    const includePrompts = cfg.get<boolean>('advisor.ai.includePrompts', false);

    // Uses only this install's own key from Secret Storage, never a bundled key.
    let apiKey = await this.secrets.get(SECRET_KEY);
    if (!apiKey) {
      await this.setApiKey();
      apiKey = await this.secrets.get(SECRET_KEY);
      if (!apiKey) {
        return { ok: false, error: 'No API key set. Run “Claude Code Usage Tracker: Set Anthropic API Key” to enable AI explanations.' };
      }
    }

    if (includePrompts) {
      const consent = await vscode.window.showWarningMessage(
        'Include prompt text? A small, truncated sample of your recent Claude Code prompts will be sent to Anthropic so the advisor can coach on prompt quality. Turn off “advisor.ai.includePrompts” to send usage metadata only.',
        { modal: true },
        'Send with prompts'
      );
      if (consent !== 'Send with prompts') {
        return { ok: false, error: 'Cancelled — nothing was sent.' };
      }
    }

    const subscription = isSubscription() || !!(limits?.fiveHour || limits?.sevenDay);
    const monthRecords = filterMonth(records);
    const samples = includePrompts ? await collectPromptSamples() : [];
    const digest = buildDigest(monthRecords, limits, now, samples, subscription);

    const { result, creditError } = await this.send(apiKey, model, includePrompts, digest, subscription);

    // A credit-balance 400 means a valid key with no API credit — offer to open billing.
    if (!result.ok && creditError) {
      const BILLING = 'Open Billing';
      const pick = await vscode.window.showWarningMessage(
        '“Explain with AI” needs a little pay-as-you-go Anthropic API credit — it is billed separately from your Claude Code / Pro / Max subscription.',
        BILLING
      );
      if (pick === BILLING) {
        await vscode.env.openExternal(vscode.Uri.parse(CONSOLE_BILLING_URL));
      }
    }

    return result;
  }

  private async send(
    apiKey: string,
    model: string,
    includePrompts: boolean,
    digest: string,
    subscription: boolean
  ): Promise<{ result: AiResult; creditError: boolean }> {
    let result: HttpResult;
    try {
      result = await postJson(
        MESSAGES_URL,
        { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
        {
          model,
          max_tokens: MAX_TOKENS,
          system: systemPrompt(includePrompts, subscription),
          messages: [{ role: 'user', content: `Here is my recent Claude Code usage.\n\n${digest}` }],
        }
      );
    } catch (err) {
      return { creditError: false, result: { ok: false, error: `Request failed: ${(err as Error).message}` } };
    }

    const detail = apiErrorMessage(result.body);
    if (result.status === 401) {
      return {
        creditError: false,
        result: { ok: false, error: `Anthropic rejected the API key (401)${detail ? `: ${detail}` : '.'} Set a valid key and try again.` },
      };
    }
    if (result.status === 429) {
      return { creditError: false, result: { ok: false, error: `Rate limited (429)${detail ? `: ${detail}` : '.'} Try again shortly.` } };
    }
    if (result.status !== 200) {
      // A low/empty balance comes back as a 400 even though the key is valid — flag it
      // so the caller can point the user to billing.
      const credit = !!detail && /credit balance/i.test(detail);
      if (credit) {
        return {
          creditError: true,
          result: {
            ok: false,
            error:
              `${detail}\n\nThe Anthropic API is pay-as-you-go and separate from your Claude Code subscription. ` +
              `Add a little credit at console.anthropic.com → Billing, then try again.`,
          },
        };
      }
      return { creditError: false, result: { ok: false, error: `Anthropic returned HTTP ${result.status}${detail ? `: ${detail}` : '.'}` } };
    }

    let parsed: any;
    try {
      parsed = JSON.parse(result.body);
    } catch {
      return { creditError: false, result: { ok: false, error: 'Could not parse the Anthropic response.' } };
    }
    const text = Array.isArray(parsed?.content)
      ? parsed.content
          .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
          .map((b: any) => b.text)
          .join('\n')
          .trim()
      : '';
    if (!text) {
      return { creditError: false, result: { ok: false, error: 'The model returned no text.' } };
    }
    return { creditError: false, result: { ok: true, text, model } };
  }
}
