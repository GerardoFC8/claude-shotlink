/**
 * logger.ts
 *
 * Append-only JSONL log writer for ~/.claude-shotlink/log.jsonl.
 *
 * Features:
 *   - appendLog(rec, path?, enabled?)  — write one JSONL line; no-op when disabled
 *   - readTail(n, path?)               — return last N lines from the log file
 *   - followTail(onLine, path?)        — stream new appended lines in real time
 *
 * Rotation:  when log.jsonl reaches 10 MB, it is renamed to log.jsonl.1
 *            and a fresh log.jsonl is created. Rotated files are never auto-deleted.
 *
 * Log record schema (NEVER includes file content):
 *   { timestamp: ISO8601, sha256: hex, size: number, status: 'uploaded'|'deduped'|'error', url?: string }
 *
 * File permissions: 0o600.
 */
import { readFile, writeFile, rename, mkdir, stat, open } from 'node:fs/promises';
import { watchFile, unwatchFile, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

// ── Constants ─────────────────────────────────────────────────────────────────

const ROTATION_THRESHOLD = 10 * 1024 * 1024; // 10 MB

/**
 * Default log file path.
 */
export const LOG_PATH: string = join(homedir(), '.claude-shotlink', 'log.jsonl');

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LogRecord {
  timestamp: string;
  sha256: string;
  size: number;
  status: 'uploaded' | 'deduped' | 'error';
  url?: string;
}

// ── appendLog ─────────────────────────────────────────────────────────────────

/**
 * Append one JSONL record to the log file.
 *
 * @param rec      Log record to write.
 * @param path     File path (default: LOG_PATH).
 * @param enabled  When false (default), this is a no-op and no file is created.
 */
export async function appendLog(
  rec: LogRecord,
  path: string = LOG_PATH,
  enabled: boolean = false
): Promise<void> {
  if (!enabled) return;

  // Rotation check: if file already exists and is >= 10 MB, rotate first.
  try {
    const s = await stat(path);
    if (s.size >= ROTATION_THRESHOLD) {
      await rename(path, path + '.1');
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
    // File doesn't exist yet — no rotation needed
  }

  // Ensure parent directory exists
  await mkdir(dirname(path), { recursive: true });

  // Build the JSONL line — include url only if present
  const entry: LogRecord = {
    timestamp: rec.timestamp,
    sha256: rec.sha256,
    size: rec.size,
    status: rec.status,
  };
  if (rec.url !== undefined) {
    entry.url = rec.url;
  }

  const line = JSON.stringify(entry) + '\n';

  // Append using a file handle to get precise append semantics
  const fh = await open(path, 'a', 0o600);
  try {
    await fh.write(line);
  } finally {
    await fh.close();
  }
}

// ── readTail ──────────────────────────────────────────────────────────────────

/**
 * Return the last `n` lines from the log file.
 *
 * @param n     Number of lines to return from the end.
 * @param path  File path (default: LOG_PATH).
 * @returns     Array of raw line strings. Empty array when file is absent.
 */
export async function readTail(n: number, path: string = LOG_PATH): Promise<string[]> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }

  const lines = content.split('\n').filter((l) => l.length > 0);
  return lines.slice(-n);
}

// ── followTail ────────────────────────────────────────────────────────────────

/**
 * Watch the log file and call `onLine` for each new line appended.
 *
 * Uses fs.watchFile (polling) which works reliably on Linux, macOS, and WSL.
 * The interval is 250 ms — low enough for interactive use, light enough on CPU.
 *
 * @param onLine  Callback invoked with each new raw line string.
 * @param path    File path (default: LOG_PATH).
 * @returns       Unsubscribe function — call to stop watching.
 */
export function followTail(onLine: (line: string) => void, path: string = LOG_PATH): () => void {
  let lastSize = 0;

  // Initialise lastSize from current file size if it exists
  try {
    const s = statSync(path);
    lastSize = s.size;
  } catch {
    // File doesn't exist yet — start from 0
    lastSize = 0;
  }

  const listener = (_curr: import('node:fs').Stats, _prev: import('node:fs').Stats): void => {
    let currentSize: number;
    try {
      currentSize = statSync(path).size;
    } catch {
      // File removed or temporarily unavailable
      return;
    }

    // Detect rotation: new file is smaller than our last position
    if (currentSize < lastSize) {
      lastSize = 0;
    }

    if (currentSize <= lastSize) return;

    // Read only the new bytes
    const bytesToRead = currentSize - lastSize;
    const buf = Buffer.alloc(bytesToRead);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, buf, 0, bytesToRead, lastSize);
    } finally {
      closeSync(fd);
    }
    lastSize = currentSize;

    const chunk = buf.toString('utf8');
    const lines = chunk.split('\n').filter((l) => l.length > 0);
    for (const line of lines) {
      onLine(line);
    }
  };

  watchFile(path, { interval: 250, persistent: false }, listener);

  return () => {
    unwatchFile(path, listener);
  };
}
