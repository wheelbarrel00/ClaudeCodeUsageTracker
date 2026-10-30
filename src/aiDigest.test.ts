import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UsageRecord, EMPTY_TOKENS } from './types';
import * as path from 'path';
import { buildDigest, systemPrompt, extractUserPrompt, collectPromptSamples } from './aiDigest';

const JUNE_15 = new Date(2026, 5, 15, 12, 0, 0).getTime();

function record(tokens: Partial<typeof EMPTY_TOKENS>, model = 'claude-opus-4-8', timestamp = JUNE_15): UsageRecord {
  return { timestamp, model, tokens: { ...EMPTY_TOKENS, ...tokens } };
}

test('buildDigest summarizes spend, tokens, and per-model breakdown', () => {
  const records = [
    record({ input: 1_000_000, output: 200_000 }, 'claude-opus-4-8'),
    record({ input: 500_000, output: 50_000 }, 'claude-sonnet-4-6'),
  ];
  const digest = buildDigest(records, undefined, JUNE_15);
  assert.match(digest, /Period: this month so far \(day 15 of 30\)/);
  assert.match(digest, /Total spend: \$/);
  assert.match(digest, /Spend by model:/);
  assert.match(digest, /claude-opus-4-8/);
  assert.match(digest, /claude-sonnet-4-6/);
});

test('buildDigest folds in the locally-computed insights', () => {
  const records = Array.from({ length: 6 }, () => record({ input: 1_000_000, output: 100 }, 'claude-opus-4-8'));
  const digest = buildDigest(records, undefined, JUNE_15);
  assert.match(digest, /Locally-computed insights:/);
  assert.match(digest, /Route routine Opus turns to Sonnet/);
  assert.match(digest, /est\. saving \$/);
});

test('buildDigest includes prompt samples only when provided', () => {
  const records = [record({ input: 1_000_000, output: 100 })];
  assert.doesNotMatch(buildDigest(records, undefined, JUNE_15), /Recent user prompts/);
  const withSamples = buildDigest(records, undefined, JUNE_15, ['fix the off-by-one in the parser']);
  assert.match(withSamples, /Recent user prompts/);
  assert.match(withSamples, /fix the off-by-one in the parser/);
});

test('systemPrompt asks for prompt-writing coaching only when prompts are included', () => {
  assert.doesNotMatch(systemPrompt(false), /tighter, more effective prompts/i);
  assert.match(systemPrompt(true), /tighter, more effective prompts/i);
});

test('buildDigest flags the flat-fee framing only on a subscription', () => {
  const records = [record({ input: 1_000_000, output: 100 })];
  assert.doesNotMatch(buildDigest(records, undefined, JUNE_15), /subscription/i);
  const sub = buildDigest(records, undefined, JUNE_15, [], true);
  assert.match(sub, /subscription/i);
  assert.match(sub, /does NOT pay per token/i);
});

test('systemPrompt warns against bill framing only on a subscription', () => {
  assert.doesNotMatch(systemPrompt(false), /not pay per token/i);
  assert.match(systemPrompt(false, true), /not pay per token/i);
});

test('extractUserPrompt returns a clean, truncated typed prompt', () => {
  const line = JSON.stringify({ type: 'user', message: { role: 'user', content: '  refactor   the\nloader  ' } });
  assert.equal(extractUserPrompt(line), 'refactor the loader');
});

test('extractUserPrompt reads text blocks from array content', () => {
  const line = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'add a test' }] },
  });
  assert.equal(extractUserPrompt(line), 'add a test');
});

test('extractUserPrompt skips tool results, sidechains, wrappers, and non-user lines', () => {
  const toolResult = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', content: 'output' }] },
  });
  assert.equal(extractUserPrompt(toolResult), undefined);
  const sidechain = JSON.stringify({ type: 'user', isSidechain: true, message: { content: 'sub-agent prompt' } });
  assert.equal(extractUserPrompt(sidechain), undefined);
  const wrapper = JSON.stringify({ type: 'user', message: { content: '<command-name>/foo</command-name>' } });
  assert.equal(extractUserPrompt(wrapper), undefined);
  const assistant = JSON.stringify({ type: 'assistant', message: { content: 'hi' } });
  assert.equal(extractUserPrompt(assistant), undefined);
  assert.equal(extractUserPrompt('not json'), undefined);
});

test('extractUserPrompt truncates very long prompts', () => {
  const long = 'x'.repeat(500);
  const line = JSON.stringify({ type: 'user', message: { role: 'user', content: long } });
  const out = extractUserPrompt(line)!;
  assert.ok(out.length <= 280);
  assert.ok(out.endsWith('…'));
});

// Built with the platform separator: hardcoded backslashes passed vacuously off Windows.
const TRACKER_CWD = path.join(path.sep, 'users', 'dev', 'Tracker');
const OTHER_CWD = path.join(path.sep, 'users', 'dev', 'ClientRepo');
const SIBLING_CWD = path.join(path.sep, 'users', 'dev', 'TrackerExtra');
const NESTED_CWD = path.join(TRACKER_CWD, 'src');

function promptLine(cwd: string): string {
  return JSON.stringify({ type: 'user', cwd, message: { content: 'ship the release' } });
}

test('prompt samples are limited to the open workspace', () => {
  assert.equal(extractUserPrompt(promptLine(TRACKER_CWD), [TRACKER_CWD]), 'ship the release');
  assert.equal(extractUserPrompt(promptLine(NESTED_CWD), [TRACKER_CWD]), 'ship the release');
  assert.equal(extractUserPrompt(promptLine(OTHER_CWD), [TRACKER_CWD]), undefined);
});

test('with no workspace to scope to, nothing is collected at all', async () => {
  assert.deepEqual(await collectPromptSamples([]), []);
});

test('a sibling directory that merely shares a name prefix is outside the workspace', () => {
  assert.equal(extractUserPrompt(promptLine(SIBLING_CWD), [TRACKER_CWD]), undefined);
});

test('an entry with no cwd cannot be attributed to the workspace, so it is dropped', () => {
  const line = JSON.stringify({ type: 'user', message: { content: 'ship the release' } });
  assert.equal(extractUserPrompt(line, [TRACKER_CWD]), undefined);
  assert.equal(extractUserPrompt(line), 'ship the release');
});

test('the prompt-coaching instruction is only added when prompts were actually collected', () => {
  assert.match(systemPrompt(true, false), /recent user prompts are included/i);
  assert.doesNotMatch(systemPrompt(false, false), /recent user prompts are included/i);
});
