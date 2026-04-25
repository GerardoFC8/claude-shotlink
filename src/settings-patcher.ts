/**
 * settings-patcher.ts
 *
 * Idempotent read-backup-merge-write handler for ~/.claude/settings.json.
 *
 * Authoritative hook entry shape (hook-schema resolution):
 *   {
 *     "matcher": "Bash|Write",
 *     "hooks": [{ "type": "command", "command": "<absolute cmd>", "timeout": 30 }]
 *   }
 *
 * Sentinel strategy:
 *   A hook entry is "ours" if any inner hook's `command` contains the
 *   `sentinel` string (typically the absolute path to dist/hook.js).
 *   Exact match means no backup + no write (idempotent no-op).
 *   Sentinel match but different command means backup + rewrite.
 *
 * Chain-merge: append a NEW top-level matcher-group; never mutate siblings.
 * Atomic write: temp file + rename (same directory for cross-device rename).
 * File mode: 0o600 on all written files.
 *
 * Backup naming:
 *   <settingsPath>.backup-<ISO8601 compact>
 *   e.g.  settings.json.backup-2026-04-24T12:00:00.000Z
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { writeAtomic as writeAtomicShared } from './atomic-write.js';

// ── Sentinel constant ─────────────────────────────────────────────────────────

/**
 * Substring sentinel used to identify claude-shotlink hook entries in
 * settings.json. Using a substring (not a full path) means:
 *
 *   - v0.2 entries (full path ending with this substring) are auto-detected
 *   - entries from different install locations (dev, npm-global, pnpm) are all
 *     matched by a single contains-check
 *   - duplicate entries from multiple install paths are collapsed to one on
 *     re-install (the REPLACE branch in installHook fires)
 *
 * The sentinel is package-directory–scoped (`claude-shotlink/dist/hook.js`)
 * which is stable across all install layouts that npm/pnpm use.
 */
export const SHOTLINK_HOOK_SENTINEL = 'claude-shotlink/dist/hook.js';

// ── Public types ──────────────────────────────────────────────────────────────

export interface InstallHookOpts {
  settingsPath: string;       // absolute path to settings.json
  hookCommand: string;        // full command string (e.g. "node /abs/dist/hook.js")
  matcher: string;            // e.g. "Bash|Write"
  sentinel: string;           // substring used to identify our entry (e.g. "/dist/hook.js")
  now?: () => Date;           // injectable clock for deterministic backup names in tests
}

export interface InstallResult {
  action: 'installed' | 'already-present';
  backupPath: string | null; // null when action === 'already-present'
}

export interface UninstallHookOpts {
  settingsPath: string;
  sentinel: string;
  now?: () => Date;
}

export interface UninstallResult {
  action: 'removed' | 'not-present';
  backupPath: string | null; // null when action === 'not-present'
  removedCount: number;
}

export interface RestoreResult {
  action: 'restored' | 'no-backup';
  backupUsed: string | null; // filename (not full path) of the backup restored
}

// ── Settings JSON shape ───────────────────────────────────────────────────────

interface HookEntry {
  type: string;
  command: string;
  timeout?: number;
}

interface MatcherGroup {
  matcher: string;
  hooks: HookEntry[];
}

interface SettingsJson {
  hooks?: {
    PostToolUse?: MatcherGroup[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ── installHook ───────────────────────────────────────────────────────────────

/**
 * Install our PostToolUse hook entry into settings.json.
 *
 * - Idempotent: if our sentinel+command already present → returns already-present, no I/O.
 * - Sentinel matches but command differs → backup + rewrite.
 * - Not present → backup + append.
 * - File absent → treat as '{}', backup the empty state, create file.
 */
export async function installHook(opts: InstallHookOpts): Promise<InstallResult> {
  const { settingsPath, hookCommand, matcher, sentinel, now = () => new Date() } = opts;

  // ── Read current content (or treat as empty object) ─────────────────────
  let raw: string;
  let parsedOriginal: SettingsJson;

  if (!existsSync(settingsPath)) {
    raw = '{}';
    parsedOriginal = {};
  } else {
    raw = await readFile(settingsPath, 'utf8');
    try {
      parsedOriginal = JSON.parse(raw) as SettingsJson;
    } catch {
      throw new Error(`Failed to parse settings file at ${settingsPath}: invalid JSON.`);
    }
  }

  const parsed: SettingsJson = JSON.parse(JSON.stringify(parsedOriginal)) as SettingsJson;

  // ── Check for existing entry ─────────────────────────────────────────────
  const postToolUse: MatcherGroup[] = parsed.hooks?.PostToolUse ?? [];

  for (const group of postToolUse) {
    for (const hook of group.hooks ?? []) {
      if (hook.type === 'command' && hook.command.includes(sentinel)) {
        if (hook.command === hookCommand) {
          // Exact match — true idempotent no-op
          return { action: 'already-present', backupPath: null };
        }
        // Sentinel matches but command differs → fall through to rewrite
      }
    }
  }

  // ── Take a backup before any mutation ────────────────────────────────────
  const backupPath = `${settingsPath}.backup-${now().toISOString().replace(/:/g, '-')}`;
  const dir = dirname(settingsPath);
  await mkdir(dir, { recursive: true });
  await writeFile(backupPath, raw, { mode: 0o600, encoding: 'utf8' });

  // ── Remove old sentinel entry (if command differed) ───────────────────────
  const filteredGroups = postToolUse.filter(
    (g) => !g.hooks?.some((h) => h.type === 'command' && h.command.includes(sentinel))
  );

  // ── Append our new entry ──────────────────────────────────────────────────
  const ourEntry: MatcherGroup = {
    matcher,
    hooks: [{ type: 'command', command: hookCommand, timeout: 30 }],
  };
  filteredGroups.push(ourEntry);

  // ── Merge back ────────────────────────────────────────────────────────────
  if (!parsed.hooks) {
    parsed.hooks = {};
  }
  parsed.hooks['PostToolUse'] = filteredGroups;

  // ── Atomic write ──────────────────────────────────────────────────────────
  await writeAtomic(settingsPath, JSON.stringify(parsed, null, 2));

  return { action: 'installed', backupPath };
}

// ── uninstallHook ─────────────────────────────────────────────────────────────

/**
 * Remove our PostToolUse hook entry from settings.json.
 *
 * - If our sentinel is not found → returns not-present, no I/O.
 * - Otherwise → backup + rewrite without our entry.
 */
export async function uninstallHook(opts: UninstallHookOpts): Promise<UninstallResult> {
  const { settingsPath, sentinel, now = () => new Date() } = opts;

  if (!existsSync(settingsPath)) {
    return { action: 'not-present', backupPath: null, removedCount: 0 };
  }

  const raw = await readFile(settingsPath, 'utf8');
  let parsed: SettingsJson;
  try {
    parsed = JSON.parse(raw) as SettingsJson;
  } catch {
    throw new Error(`Failed to parse settings file at ${settingsPath}: invalid JSON.`);
  }

  const postToolUse: MatcherGroup[] = parsed.hooks?.PostToolUse ?? [];

  // Check if any of our entries exist
  const toRemove = postToolUse.filter((g) =>
    g.hooks?.some((h) => h.type === 'command' && h.command.includes(sentinel))
  );

  if (toRemove.length === 0) {
    return { action: 'not-present', backupPath: null, removedCount: 0 };
  }

  // Backup before mutation
  const backupPath = `${settingsPath}.backup-${now().toISOString().replace(/:/g, '-')}`;
  await writeFile(backupPath, raw, { mode: 0o600, encoding: 'utf8' });

  // Filter out our entries
  const filtered = postToolUse.filter(
    (g) => !g.hooks?.some((h) => h.type === 'command' && h.command.includes(sentinel))
  );

  if (!parsed.hooks) {
    parsed.hooks = {};
  }
  parsed.hooks['PostToolUse'] = filtered;

  await writeAtomic(settingsPath, JSON.stringify(parsed, null, 2));

  return { action: 'removed', backupPath, removedCount: toRemove.length };
}

// ── listBackups ───────────────────────────────────────────────────────────────

/**
 * Return all backup filenames (not full paths) for settings.json in the given
 * directory, sorted alphabetically (ISO dates sort correctly as strings).
 */
export async function listBackups(settingsDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(settingsDir);
  } catch {
    return [];
  }

  return entries
    .filter((f) => f.startsWith('settings.json.backup-'))
    .sort();
}

// ── restoreBackup ─────────────────────────────────────────────────────────────

export interface RestoreOpts {
  settingsDir: string;
  settingsPath: string;
}

/**
 * Restore the most-recently-dated backup verbatim to settings.json.
 */
export async function restoreBackup(opts: RestoreOpts): Promise<RestoreResult> {
  const { settingsDir, settingsPath } = opts;

  const backups = await listBackups(settingsDir);
  if (backups.length === 0) {
    return { action: 'no-backup', backupUsed: null };
  }

  // Most recent = last alphabetically (ISO8601 sorts correctly)
  const mostRecent = backups[backups.length - 1]!;
  const backupFullPath = join(settingsDir, mostRecent);

  const content = await readFile(backupFullPath, 'utf8');
  await writeAtomicShared(settingsPath, content, { mode: 0o600 });

  return { action: 'restored', backupUsed: mostRecent };
}

// ── writeAtomic ───────────────────────────────────────────────────────────────

/**
 * Write JSON content to the target path atomically.
 * Validates the content parses as JSON before writing.
 * Delegates to the shared writeAtomic helper.
 */
async function writeAtomic(targetPath: string, content: string): Promise<void> {
  // Validate JSON before writing
  JSON.parse(content);
  await writeAtomicShared(targetPath, content, { mode: 0o600, tmpPrefix: '.settings-tmp-' });
}
