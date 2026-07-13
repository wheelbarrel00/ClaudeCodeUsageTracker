import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEntries } from './dataLoader';

function line(overrides: {
  id: string;
  requestId: string;
  output: number;
  stop: string | null;
  cacheRead?: number;
}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-13T04:00:00.000Z',
    requestId: overrides.requestId,
    sessionId: 's1',
    cwd: '/repo',
    message: {
      id: overrides.id,
      model: 'claude-opus-4-8',
      stop_reason: overrides.stop,
      usage: {
        input_tokens: 10,
        output_tokens: overrides.output,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: overrides.cacheRead ?? 1000,
      },
    },
  });
}

test('duplicate streamed lines resolve to the final settled usage, not the placeholder', () => {
  const text = [
    line({ id: 'msg_1', requestId: 'req_1', output: 1, stop: null }),
    line({ id: 'msg_1', requestId: 'req_1', output: 1, stop: null }),
    line({ id: 'msg_1', requestId: 'req_1', output: 2563, stop: 'tool_use' }),
  ].join('\n');

  const entries = parseEntries(text);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].record.tokens.output, 2563);
});

test('distinct messages are all kept, and position follows first appearance', () => {
  const text = [
    line({ id: 'msg_1', requestId: 'req_1', output: 1, stop: null }),
    line({ id: 'msg_2', requestId: 'req_2', output: 7, stop: 'end_turn' }),
    line({ id: 'msg_1', requestId: 'req_1', output: 500, stop: 'tool_use' }),
  ].join('\n');

  const entries = parseEntries(text);
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((e) => e.record.tokens.output),
    [500, 7]
  );
});

test('a single-line message is unaffected', () => {
  const entries = parseEntries(line({ id: 'msg_1', requestId: 'req_1', output: 42, stop: 'end_turn' }));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].record.tokens.output, 42);
});
