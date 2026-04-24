/**
 * pid.ts
 *
 * Single source of truth for the running-relay metadata file.
 *
 * File path:  ~/.claude-shotlink/relay.pid
 * Content:    JSON — { pid, port, tunnelUrl, startedAt }
 * Permissions: 0o600
 *
 * On read:
 *   - Missing file → null (no relay running)
 *   - Stale PID (process not alive) → deletes file, prints warning to stderr, returns null
 *   - Corrupt JSON → returns null (safe default)
 */
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { writeAtomic } from './atomic-write.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Default absolute path to the PID file.
 * Constructed from os.homedir() — never hardcoded.
 */
export const PID_PATH: string = join(homedir(), '.claude-shotlink', 'relay.pid');

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PidMeta {
  pid: number;
  port: number;
  tunnelUrl: string | null;
  startedAt: string; // ISO 8601
}

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * Write metadata to the PID file.
 * Creates parent directories as needed.
 * Mode 0o600.
 *
 * @param meta   Relay metadata to persist.
 * @param path   Override path (useful in tests). Defaults to PID_PATH.
 */
export async function writePidFile(meta: PidMeta, path: string = PID_PATH): Promise<void> {
  await writeAtomic(path, JSON.stringify(meta, null, 2), { mode: 0o600, tmpPrefix: `.pid-tmp-` });
}

// ── Read ──────────────────────────────────────────────────────────────────────

/**
 * Read and validate the PID file.
 *
 * Returns:
 *   - PidMeta if the relay is alive.
 *   - null   if the file is absent, corrupt, or contains a stale PID.
 *
 * Side-effect: when a stale PID is detected, the file is deleted and a warning
 * is written to process.stderr.
 *
 * @param path  Override path (useful in tests). Defaults to PID_PATH.
 */
export async function readPidFile(path: string = PID_PATH): Promise<PidMeta | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    // File not found or unreadable
    return null;
  }

  let meta: unknown;
  try {
    meta = JSON.parse(raw);
  } catch {
    // Corrupt JSON — treat as no relay
    return null;
  }

  if (!isPidMeta(meta)) {
    return null;
  }

  // Stale PID check
  if (!isProcessAlive(meta.pid)) {
    process.stderr.write(`Stale PID file removed (pid ${meta.pid} is not running).\n`);
    await deletePidFile(path);
    return null;
  }

  return meta;
}

// ── Delete ────────────────────────────────────────────────────────────────────

/**
 * Delete the PID file. No-ops silently if the file does not exist.
 *
 * @param path  Override path (useful in tests). Defaults to PID_PATH.
 */
export async function deletePidFile(path: string = PID_PATH): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }
}

// ── isProcessAlive ────────────────────────────────────────────────────────────

/**
 * Check whether a process with the given PID is alive.
 * Uses process.kill(pid, 0) — signal 0 does not actually send a signal;
 * it is used purely as a liveness probe.
 *
 * Returns true  if the process exists (signal accepted).
 * Returns false if the process does not exist (ESRCH) or permission denied (EPERM, unlikely
 * for our own processes but treated as "alive" to avoid false-positive cleanup).
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ESRCH = No such process → definitively not alive
    if (code === 'ESRCH') return false;
    // EPERM = process exists but we can't signal it → alive
    return true;
  }
}

// ── Type guard ────────────────────────────────────────────────────────────────

function isPidMeta(value: unknown): value is PidMeta {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['pid'] === 'number' &&
    typeof v['port'] === 'number' &&
    (v['tunnelUrl'] === null || typeof v['tunnelUrl'] === 'string') &&
    typeof v['startedAt'] === 'string'
  );
}
