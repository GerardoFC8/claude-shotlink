/**
 * settings-patcher.test.ts
 *
 * Tests for src/settings-patcher.ts — idempotent settings.json hook installer.
 *
 * ALL tests use real fs.mkdtempSync temp dirs — no mocking of fs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSettingsDir(): { dir: string; settingsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'settings-patcher-test-'));
  return { dir, settingsPath: join(dir, 'settings.json') };
}

function listBackupFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.startsWith('settings.json.backup-'))
    .sort();
}

function readSettings(settingsPath: string): unknown {
  return JSON.parse(readFileSync(settingsPath, 'utf8'));
}

// Fixed hook command for tests — contains an absolute path so sentinel matching works
const HOOK_CMD = '/home/testuser/.npm-global/lib/node_modules/@gerardofc/claude-shotlink/dist/hook.js';
const MATCHER = 'Bash|Write';
const SENTINEL = '/dist/hook.js'; // substring of HOOK_CMD

// ── Test fixtures ─────────────────────────────────────────────────────────────

const EMPTY_SETTINGS = '{}';
const SETTINGS_WITH_OTHER = JSON.stringify({
  hooks: {
    PostToolUse: [
      {
        matcher: 'Write',
        hooks: [{ type: 'command', command: 'node /other/hook.js', timeout: 60 }],
      },
    ],
  },
}, null, 2);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('installHook — create from scratch', () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    ({ dir, settingsPath } = makeSettingsDir());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates settings.json when file does not exist', async () => {
    const { installHook } = await import('./settings-patcher.js');
    expect(existsSync(settingsPath)).toBe(false);

    const result = await installHook({
      settingsPath,
      hookCommand: HOOK_CMD,
      matcher: MATCHER,
      sentinel: SENTINEL,
      now: () => new Date('2026-04-24T12:00:00.000Z'),
    });

    expect(result.action).toBe('installed');
    expect(existsSync(settingsPath)).toBe(true);
  });

  it('includes a backup when creating from scratch', async () => {
    const { installHook } = await import('./settings-patcher.js');

    await installHook({
      settingsPath,
      hookCommand: HOOK_CMD,
      matcher: MATCHER,
      sentinel: SENTINEL,
      now: () => new Date('2026-04-24T12:00:00.000Z'),
    });

    const backups = listBackupFiles(dir);
    expect(backups).toHaveLength(1);
    expect(result_backupPath(backups[0]!, dir)).not.toBeNull();
  });

  it('backup contains the empty starting state', async () => {
    const { installHook } = await import('./settings-patcher.js');

    await installHook({
      settingsPath,
      hookCommand: HOOK_CMD,
      matcher: MATCHER,
      sentinel: SENTINEL,
      now: () => new Date('2026-04-24T12:00:00.000Z'),
    });

    const backups = listBackupFiles(dir);
    const backupContent = readFileSync(join(dir, backups[0]!), 'utf8');
    expect(backupContent.trim()).toBe('{}');
  });

  it('resulting settings.json has correct PostToolUse entry shape', async () => {
    const { installHook } = await import('./settings-patcher.js');

    await installHook({
      settingsPath,
      hookCommand: HOOK_CMD,
      matcher: MATCHER,
      sentinel: SENTINEL,
      now: () => new Date('2026-04-24T12:00:00.000Z'),
    });

    const parsed = readSettings(settingsPath) as {
      hooks: { PostToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string; timeout?: number }> }> };
    };
    expect(Array.isArray(parsed.hooks.PostToolUse)).toBe(true);
    expect(parsed.hooks.PostToolUse).toHaveLength(1);

    const entry = parsed.hooks.PostToolUse[0]!;
    expect(entry.matcher).toBe('Bash|Write');
    expect(Array.isArray(entry.hooks)).toBe(true);
    expect(entry.hooks[0]!.type).toBe('command');
    expect(entry.hooks[0]!.command).toBe(HOOK_CMD);
    expect(entry.hooks[0]!.timeout).toBe(30);
  });

  it('settings.json is written with mode 0o600', async () => {
    const { installHook } = await import('./settings-patcher.js');

    await installHook({
      settingsPath,
      hookCommand: HOOK_CMD,
      matcher: MATCHER,
      sentinel: SENTINEL,
      now: () => new Date('2026-04-24T12:00:00.000Z'),
    });

    const stats = statSync(settingsPath);
    expect(stats.mode & 0o777).toBe(0o600);
  });
});

describe('installHook — chain-merge preserves sibling entries', () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    ({ dir, settingsPath } = makeSettingsDir());
    writeFileSync(settingsPath, SETTINGS_WITH_OTHER, { mode: 0o600 });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('preserves existing PostToolUse entries byte-identical', async () => {
    const { installHook } = await import('./settings-patcher.js');

    await installHook({
      settingsPath,
      hookCommand: HOOK_CMD,
      matcher: MATCHER,
      sentinel: SENTINEL,
      now: () => new Date('2026-04-24T12:00:00.000Z'),
    });

    const parsed = readSettings(settingsPath) as {
      hooks: { PostToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };

    expect(parsed.hooks.PostToolUse).toHaveLength(2);
    // First entry (the original sibling) must be byte-identical
    expect(parsed.hooks.PostToolUse[0]!.hooks[0]!.command).toBe('node /other/hook.js');
  });

  it('our entry is appended (not prepended or inserted)', async () => {
    const { installHook } = await import('./settings-patcher.js');

    await installHook({
      settingsPath,
      hookCommand: HOOK_CMD,
      matcher: MATCHER,
      sentinel: SENTINEL,
      now: () => new Date('2026-04-24T12:00:00.000Z'),
    });

    const parsed = readSettings(settingsPath) as {
      hooks: { PostToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };

    // Our entry is last
    const last = parsed.hooks.PostToolUse[parsed.hooks.PostToolUse.length - 1]!;
    expect(last.hooks[0]!.command).toBe(HOOK_CMD);
  });
});

describe('installHook — idempotent no-op', () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    ({ dir, settingsPath } = makeSettingsDir());
    writeFileSync(settingsPath, EMPTY_SETTINGS, { mode: 0o600 });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns already-present when sentinel exists with same command', async () => {
    const { installHook } = await import('./settings-patcher.js');

    // First install
    await installHook({
      settingsPath,
      hookCommand: HOOK_CMD,
      matcher: MATCHER,
      sentinel: SENTINEL,
      now: () => new Date('2026-04-24T12:00:00.000Z'),
    });

    // Second install — same command, same sentinel
    const result = await installHook({
      settingsPath,
      hookCommand: HOOK_CMD,
      matcher: MATCHER,
      sentinel: SENTINEL,
      now: () => new Date('2026-04-24T13:00:00.000Z'),
    });

    expect(result.action).toBe('already-present');
    expect(result.backupPath).toBeNull();
  });

  it('does NOT write a backup on no-op', async () => {
    const { installHook } = await import('./settings-patcher.js');

    await installHook({
      settingsPath,
      hookCommand: HOOK_CMD,
      matcher: MATCHER,
      sentinel: SENTINEL,
      now: () => new Date('2026-04-24T12:00:00.000Z'),
    });
    const backupsBefore = listBackupFiles(dir);

    await installHook({
      settingsPath,
      hookCommand: HOOK_CMD,
      matcher: MATCHER,
      sentinel: SENTINEL,
      now: () => new Date('2026-04-24T13:00:00.000Z'),
    });
    const backupsAfter = listBackupFiles(dir);

    // No new backups created on no-op
    expect(backupsAfter).toHaveLength(backupsBefore.length);
  });

  it('does NOT mutate the file on no-op (mtime unchanged)', async () => {
    const { installHook } = await import('./settings-patcher.js');

    await installHook({
      settingsPath,
      hookCommand: HOOK_CMD,
      matcher: MATCHER,
      sentinel: SENTINEL,
      now: () => new Date('2026-04-24T12:00:00.000Z'),
    });

    const mtimeBefore = statSync(settingsPath).mtimeMs;

    // Small delay to ensure mtime would differ if file was written
    await new Promise<void>((r) => setTimeout(r, 50));

    await installHook({
      settingsPath,
      hookCommand: HOOK_CMD,
      matcher: MATCHER,
      sentinel: SENTINEL,
      now: () => new Date('2026-04-24T13:00:00.000Z'),
    });

    const mtimeAfter = statSync(settingsPath).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });
});

describe('installHook — sentinel exists but command differs → backup + rewrite', () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    ({ dir, settingsPath } = makeSettingsDir());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rewrites when sentinel matches but command path is different', async () => {
    const { installHook } = await import('./settings-patcher.js');

    // Manually write settings with sentinel but DIFFERENT command
    const oldCmd = '/old/path/dist/hook.js'; // contains /dist/hook.js sentinel
    const existing = JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: 'Bash|Write',
            hooks: [{ type: 'command', command: oldCmd, timeout: 30 }],
          },
        ],
      },
    }, null, 2);
    writeFileSync(settingsPath, existing, { mode: 0o600 });

    const result = await installHook({
      settingsPath,
      hookCommand: HOOK_CMD, // new command, still contains /dist/hook.js
      matcher: MATCHER,
      sentinel: SENTINEL,
      now: () => new Date('2026-04-24T12:00:00.000Z'),
    });

    // Should install (not no-op) because the command differs
    expect(result.action).toBe('installed');
    expect(result.backupPath).not.toBeNull();

    // New settings should have the new command
    const parsed = readSettings(settingsPath) as {
      hooks: { PostToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    const commands = parsed.hooks.PostToolUse.flatMap((e) => e.hooks.map((h) => h.command));
    expect(commands).toContain(HOOK_CMD);
  });
});

describe('uninstallHook', () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    ({ dir, settingsPath } = makeSettingsDir());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('removes our entry and leaves siblings intact', async () => {
    const { installHook, uninstallHook } = await import('./settings-patcher.js');

    writeFileSync(settingsPath, SETTINGS_WITH_OTHER, { mode: 0o600 });

    await installHook({
      settingsPath,
      hookCommand: HOOK_CMD,
      matcher: MATCHER,
      sentinel: SENTINEL,
      now: () => new Date('2026-04-24T12:00:00.000Z'),
    });

    const before = readSettings(settingsPath) as {
      hooks: { PostToolUse: unknown[] };
    };
    expect(before.hooks.PostToolUse).toHaveLength(2);

    const result = await uninstallHook({
      settingsPath,
      sentinel: SENTINEL,
      now: () => new Date('2026-04-24T13:00:00.000Z'),
    });

    expect(result.action).toBe('removed');
    expect(result.removedCount).toBe(1);

    const after = readSettings(settingsPath) as {
      hooks: { PostToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(after.hooks.PostToolUse).toHaveLength(1);
    expect(after.hooks.PostToolUse[0]!.hooks[0]!.command).toBe('node /other/hook.js');
  });

  it('returns not-present when our entry does not exist', async () => {
    const { uninstallHook } = await import('./settings-patcher.js');

    writeFileSync(settingsPath, SETTINGS_WITH_OTHER, { mode: 0o600 });

    const result = await uninstallHook({
      settingsPath,
      sentinel: SENTINEL,
      now: () => new Date('2026-04-24T13:00:00.000Z'),
    });

    expect(result.action).toBe('not-present');
    expect(result.removedCount).toBe(0);
    expect(result.backupPath).toBeNull();
  });

  it('writes a backup before mutation', async () => {
    const { installHook, uninstallHook } = await import('./settings-patcher.js');

    writeFileSync(settingsPath, EMPTY_SETTINGS, { mode: 0o600 });

    await installHook({
      settingsPath,
      hookCommand: HOOK_CMD,
      matcher: MATCHER,
      sentinel: SENTINEL,
      now: () => new Date('2026-04-24T12:00:00.000Z'),
    });
    const backupsBefore = listBackupFiles(dir);

    await uninstallHook({
      settingsPath,
      sentinel: SENTINEL,
      now: () => new Date('2026-04-24T13:00:00.000Z'),
    });
    const backupsAfter = listBackupFiles(dir);

    expect(backupsAfter.length).toBeGreaterThan(backupsBefore.length);
  });
});

describe('listBackups', () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    ({ dir, settingsPath } = makeSettingsDir());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty array when no backups exist', async () => {
    const { listBackups } = await import('./settings-patcher.js');
    const result = await listBackups(dir);
    expect(result).toEqual([]);
  });

  it('returns backup filenames sorted by name (newest last alphabetically)', async () => {
    const { installHook, listBackups } = await import('./settings-patcher.js');

    writeFileSync(settingsPath, EMPTY_SETTINGS, { mode: 0o600 });

    await installHook({
      settingsPath,
      hookCommand: HOOK_CMD,
      matcher: MATCHER,
      sentinel: SENTINEL,
      now: () => new Date('2026-04-24T10:00:00.000Z'),
    });

    const result = await listBackups(dir);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0]).toMatch(/^settings\.json\.backup-/);
  });
});

describe('restoreBackup', () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    ({ dir, settingsPath } = makeSettingsDir());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('restores most-recent backup verbatim', async () => {
    const { installHook, restoreBackup } = await import('./settings-patcher.js');

    writeFileSync(settingsPath, EMPTY_SETTINGS, { mode: 0o600 });

    // First install — backup contains '{}'
    await installHook({
      settingsPath,
      hookCommand: HOOK_CMD,
      matcher: MATCHER,
      sentinel: SENTINEL,
      now: () => new Date('2026-04-24T10:00:00.000Z'),
    });

    const result = await restoreBackup({ settingsDir: dir, settingsPath });

    expect(result.action).toBe('restored');
    expect(result.backupUsed).toMatch(/settings\.json\.backup-/);

    const restoredContent = readFileSync(settingsPath, 'utf8');
    expect(restoredContent.trim()).toBe('{}');
  });

  it('returns no-backup when no backup files exist', async () => {
    const { restoreBackup } = await import('./settings-patcher.js');

    const result = await restoreBackup({ settingsDir: dir, settingsPath });
    expect(result.action).toBe('no-backup');
  });
});

// ── WARNING-1 regression: JSON.parse wraps with descriptive error ─────────────

describe('installHook — invalid JSON throws descriptive error', () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    ({ dir, settingsPath } = makeSettingsDir());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws an error mentioning the file path when settings.json has invalid JSON', async () => {
    const { installHook } = await import('./settings-patcher.js');

    writeFileSync(settingsPath, '{ not valid json {{', { mode: 0o600 });

    await expect(
      installHook({
        settingsPath,
        hookCommand: HOOK_CMD,
        matcher: MATCHER,
        sentinel: SENTINEL,
      }),
    ).rejects.toThrow(settingsPath);
  });
});

describe('uninstallHook — invalid JSON throws descriptive error', () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    ({ dir, settingsPath } = makeSettingsDir());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws an error mentioning the file path when settings.json has invalid JSON', async () => {
    const { uninstallHook } = await import('./settings-patcher.js');

    writeFileSync(settingsPath, '{ not valid json {{', { mode: 0o600 });

    await expect(
      uninstallHook({
        settingsPath,
        sentinel: SENTINEL,
      }),
    ).rejects.toThrow(settingsPath);
  });
});

// ── WARNING-3 regression: backup filename must not contain colons ─────────────

describe('installHook — backup filename has no colons', () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    ({ dir, settingsPath } = makeSettingsDir());
    writeFileSync(settingsPath, EMPTY_SETTINGS, { mode: 0o600 });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('backup filename matches /\\.backup-[0-9T\\-.Z]+$/ with no colons', async () => {
    const { installHook, listBackups } = await import('./settings-patcher.js');

    await installHook({
      settingsPath,
      hookCommand: HOOK_CMD,
      matcher: MATCHER,
      sentinel: SENTINEL,
      now: () => new Date('2026-04-24T12:34:56.789Z'),
    });

    const backups = await listBackups(dir);
    expect(backups).toHaveLength(1);
    const backupName = backups[0]!;

    expect(backupName).toMatch(/\.backup-[0-9T\-.Z]+$/);
    expect(backupName).not.toContain(':');
  });
});

// ── FIX-2 regression: installHook leaves no .settings-tmp-* sibling ──────────

describe('installHook — FIX-2: no temp file remains after successful write', () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    ({ dir, settingsPath } = makeSettingsDir());
    writeFileSync(settingsPath, EMPTY_SETTINGS, { mode: 0o600 });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('no .settings-tmp-* sibling file remains after successful installHook', async () => {
    const { installHook } = await import('./settings-patcher.js');

    await installHook({
      settingsPath,
      hookCommand: HOOK_CMD,
      matcher: MATCHER,
      sentinel: SENTINEL,
    });

    const files = readdirSync(dir);
    const tmpSiblings = files.filter((f) => f.startsWith('.settings-tmp-'));
    expect(tmpSiblings).toHaveLength(0);
    expect(existsSync(settingsPath)).toBe(true);
  });
});

// ── FIX-2 regression: restoreBackup leaves no .atomic-tmp-* sibling ──────────

describe('restoreBackup — FIX-2: no temp file remains after successful restore', () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    ({ dir, settingsPath } = makeSettingsDir());
    writeFileSync(settingsPath, EMPTY_SETTINGS, { mode: 0o600 });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('no .atomic-tmp-* sibling file remains after successful restoreBackup', async () => {
    const { installHook, restoreBackup } = await import('./settings-patcher.js');

    // Create a backup first
    await installHook({
      settingsPath,
      hookCommand: HOOK_CMD,
      matcher: MATCHER,
      sentinel: SENTINEL,
    });

    await restoreBackup({ settingsDir: dir, settingsPath });

    const files = readdirSync(dir);
    const tmpSiblings = files.filter((f) => f.startsWith('.atomic-tmp-') || f.startsWith('.settings-tmp-'));
    expect(tmpSiblings).toHaveLength(0);
    expect(existsSync(settingsPath)).toBe(true);
  });
});

// ── CA-4: Sentinel-based Hook Idempotency (TASK-007-a / TASK-008-a) ──────────
//
// These tests use the NEW sentinel substring 'claude-shotlink/dist/hook.js'
// and verify the installHook / uninstallHook algorithms handle all B3 scenarios.
// The sentinel constant is expected to be exported from settings-patcher.ts.

describe('CA-4 — SHOTLINK_HOOK_SENTINEL constant is exported from settings-patcher', () => {
  it('SHOTLINK_HOOK_SENTINEL equals the expected substring literal', async () => {
    const mod = await import('./settings-patcher.js');
    // This will fail until the constant is exported from settings-patcher.ts
    expect((mod as Record<string, unknown>)['SHOTLINK_HOOK_SENTINEL']).toBe('claude-shotlink/dist/hook.js');
  });
});

const NEW_SENTINEL = 'claude-shotlink/dist/hook.js';

// Simulate a v0.2 full-path entry: any path ending with claude-shotlink/dist/hook.js
const V2_DEV_CMD = 'node "/home/user/projects/claude-shotlink/dist/hook.js"';
const V2_NPM_GLOBAL_CMD = 'node "/home/user/.npm-global/lib/node_modules/@gerardofc/claude-shotlink/dist/hook.js"';
const CANONICAL_CMD = 'node "/home/runner/.npm-global/lib/node_modules/@gerardofc/claude-shotlink/dist/hook.js"';
const UNRELATED_CMD = 'node "/home/user/atuin/hook.js"';
const SENTINEL_MATCHER = 'Bash|Write';

describe('CA-4 — installHook: fresh install with substring sentinel', () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    ({ dir, settingsPath } = makeSettingsDir());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fresh install: exactly one PostToolUse entry matching the sentinel after install', async () => {
    const { installHook } = await import('./settings-patcher.js');

    writeFileSync(settingsPath, '{}', { mode: 0o600 });

    const result = await installHook({
      settingsPath,
      hookCommand: CANONICAL_CMD,
      matcher: SENTINEL_MATCHER,
      sentinel: NEW_SENTINEL,
      now: () => new Date('2026-04-25T12:00:00.000Z'),
    });

    expect(result.action).toBe('installed');

    const parsed = readSettings(settingsPath) as {
      hooks: { PostToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    const sentinelGroups = parsed.hooks.PostToolUse.filter((g) =>
      g.hooks.some((h) => h.command.includes(NEW_SENTINEL))
    );
    expect(sentinelGroups).toHaveLength(1);
    expect(sentinelGroups[0]!.hooks[0]!.command).toBe(CANONICAL_CMD);
  });
});

describe('CA-4 — installHook: dev+npm-global duplicate entries collapsed to one', () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    ({ dir, settingsPath } = makeSettingsDir());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('collapses two existing entries (dev path + npm-global path) to one canonical entry', async () => {
    const { installHook } = await import('./settings-patcher.js');

    // Pre-populate settings with TWO duplicate entries from different install paths
    const initialSettings = JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: SENTINEL_MATCHER,
            hooks: [{ type: 'command', command: V2_DEV_CMD, timeout: 30 }],
          },
          {
            matcher: SENTINEL_MATCHER,
            hooks: [{ type: 'command', command: V2_NPM_GLOBAL_CMD, timeout: 30 }],
          },
        ],
      },
    }, null, 2);
    writeFileSync(settingsPath, initialSettings, { mode: 0o600 });

    const result = await installHook({
      settingsPath,
      hookCommand: CANONICAL_CMD,
      matcher: SENTINEL_MATCHER,
      sentinel: NEW_SENTINEL,
      now: () => new Date('2026-04-25T12:00:00.000Z'),
    });

    expect(result.action).toBe('installed');

    const parsed = readSettings(settingsPath) as {
      hooks: { PostToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    // Exactly ONE sentinel-matching entry must remain
    const sentinelGroups = parsed.hooks.PostToolUse.filter((g) =>
      g.hooks.some((h) => h.command.includes(NEW_SENTINEL))
    );
    expect(sentinelGroups).toHaveLength(1);
    expect(sentinelGroups[0]!.hooks[0]!.command).toBe(CANONICAL_CMD);
    // Total groups = 1 (only the canonical; both duplicates removed)
    expect(parsed.hooks.PostToolUse).toHaveLength(1);
  });
});

describe('CA-4 — installHook: v0.2 full-path entry auto-migrated by substring match', () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    ({ dir, settingsPath } = makeSettingsDir());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('v0.2 full-path entry is evicted and replaced by canonical entry', async () => {
    const { installHook } = await import('./settings-patcher.js');

    // v0.2-style entry: full path that ends with claude-shotlink/dist/hook.js
    const v2Settings = JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: SENTINEL_MATCHER,
            hooks: [{ type: 'command', command: V2_NPM_GLOBAL_CMD, timeout: 30 }],
          },
        ],
      },
    }, null, 2);
    writeFileSync(settingsPath, v2Settings, { mode: 0o600 });

    const result = await installHook({
      settingsPath,
      hookCommand: CANONICAL_CMD,
      matcher: SENTINEL_MATCHER,
      sentinel: NEW_SENTINEL,
      now: () => new Date('2026-04-25T12:00:00.000Z'),
    });

    expect(result.action).toBe('installed');

    const parsed = readSettings(settingsPath) as {
      hooks: { PostToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    // Only the canonical entry must remain
    expect(parsed.hooks.PostToolUse).toHaveLength(1);
    expect(parsed.hooks.PostToolUse[0]!.hooks[0]!.command).toBe(CANONICAL_CMD);
    // Old v0.2 command must be gone
    const allCmds = parsed.hooks.PostToolUse.flatMap((g) => g.hooks.map((h) => h.command));
    expect(allCmds).not.toContain(V2_NPM_GLOBAL_CMD);
  });
});

describe('CA-4 — installHook: unrelated hooks are untouched', () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    ({ dir, settingsPath } = makeSettingsDir());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('unrelated PostToolUse hook (atuin) remains byte-identical after install', async () => {
    const { installHook } = await import('./settings-patcher.js');

    const initialSettings = JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: UNRELATED_CMD, timeout: 60 }],
          },
        ],
      },
    }, null, 2);
    writeFileSync(settingsPath, initialSettings, { mode: 0o600 });

    await installHook({
      settingsPath,
      hookCommand: CANONICAL_CMD,
      matcher: SENTINEL_MATCHER,
      sentinel: NEW_SENTINEL,
      now: () => new Date('2026-04-25T12:00:00.000Z'),
    });

    const parsed = readSettings(settingsPath) as {
      hooks: { PostToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    // Two groups: unrelated + our canonical
    expect(parsed.hooks.PostToolUse).toHaveLength(2);
    // The unrelated hook must still be present and unmodified
    const unrelatedGroup = parsed.hooks.PostToolUse.find((g) =>
      g.hooks.some((h) => h.command === UNRELATED_CMD)
    );
    expect(unrelatedGroup).toBeDefined();
  });
});

describe('CA-4 — uninstallHook: removes all sentinel-matching entries', () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    ({ dir, settingsPath } = makeSettingsDir());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('removes both legacy and new entries matching the sentinel in one pass', async () => {
    const { uninstallHook } = await import('./settings-patcher.js');

    // Two duplicate entries: one dev, one npm-global
    const initialSettings = JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: SENTINEL_MATCHER,
            hooks: [{ type: 'command', command: V2_DEV_CMD, timeout: 30 }],
          },
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: UNRELATED_CMD, timeout: 60 }],
          },
          {
            matcher: SENTINEL_MATCHER,
            hooks: [{ type: 'command', command: V2_NPM_GLOBAL_CMD, timeout: 30 }],
          },
        ],
      },
    }, null, 2);
    writeFileSync(settingsPath, initialSettings, { mode: 0o600 });

    const result = await uninstallHook({
      settingsPath,
      sentinel: NEW_SENTINEL,
      now: () => new Date('2026-04-25T12:00:00.000Z'),
    });

    expect(result.action).toBe('removed');
    expect(result.removedCount).toBe(2);

    const parsed = readSettings(settingsPath) as {
      hooks: { PostToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    // Only the unrelated hook remains
    expect(parsed.hooks.PostToolUse).toHaveLength(1);
    expect(parsed.hooks.PostToolUse[0]!.hooks[0]!.command).toBe(UNRELATED_CMD);

    // No sentinel-matching entry remains
    const sentinelGroups = parsed.hooks.PostToolUse.filter((g) =>
      g.hooks.some((h) => h.command.includes(NEW_SENTINEL))
    );
    expect(sentinelGroups).toHaveLength(0);
  });

  it('uninstall on clean settings.json with no sentinel entries is a no-op (not-present)', async () => {
    const { uninstallHook } = await import('./settings-patcher.js');

    const initialSettings = JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: UNRELATED_CMD, timeout: 60 }],
          },
        ],
      },
    }, null, 2);
    writeFileSync(settingsPath, initialSettings, { mode: 0o600 });

    const result = await uninstallHook({
      settingsPath,
      sentinel: NEW_SENTINEL,
      now: () => new Date('2026-04-25T12:00:00.000Z'),
    });

    expect(result.action).toBe('not-present');
    expect(result.removedCount).toBe(0);
    expect(result.backupPath).toBeNull();
  });
});

// ── Helper fn ─────────────────────────────────────────────────────────────────

function result_backupPath(filename: string | undefined, dir: string): string | null {
  if (!filename) return null;
  return join(dir, filename);
}
