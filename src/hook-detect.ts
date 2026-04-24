/**
 * hook-detect.ts
 *
 * Pure functions for candidate screenshot detection from Claude Code
 * PostToolUse hook payloads. No direct fs calls except via injected seams.
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HookPayload {
  tool_name: 'Write' | 'Bash' | string;
  tool_input: Record<string, unknown>;
  cwd?: string;
  /** ISO8601 — when Claude provides it (PostToolUse). Falls back to Date.now()-60s. */
  started_at?: string;
}

export interface Candidate {
  absPath: string;
  source: 'write' | 'bash-scan';
  mtimeMs: number;
}

export interface FsScan {
  walk(
    roots: string[],
    opts: { sinceMs: number; maxFiles: number; timeoutMs: number },
  ): Promise<Candidate[]>;
}

/** Injection seam for write-path existence check. */
export interface WriteDetectOpts {
  fileExists?: (path: string) => boolean;
}

// ── Regexes ───────────────────────────────────────────────────────────────────

export const SCREENSHOT_EXT_RE = /\.(png|jpe?g|webp)$/i;

export const SCREENSHOT_DIR_RE =
  /(^|\/)(test-results|screenshots|\.playwright|playwright-report)(\/|$)/i;

// ── isScreenshotPath ──────────────────────────────────────────────────────────

/**
 * Returns true if `p` is a path in a recognized screenshot directory AND has
 * a recognized image extension.
 */
export function isScreenshotPath(p: string): boolean {
  return SCREENSHOT_EXT_RE.test(p) && SCREENSHOT_DIR_RE.test(p);
}

// ── detectFromWrite ───────────────────────────────────────────────────────────

/**
 * Extract screenshot candidates from a `Write` tool event.
 * Returns at most one candidate (the written file itself).
 */
export function detectFromWrite(payload: HookPayload, opts: WriteDetectOpts = {}): Candidate[] {
  if (payload.tool_name !== 'Write') return [];

  const rawPath = payload.tool_input['file_path'];
  if (typeof rawPath !== 'string' || !rawPath) return [];

  if (!isScreenshotPath(rawPath)) return [];

  const absPath = resolve(rawPath);
  const fileExists = opts.fileExists ?? ((p: string) => existsSync(p));

  if (!fileExists(absPath)) return [];

  return [
    {
      absPath,
      source: 'write',
      mtimeMs: Date.now(), // mtime not critical for Write events; the file was just written
    },
  ];
}

// ── detectFromBash ────────────────────────────────────────────────────────────

/**
 * Extract screenshot candidates from a `Bash` tool event by scanning the
 * filesystem via the injected `FsScan` implementation.
 */
export async function detectFromBash(
  payload: HookPayload,
  scan: FsScan,
): Promise<Candidate[]> {
  if (payload.tool_name !== 'Bash') return [];

  const command = payload.tool_input['command'];
  if (typeof command !== 'string' || !/\bplaywright\b/.test(command)) return [];

  const cwd = payload.cwd ?? process.cwd();

  // Determine mtime window lower bound
  const startedAtStr =
    payload.started_at ??
    (typeof payload.tool_input['started_at'] === 'string'
      ? (payload.tool_input['started_at'] as string)
      : undefined);

  const t = startedAtStr ? new Date(startedAtStr).getTime() : NaN;
  const sinceMs = Number.isFinite(t) ? t : Date.now() - 60_000;

  return scan.walk([cwd], {
    sinceMs,
    maxFiles: 20,
    timeoutMs: 1_500,
  });
}
