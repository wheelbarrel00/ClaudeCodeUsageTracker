import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function isUnderAny(cwd: unknown, roots: string[]): boolean {
  if (typeof cwd !== 'string' || !cwd) {
    return false;
  }
  // path.relative, not startsWith: settles separators, Windows case, and "…TrackerExtra" vs "…Tracker".
  return roots.some((root) => {
    const rel = path.relative(root, cwd);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

export function withRealPaths(roots: string[]): string[] {
  const all = new Set(roots);
  for (const root of roots) {
    try {
      all.add(fs.realpathSync.native(root));
    } catch {}
  }
  return [...all];
}
