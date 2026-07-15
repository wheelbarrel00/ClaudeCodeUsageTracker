import * as os from 'os';
import * as path from 'path';

// Root of Claude Code's state; honors CLAUDE_CONFIG_DIR so a relocated dir doesn't split our sources.
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}
