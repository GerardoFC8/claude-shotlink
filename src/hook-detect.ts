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
  source: 'write' | 'bash-scan' | 'bash-flag';
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

/** Injection seam for bash-flag path extraction. */
export interface BashDetectOpts {
  /** Defaults to existsSync. */
  fileExists?: (path: string) => boolean;
}

// ── Regexes ───────────────────────────────────────────────────────────────────

export const SCREENSHOT_EXT_RE = /\.(png|jpe?g|webp)$/i;

/**
 * Matches relative/absolute paths under recognized screenshot directories.
 * v0.2: widened to include .playwright-cli, playwright-*, *-playwright.
 * FIX-7: tmp/temp are ROOT-anchored only (^tmp or ^temp) to avoid false positives
 * in build caches like /home/user/.npm/cache/tmp/. Absolute /tmp/ and /var/tmp/
 * are covered by ABSOLUTE_TMP_RE. Case-insensitive.
 */
export const SCREENSHOT_DIR_RE =
  /(^|\/)(test-results|screenshots|\.playwright|\.playwright-cli|playwright-report|playwright-[^/]+|[^/]+-playwright)(\/|$)|^(tmp|temp)(\/|$)/i;

/**
 * Matches absolute paths starting with /tmp/ or /var/tmp/.
 * Used for Write events and flag-derived candidate paths that bypass the
 * directory whitelist check. We do NOT walk /tmp or /var/tmp — this only
 * fires through isScreenshotPath and detectPathsFromBashFlags.
 */
export const ABSOLUTE_TMP_RE = /^(\/tmp\/|\/var\/tmp\/)/;

// ── isScreenshotPath ──────────────────────────────────────────────────────────

/**
 * Returns true if `p` has a recognized image extension AND is in a recognized
 * screenshot directory (via SCREENSHOT_DIR_RE) OR is an absolute /tmp or
 * /var/tmp path (via ABSOLUTE_TMP_RE).
 */
export function isScreenshotPath(p: string): boolean {
  if (!SCREENSHOT_EXT_RE.test(p)) return false;
  return SCREENSHOT_DIR_RE.test(p) || ABSOLUTE_TMP_RE.test(p);
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

// ── tokenize ──────────────────────────────────────────────────────────────────

/**
 * Shell-style tokenizer: handles single-quoted, double-quoted, and unquoted
 * tokens. Embedded spaces in quoted args are preserved. Does NOT handle
 * escape sequences beyond quote-within-quote.
 */
/** Returns true if ch is a whitespace character (space, tab, newline, carriage return). */
function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function tokenize(cmd: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i]!;
    if (isWhitespace(ch)) {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let buf = '';
      while (i < cmd.length && cmd[i] !== quote) {
        if (cmd[i] === '\\' && cmd[i + 1] === quote) {
          buf += quote;
          i += 2;
          continue;
        }
        buf += cmd[i]!;
        i++;
      }
      i++; // skip closing quote
      out.push(buf);
    } else {
      let buf = '';
      while (i < cmd.length && !isWhitespace(cmd[i]!)) {
        buf += cmd[i]!;
        i++;
      }
      out.push(buf);
    }
  }
  return out;
}

// ── detectPathsFromBashFlags ──────────────────────────────────────────────────

/** Recognized long-form flags that take a path value. */
const PATH_FLAGS_LONG = new Set(['--filename', '--output', '--path', '--screenshot']);
/** Recognized short-form flags that take a path value. */
const PATH_FLAGS_SHORT = new Set(['-o']);

/**
 * Extracts file-path arguments from screenshot-related flags in a Bash
 * command string. Supports both space-separated and `=`-separated forms.
 * Returns resolved absolute paths that:
 *   - have a recognized screenshot extension (.png, .jpg, .jpeg, .webp)
 *   - exist on disk (via injected fileExists seam)
 * Relative paths are resolved against `opts.cwd` (defaults to process.cwd()).
 * Directory whitelist is NOT applied — that's the purpose of the flag path.
 */
export function detectPathsFromBashFlags(
  cmd: string,
  opts: BashDetectOpts & { cwd?: string } = {},
): string[] {
  const fileExists = opts.fileExists ?? ((p: string) => existsSync(p));
  const cwd = opts.cwd ?? process.cwd();
  const tokens = tokenize(cmd);
  const rawPaths: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;

    // = form: --filename=/tmp/x.png
    for (const flag of PATH_FLAGS_LONG) {
      if (t.startsWith(flag + '=')) {
        rawPaths.push(t.slice(flag.length + 1));
      }
    }

    // Space form: --filename /tmp/x.png  OR  -o /tmp/x.png
    if (PATH_FLAGS_LONG.has(t) || PATH_FLAGS_SHORT.has(t)) {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        rawPaths.push(next);
        i++; // consume value token
      }
    }
  }

  const results: string[] = [];
  for (const raw of rawPaths) {
    const abs = resolve(cwd, raw); // resolve handles both absolute and relative
    if (!SCREENSHOT_EXT_RE.test(abs)) continue;
    if (!fileExists(abs)) continue;
    results.push(abs);
  }
  return results;
}

// ── detectFromBash ────────────────────────────────────────────────────────────

/**
 * Extract screenshot candidates from a `Bash` tool event by scanning the
 * filesystem via the injected `FsScan` implementation, and also via explicit
 * flag-based path extraction. Results from both sources are merged and
 * deduped by absPath (flag source wins on tie).
 */
export async function detectFromBash(
  payload: HookPayload,
  scan: FsScan,
  opts: BashDetectOpts = {},
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

  // 1. Filesystem scan (existing path)
  const scanResults = await scan.walk([cwd], {
    sinceMs,
    maxFiles: 20,
    timeoutMs: 1_500,
  });

  // 2. Flag-derived candidates
  const flagPaths = detectPathsFromBashFlags(command, { cwd, fileExists: opts.fileExists });
  const flagCandidates: Candidate[] = flagPaths.map(abs => ({
    absPath: abs,
    source: 'bash-flag',
    mtimeMs: Date.now(),
  }));

  // 3. Dedup by absPath; flag-source wins on tie
  const byAbs = new Map<string, Candidate>();
  for (const c of scanResults) byAbs.set(c.absPath, c);
  for (const c of flagCandidates) byAbs.set(c.absPath, c);

  return Array.from(byAbs.values()).slice(0, 20);
}
