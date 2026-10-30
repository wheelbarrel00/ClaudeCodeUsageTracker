import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
  keychainService,
  keychainAccount,
  parseCredentials,
  isExpired,
  readOAuth,
  readOAuthAsync,
  OAuthCredentials,
  __resetCredentialCacheForTests,
  __setKeychainReaderForTests,
} from './credentials';

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = vars[k];
    }
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  }
}

async function withEnvAsync(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = vars[k];
    }
  }
  try {
    await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  }
}

async function withPlatform(platform: NodeJS.Platform, fn: () => Promise<void>): Promise<void> {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    await fn();
  } finally {
    Object.defineProperty(process, 'platform', orig);
  }
}

function tempConfigDir(credentials?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccut-cred-'));
  if (credentials !== undefined) {
    fs.writeFileSync(path.join(dir, '.credentials.json'), credentials);
  }
  return dir;
}

function hash8(dir: string): string {
  return crypto.createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8);
}

// credentials.ts sees os through live getters, so patch the os module itself, not this import.
function withUserInfo(impl: () => { username: string }, fn: () => void): void {
  const osModule = require('os');
  const orig = osModule.userInfo;
  osModule.userInfo = impl;
  try {
    fn();
  } finally {
    osModule.userInfo = orig;
  }
}

const VALID = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'tok',
    refreshToken: 'ref',
    expiresAt: 123,
    scopes: ['user:inference', 42, 'org:read'],
    subscriptionType: 'max',
  },
});

test('keychainService is the bare service for a default config dir', () => {
  withEnv({ CLAUDE_CONFIG_DIR: undefined, CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined }, () => {
    assert.equal(keychainService(), 'Claude Code-credentials');
  });
});

test('keychainService appends the hashed config dir when CLAUDE_CONFIG_DIR is set', () => {
  withEnv({ CLAUDE_CONFIG_DIR: '/home/x/.claude-alt', CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined }, () => {
    assert.equal(keychainService(), `Claude Code-credentials-${hash8('/home/x/.claude-alt')}`);
  });
});

test('CLAUDE_SECURESTORAGE_CONFIG_DIR takes precedence over CLAUDE_CONFIG_DIR', () => {
  withEnv({ CLAUDE_CONFIG_DIR: '/home/x/.claude-alt', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/secure' }, () => {
    assert.equal(keychainService(), `Claude Code-credentials-${hash8('/secure')}`);
  });
});

test('an empty CLAUDE_SECURESTORAGE_CONFIG_DIR forces the bare service, ignoring CLAUDE_CONFIG_DIR', () => {
  withEnv({ CLAUDE_CONFIG_DIR: '/home/x/.claude-alt', CLAUDE_SECURESTORAGE_CONFIG_DIR: '' }, () => {
    assert.equal(keychainService(), 'Claude Code-credentials');
  });
});

test('keychainAccount uses USER when it is a valid identifier', () => {
  withEnv({ USER: 'ada' }, () => {
    assert.equal(keychainAccount(), 'ada');
  });
});

test('keychainAccount falls back for a USER with unsupported characters', () => {
  withEnv({ USER: 'ada lovelace' }, () => {
    assert.equal(keychainAccount(), 'claude-code-user');
  });
});

test('keychainAccount falls back to os.userInfo().username when USER is unset', () => {
  withUserInfo(
    () => ({ username: 'grace' }),
    () => withEnv({ USER: undefined }, () => assert.equal(keychainAccount(), 'grace'))
  );
});

test('keychainAccount returns the default when USER is unset and os.userInfo throws', () => {
  withUserInfo(
    () => {
      throw new Error('no user database entry');
    },
    () => withEnv({ USER: undefined }, () => assert.equal(keychainAccount(), 'claude-code-user'))
  );
});

test('parseCredentials extracts the oauth fields and never keeps the refresh token', () => {
  const creds = parseCredentials(VALID);
  assert.deepEqual(creds, {
    accessToken: 'tok',
    expiresAt: 123,
    subscriptionType: 'max',
  });
  assert.doesNotMatch(JSON.stringify(creds), /ref/);
});

test('isExpired is true only once the expiry has passed, and never for an unknown expiry', () => {
  assert.equal(isExpired(1_000, 999), false);
  assert.equal(isExpired(1_000, 1_000), true);
  assert.equal(isExpired(undefined, Number.MAX_SAFE_INTEGER), false);
});

test('parseCredentials tolerates the trailing newline of `security -w` output', () => {
  assert.ok(parseCredentials(VALID + '\n'));
});

test('parseCredentials returns undefined without a claudeAiOauth wrapper', () => {
  assert.equal(parseCredentials(JSON.stringify({ accessToken: 'tok' })), undefined);
});

test('parseCredentials returns undefined when the access token is missing', () => {
  assert.equal(parseCredentials(JSON.stringify({ claudeAiOauth: { refreshToken: 'ref' } })), undefined);
});

test('parseCredentials returns undefined for malformed JSON', () => {
  assert.equal(parseCredentials('not json'), undefined);
});

test('readOAuthAsync reads the file first and never spawns the Keychain reader when a file exists', async () => {
  const dir = tempConfigDir(VALID);
  let spawned = false;
  __resetCredentialCacheForTests();
  __setKeychainReaderForTests(async () => {
    spawned = true;
    return undefined;
  });
  try {
    await withEnvAsync({ CLAUDE_CONFIG_DIR: dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined }, () =>
      withPlatform('darwin', async () => {
        const creds = await readOAuthAsync();
        assert.equal(creds?.accessToken, 'tok');
        assert.equal(spawned, false);
      })
    );
  } finally {
    __setKeychainReaderForTests();
    __resetCredentialCacheForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readOAuthAsync on macOS falls through to the Keychain when there is no file', async () => {
  const dir = tempConfigDir();
  __resetCredentialCacheForTests();
  __setKeychainReaderForTests(async () => parseCredentials(VALID));
  try {
    await withEnvAsync({ CLAUDE_CONFIG_DIR: dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined }, () =>
      withPlatform('darwin', async () => {
        const creds = await readOAuthAsync();
        assert.equal(creds?.accessToken, 'tok');
      })
    );
  } finally {
    __setKeychainReaderForTests();
    __resetCredentialCacheForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readOAuthAsync off macOS returns undefined and never spawns the Keychain reader', async () => {
  const dir = tempConfigDir();
  let spawned = false;
  __resetCredentialCacheForTests();
  __setKeychainReaderForTests(async () => {
    spawned = true;
    return parseCredentials(VALID);
  });
  try {
    await withEnvAsync({ CLAUDE_CONFIG_DIR: dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined }, () =>
      withPlatform('linux', async () => {
        assert.equal(await readOAuthAsync(), undefined);
        assert.equal(spawned, false);
      })
    );
  } finally {
    __setKeychainReaderForTests();
    __resetCredentialCacheForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent readOAuthAsync calls coalesce into a single Keychain read', async () => {
  const dir = tempConfigDir();
  let calls = 0;
  __resetCredentialCacheForTests();
  __setKeychainReaderForTests(async () => {
    calls++;
    return parseCredentials(VALID);
  });
  try {
    await withEnvAsync({ CLAUDE_CONFIG_DIR: dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined }, () =>
      withPlatform('darwin', async () => {
        const [a, b] = await Promise.all([readOAuthAsync(), readOAuthAsync()]);
        assert.equal(calls, 1);
        assert.equal(a?.accessToken, 'tok');
        assert.equal(b?.accessToken, 'tok');
      })
    );
  } finally {
    __setKeychainReaderForTests();
    __resetCredentialCacheForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a slow Keychain miss does not clobber creds a concurrent file read cached', async () => {
  const dir = tempConfigDir();
  let release!: (v: OAuthCredentials | undefined) => void;
  __resetCredentialCacheForTests();
  __setKeychainReaderForTests(() => new Promise((res) => (release = res)));
  try {
    await withEnvAsync({ CLAUDE_CONFIG_DIR: dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined }, () =>
      withPlatform('darwin', async () => {
        const pending = readOAuthAsync();
        fs.writeFileSync(path.join(dir, '.credentials.json'), VALID);
        const fromFile = await readOAuthAsync();
        assert.equal(fromFile?.accessToken, 'tok');
        release(undefined);
        await pending;
        assert.equal(readOAuth()?.accessToken, 'tok');
      })
    );
  } finally {
    __setKeychainReaderForTests();
    __resetCredentialCacheForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
