import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isUnderAny, withRealPaths } from './paths';

test('a workspace opened through a symlink still matches sessions logged under its real path', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccut-paths-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const real = path.join(base, 'real');
  const link = path.join(base, 'link');
  fs.mkdirSync(real);
  fs.symlinkSync(real, link, 'junction');
  const loggedCwd = path.join(fs.realpathSync.native(real), 'src');
  assert.equal(isUnderAny(loggedCwd, [link]), false);
  assert.equal(isUnderAny(loggedCwd, withRealPaths([link])), true);
});

test('withRealPaths keeps a root it cannot resolve', () => {
  const missing = path.join(os.tmpdir(), 'ccut-no-such-dir');
  assert.deepEqual(withRealPaths([missing]), [missing]);
});
