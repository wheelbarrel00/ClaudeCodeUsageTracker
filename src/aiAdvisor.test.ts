import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';
import type { PlanLimits } from './limitsReader';

const opened: string[] = [];
let pick: string | undefined;
let shown: { message: string; buttons: string[] } | undefined;

const vscodeStub = {
  Uri: { parse: (url: string) => url },
  env: {
    openExternal(url: string): Promise<boolean> {
      opened.push(url);
      return Promise.resolve(true);
    },
  },
  window: {
    showWarningMessage(message: string, ...buttons: string[]): Promise<string | undefined> {
      shown = { message, buttons };
      return Promise.resolve(pick);
    },
  },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
  },
};

const moduleInternals = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const realLoad = moduleInternals._load;
moduleInternals._load = function (this: unknown, request: string, ...rest: unknown[]) {
  return request === 'vscode' ? vscodeStub : realLoad.call(this, request, ...rest);
};

const { AiAdvisor } = require('./aiAdvisor');

const LIMITS: PlanLimits = { sevenDay: { utilization: 10, severity: 'normal' }, scoped: [], hasSessionLimit: false };
const CREDIT_ERROR = JSON.stringify({ error: { message: 'Your credit balance is too low to access the Anthropic API.' } });

function creditErrorRequest(_options: unknown, onResponse: (res: EventEmitter) => void): EventEmitter {
  const res = Object.assign(new EventEmitter(), { statusCode: 400 });
  return Object.assign(new EventEmitter(), {
    write() {},
    destroy() {},
    end() {
      onResponse(res);
      res.emit('data', Buffer.from(CREDIT_ERROR));
      res.emit('end');
    },
  });
}

async function explainPicking(choice: string | undefined): Promise<void> {
  pick = choice;
  opened.length = 0;
  const secrets = { get: () => Promise.resolve('sk-ant-test') };
  const result = await new AiAdvisor(secrets).explain([], LIMITS);
  assert.equal(result.ok, false);
  await new Promise(setImmediate);
}

test('the credit warning opens the page for the kind of credit picked', async (t) => {
  t.mock.method(require('https'), 'request', creditErrorRequest);

  await explainPicking('Open claude.ai Billing');
  assert.deepEqual(opened, ['https://claude.ai/settings/billing']);

  await explainPicking('Open Console Billing');
  assert.deepEqual(opened, ['https://platform.claude.com/settings/billing']);

  await explainPicking(undefined);
  assert.deepEqual(opened, []);
  assert.deepEqual(shown?.buttons, ['Open claude.ai Billing', 'Open Console Billing']);
  assert.match(shown?.message ?? '', /link a Claude Console organization/);
  assert.match(shown?.message ?? '', /Otherwise, add a little credit/);
});
