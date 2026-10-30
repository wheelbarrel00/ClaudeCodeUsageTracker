import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
  parseEntries,
  loadUsageRecords,
  summarizeByProject,
  currentContext,
  summarize,
  costBreakdown,
  summarizeBySession,
} from './dataLoader';
import { UsageRecord, EMPTY_TOKENS } from './types';
import * as paths from './paths';

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

async function withRoot(fn: (projDir: string) => Promise<void>): Promise<void> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ccut-test-'));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  const projDir = path.join(root, 'projects', 'p');
  await fs.promises.mkdir(projDir, { recursive: true });
  try {
    await fn(projDir);
  } finally {
    if (prev === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = prev;
    }
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

function outputs(records: { tokens: { output: number } }[]): number[] {
  return records.map((r) => r.tokens.output).sort((a, b) => a - b);
}

test('appended lines are tail-parsed and still settle streamed duplicates', async () => {
  await withRoot(async (projDir) => {
    const file = path.join(projDir, 's1.jsonl');
    await fs.promises.writeFile(
      file,
      line({ id: 'msg_1', requestId: 'r1', output: 10, stop: 'end_turn' }) +
        '\n' +
        line({ id: 'msg_2', requestId: 'r2', output: 1, stop: null }) +
        '\n'
    );
    assert.deepEqual(outputs(await loadUsageRecords()), [1, 10]);

    await fs.promises.appendFile(
      file,
      line({ id: 'msg_2', requestId: 'r2', output: 500, stop: 'tool_use' }) +
        '\n' +
        line({ id: 'msg_3', requestId: 'r3', output: 42, stop: 'end_turn' }) +
        '\n'
    );
    assert.deepEqual(outputs(await loadUsageRecords()), [10, 42, 500]);
  });
});

test('an unchanged pass reuses the last snapshot without a rebuild', async () => {
  await withRoot(async (projDir) => {
    await fs.promises.writeFile(
      path.join(projDir, 's1.jsonl'),
      line({ id: 'msg_1', requestId: 'r1', output: 10, stop: 'end_turn' }) + '\n'
    );
    const first = await loadUsageRecords();
    const second = await loadUsageRecords();
    assert.equal(second, first);
  });
});

test('a truncated/rewritten file is fully re-parsed from scratch', async () => {
  await withRoot(async (projDir) => {
    const file = path.join(projDir, 's1.jsonl');
    await fs.promises.writeFile(
      file,
      line({ id: 'msg_1', requestId: 'r1', output: 10, stop: 'end_turn' }) +
        '\n' +
        line({ id: 'msg_2', requestId: 'r2', output: 20, stop: 'end_turn' }) +
        '\n'
    );
    assert.deepEqual(outputs(await loadUsageRecords()), [10, 20]);

    await fs.promises.writeFile(file, line({ id: 'msg_9', requestId: 'r9', output: 77, stop: 'end_turn' }) + '\n');
    assert.deepEqual(outputs(await loadUsageRecords()), [77]);
  });
});

test('a same-size in-place rewrite is detected via mtime and re-parsed', async () => {
  await withRoot(async (projDir) => {
    const file = path.join(projDir, 's1.jsonl');
    const before = line({ id: 'msg_1', requestId: 'r1', output: 5, stop: 'end_turn' }) + '\n';
    const after = line({ id: 'msg_1', requestId: 'r1', output: 7, stop: 'end_turn' }) + '\n';
    assert.equal(before.length, after.length);
    await fs.promises.writeFile(file, before);
    assert.deepEqual(outputs(await loadUsageRecords()), [5]);

    await fs.promises.writeFile(file, after);
    const bumped = new Date(Date.now() + 5000);
    await fs.promises.utimes(file, bumped, bumped);
    assert.deepEqual(outputs(await loadUsageRecords()), [7]);
  });
});

test('a partial (mid-write) trailing line is held back until it completes', async () => {
  await withRoot(async (projDir) => {
    const file = path.join(projDir, 's1.jsonl');
    const whole = line({ id: 'msg_2', requestId: 'r2', output: 33, stop: 'end_turn' });
    await fs.promises.writeFile(
      file,
      line({ id: 'msg_1', requestId: 'r1', output: 10, stop: 'end_turn' }) + '\n' + whole.slice(0, 25)
    );
    assert.deepEqual(outputs(await loadUsageRecords()), [10]);

    await fs.promises.appendFile(file, whole.slice(25) + '\n');
    assert.deepEqual(outputs(await loadUsageRecords()), [10, 33]);
  });
});

test('an ai-title arriving in the tail retro-applies to earlier entries', async () => {
  await withRoot(async (projDir) => {
    const file = path.join(projDir, 's1.jsonl');
    await fs.promises.writeFile(file, line({ id: 'msg_1', requestId: 'r1', output: 10, stop: 'end_turn' }) + '\n');
    const first = await loadUsageRecords();
    assert.equal(first[0].sessionTitle, undefined);

    await fs.promises.appendFile(file, JSON.stringify({ type: 'ai-title', aiTitle: 'Fix the tests' }) + '\n');
    const second = await loadUsageRecords();
    assert.equal(second[0].sessionTitle, 'Fix the tests');
  });
});

test('a failed root walk serves the last good snapshot instead of zeros', async () => {
  await withRoot(async (projDir) => {
    await fs.promises.writeFile(
      path.join(projDir, 's1.jsonl'),
      line({ id: 'msg_1', requestId: 'r1', output: 10, stop: 'end_turn' }) + '\n'
    );
    const good = await loadUsageRecords();
    assert.equal(good.length, 1);

    process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), 'ccut-definitely-missing', String(process.pid));
    const fallback = await loadUsageRecords();
    assert.equal(fallback, good);
  });
});

function fillerLine(i: number): string {
  return line({ id: `fill_${i}`, requestId: `fr_${i}`, output: 1, stop: 'end_turn' });
}

function keylessLine(output: number): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-13T05:00:00.000Z',
    sessionId: 's1',
    cwd: '/repo',
    message: { model: 'claude-opus-4-8', usage: { input_tokens: 5, output_tokens: output, cache_read_input_tokens: 0 } },
  });
}

function bytesOver(minBytes: number, startIndex = 0): string {
  const parts: string[] = [];
  let size = 0;
  let i = startIndex;
  while (size < minBytes) {
    const l = fillerLine(i++) + '\n';
    parts.push(l);
    size += Buffer.byteLength(l);
  }
  return parts.join('');
}

function patchOpenReadFault(shouldThrow: (position: number) => boolean): () => void {
  const realOpen = fs.promises.open;
  (fs.promises as any).open = async function (this: unknown, ...args: any[]): Promise<any> {
    const handle = await (realOpen as any).apply(fs.promises, args);
    const realRead = handle.read.bind(handle);
    handle.read = async function (opts: any): Promise<any> {
      if (typeof opts?.position === 'number' && shouldThrow(opts.position)) {
        throw Object.assign(new Error('injected read fault'), { code: 'EIO' });
      }
      return realRead(opts);
    };
    return handle;
  };
  return () => {
    (fs.promises as any).open = realOpen;
  };
}

function patchFault(method: 'stat' | 'readdir', shouldThrow: (p: string) => boolean): () => void {
  const real = (fs.promises as any)[method];
  (fs.promises as any)[method] = async function (p: any, ...rest: any[]): Promise<any> {
    if (typeof p === 'string' && shouldThrow(p)) {
      throw Object.assign(new Error(`injected ${method} fault`), { code: 'EBUSY' });
    }
    return real.call(fs.promises, p, ...rest);
  };
  return () => {
    (fs.promises as any)[method] = real;
  };
}

test('a >1MiB history parses correctly across chunk boundaries', async () => {
  await withRoot(async (projDir) => {
    const count = 4000;
    const body = Array.from({ length: count }, (_, i) => fillerLine(i)).join('\n') + '\n';
    assert.ok(Buffer.byteLength(body) > 1 << 20);
    await fs.promises.writeFile(path.join(projDir, 's1.jsonl'), body);
    const records = await loadUsageRecords();
    assert.equal(records.length, count);
  });
});

test('a mid-read failure on an incremental pass leaves totals unchanged and never double-counts', async () => {
  await withRoot(async (projDir) => {
    const file = path.join(projDir, 's1.jsonl');
    await fs.promises.writeFile(
      file,
      line({ id: 'seed_1', requestId: 's1', output: 10, stop: 'end_turn' }) + '\n' +
        line({ id: 'seed_2', requestId: 's2', output: 20, stop: 'end_turn' }) + '\n'
    );
    const seed = await loadUsageRecords();
    assert.equal(seed.length, 2);
    const oldSize = (await fs.promises.stat(file)).size;

    // The keyless line lands in chunk 1; the >1MiB filler pushes the tail into a second read, which fails.
    await fs.promises.appendFile(file, keylessLine(777) + '\n' + bytesOver(1 << 20));

    const restore = patchOpenReadFault((position) => position > oldSize);
    let faulted: UsageRecord[];
    try {
      faulted = await loadUsageRecords();
    } finally {
      restore();
    }
    assert.equal(faulted.length, 2);
    assert.equal(faulted.filter((r) => r.tokens.output === 777).length, 0);

    const recovered = await loadUsageRecords();
    assert.equal(recovered.filter((r) => r.tokens.output === 777).length, 1);
    const again = await loadUsageRecords();
    assert.equal(again.filter((r) => r.tokens.output === 777).length, 1);
  });
});

test('a grow-past-size rewrite is not mistaken for an append (boundary check forces full re-parse)', async () => {
  await withRoot(async (projDir) => {
    const file = path.join(projDir, 's1.jsonl');
    await fs.promises.writeFile(
      file,
      line({ id: 'old_1', requestId: 'o1', output: 11, stop: 'end_turn' }) + '\n' +
        line({ id: 'old_2', requestId: 'o2', output: 22, stop: 'end_turn' }) + '\n' +
        line({ id: 'old_3', requestId: 'o3', output: 33, stop: 'end_turn' }) + '\n'
    );
    const oldSize = (await fs.promises.stat(file)).size;
    assert.deepEqual(outputs(await loadUsageRecords()), [11, 22, 33]);

    // One line grown past oldSize with no newline at oldSize-1: a rewrite posing as an append.
    const padded = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-13T06:00:00.000Z',
      requestId: 'new_1',
      sessionId: 's1',
      cwd: '/repo',
      pad: 'x'.repeat(oldSize + 2000),
      message: { id: 'new_1', model: 'claude-opus-4-8', usage: { input_tokens: 1, output_tokens: 99 } },
    });
    assert.ok(Buffer.byteLength(padded) > oldSize);
    const bumped = new Date(Date.now() + 5000);
    await fs.promises.writeFile(file, padded + '\n');
    await fs.promises.utimes(file, bumped, bumped);
    assert.deepEqual(outputs(await loadUsageRecords()), [99]);
  });
});

test('a subdirectory walk failure serves last-good instead of dipping totals or purging the cache', async () => {
  await withRoot(async (projDir) => {
    await fs.promises.writeFile(
      path.join(projDir, 's1.jsonl'),
      line({ id: 'm1', requestId: 'r1', output: 10, stop: 'end_turn' }) + '\n' +
        line({ id: 'm2', requestId: 'r2', output: 20, stop: 'end_turn' }) + '\n'
    );
    const good = await loadUsageRecords();
    assert.equal(good.length, 2);

    const restore = patchFault('readdir', (p) => p === projDir);
    let dipped: UsageRecord[];
    try {
      dipped = await loadUsageRecords();
    } finally {
      restore();
    }
    assert.equal(dipped, good);
  });
});

test('a per-file stat failure keeps that file’s cached contribution (C8)', async () => {
  await withRoot(async (projDir) => {
    const a = path.join(projDir, 'a.jsonl');
    const b = path.join(projDir, 'b.jsonl');
    await fs.promises.writeFile(a, line({ id: 'a1', requestId: 'ar1', output: 100, stop: 'end_turn' }) + '\n');
    await fs.promises.writeFile(b, line({ id: 'b1', requestId: 'br1', output: 200, stop: 'end_turn' }) + '\n');
    assert.deepEqual(outputs(await loadUsageRecords()), [100, 200]);

    await fs.promises.appendFile(b, line({ id: 'b2', requestId: 'br2', output: 201, stop: 'end_turn' }) + '\n');
    const restore = patchFault('stat', (p) => p === a);
    let out: number[];
    try {
      out = outputs(await loadUsageRecords());
    } finally {
      restore();
    }
    assert.ok(out.includes(100));
    assert.deepEqual(out, [100, 200, 201]);
  });
});

function recordWithCwd(cwd: string): UsageRecord {
  return { timestamp: 1, model: 'claude-opus-4-8', tokens: { ...EMPTY_TOKENS, output: 1 }, cwd, project: path.basename(cwd) };
}

test('project grouping folds case per the platform filesystem', () => {
  const groups = summarizeByProject([recordWithCwd('C:\\Repo'), recordWithCwd('c:\\repo')], 'flat');
  if (process.platform === 'win32' || process.platform === 'darwin') {
    assert.equal(groups.length, 1);
  } else {
    assert.equal(groups.length, 2);
  }
});

function ctxRecord(timestamp: number, cacheRead: number, isSidechain: boolean): UsageRecord {
  return {
    timestamp,
    model: 'claude-opus-5',
    tokens: { ...EMPTY_TOKENS, cacheRead },
    isSidechain,
  };
}

test('currentContext reports the main thread, ignoring more recent subagent turns', () => {
  const now = Date.now();
  const records = [
    ctxRecord(now - 4000, 111_273, false),
    ctxRecord(now - 3000, 110_645, true),
    ctxRecord(now - 2000, 122_519, true),
    ctxRecord(now - 1000, 78_072, true),
  ];
  const ctx = currentContext(records, now);
  assert.equal(ctx?.tokens, 111_273);
  assert.equal(ctx?.windowTokens, 1_000_000);
});

test('a conversation with no subagent turns is unaffected', () => {
  const now = Date.now();
  const ctx = currentContext([ctxRecord(now - 1000, 250_000, false)], now);
  assert.equal(ctx?.tokens, 250_000);
});

test('subagent-only records leave the context readout empty rather than misreporting it', () => {
  const now = Date.now();
  assert.equal(currentContext([ctxRecord(now - 1000, 90_000, true)], now), undefined);
});

test('a window reports its own workspace session, not whichever session wrote last', () => {
  const now = Date.now();
  const mine = path.resolve('/work/tracker');
  const at = (timestamp: number, cacheRead: number, cwd: string): UsageRecord => ({
    ...ctxRecord(timestamp, cacheRead, false),
    cwd,
  });
  const records = [
    at(now - 3000, 300_000, path.join(mine, 'src')),
    at(now - 2000, 500_000, path.resolve('/work/trackerExtra')),
    at(now - 1000, 700_000, path.resolve('/elsewhere')),
  ];
  assert.equal(currentContext(records, now, [mine])?.tokens, 300_000);
  assert.equal(currentContext(records, now, [path.resolve('/nothing-here')]), undefined);
  assert.equal(currentContext(records, now)?.tokens, 700_000, 'an empty window keeps the latest session');
});

test('workspace scoping checks each distinct cwd once, not every record', (t) => {
  const check = t.mock.method(paths, 'isUnderAny');
  const now = Date.now();
  const records = Array.from({ length: 1000 }, (_, i) => ({
    ...ctxRecord(now - 1000 + i, 1000, false),
    cwd: path.resolve(i % 2 ? '/work/a' : '/work/b'),
  }));
  assert.equal(currentContext(records, now, [path.resolve('/work/a')])?.tokens, 1000);
  assert.equal(check.mock.callCount(), 2);
});

test('the sidechain flag survives parsing', () => {
  const text = [
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-13T04:00:00.000Z',
      requestId: 'req_side',
      isSidechain: true,
      message: { id: 'msg_side', model: 'claude-opus-5', usage: { input_tokens: 5, output_tokens: 5 } },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-13T04:00:01.000Z',
      requestId: 'req_main',
      message: { id: 'msg_main', model: 'claude-opus-5', usage: { input_tokens: 5, output_tokens: 5 } },
    }),
  ].join('\n');
  const records = parseEntries(text).map((e) => e.record);
  assert.equal(records[0].isSidechain, true);
  assert.equal(records[1].isSidechain, false);
});

test('usage.speed is carried onto the record so fast mode can be priced', () => {
  const mk = (speed?: string) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-01T04:00:00.000Z',
      requestId: 'req_' + (speed ?? 'none'),
      message: {
        id: 'msg_' + (speed ?? 'none'),
        model: 'claude-opus-5',
        usage: { input_tokens: 10, output_tokens: 10, ...(speed ? { speed } : {}) },
      },
    });
  const records = parseEntries([mk('fast'), mk('standard'), mk()].join('\n')).map((e) => e.record);
  assert.equal(records[0].speed, 'fast');
  assert.equal(records[1].speed, 'standard');
  assert.equal(records[2].speed, undefined);
});

test('fast-mode records are priced at the premium rate through summarize and costBreakdown', () => {
  const base: UsageRecord = {
    timestamp: Date.now(),
    model: 'claude-opus-5',
    tokens: { ...EMPTY_TOKENS, input: 1_000_000, cacheRead: 10_000_000 },
  };
  assert.equal(summarize([base]).costUsd, 10);
  assert.equal(summarize([{ ...base, speed: 'fast' }]).costUsd, 20);
  assert.equal(costBreakdown([base]).cacheRead, 5);
  assert.equal(costBreakdown([{ ...base, speed: 'fast' }]).cacheRead, 10);
});

test('costBreakdown picks the same Haiku 5.5 rate card as the summary total', () => {
  const record: UsageRecord = {
    timestamp: Date.now(),
    model: 'claude-haiku-5-5',
    tokens: { ...EMPTY_TOKENS, input: 1_000_000, output: 1_000_000 },
  };
  const parts = costBreakdown([record]);
  assert.equal(parts.input, 0.5);
  assert.equal(parts.output, 2.5);
  assert.equal(parts.input + parts.output, summarize([record]).costUsd);
});

test('peak context per session excludes subagent turns', () => {
  const at = Date.now();
  const mk = (cacheRead: number, isSidechain: boolean): UsageRecord => ({
    timestamp: at,
    model: 'claude-opus-5',
    tokens: { ...EMPTY_TOKENS, cacheRead },
    session: 's1',
    isSidechain,
  });
  const [session] = summarizeBySession([mk(200_000, false), mk(900_000, true)]);
  assert.equal(Math.round(session.peakContextPct), 20, 'the 900k subagent turn is not this session peak');
});
