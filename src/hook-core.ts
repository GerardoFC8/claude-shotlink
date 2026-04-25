/**
 * hook-core.ts
 *
 * Testable core of the PostToolUse hook runtime.
 *
 * Export: `runHook(stdin, deps, opts)` — pure orchestration with all
 * external dependencies injected. No process.exit, no direct fs, no
 * global fetch. The real src/hook.ts is a thin wrapper around this.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { detectFromWrite, detectFromBash } from './hook-detect.js';
import type { HookPayload, FsScan, Candidate } from './hook-detect.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PidMetaMin {
  pid: number;
  port: number;
  tunnelUrl: string | null;
  startedAt: string;
}

export interface DedupCacheMin {
  load(): Promise<void>;
  lookup(sha: string): string | null;
  remember(sha: string, url: string): void;
  flush(): Promise<void>;
}

export interface UploadResult {
  id: string;
  url: string;
}

export interface HookDeps {
  /** Read PID file — returns null if missing or stale. */
  readPidFile(): Promise<PidMetaMin | null>;
  /** Load config for apiKey. */
  readConfig(): Promise<{ apiKey: string }>;
  /**
   * Upload a file and return { id, url }.
   * `buf` is the already-read file content (same bytes used for sha256),
   * eliminating a double-read and closing the TOCTOU gap in dedup.
   */
  uploadFn(
    uploadUrl: string,
    filePath: string,
    buf: Buffer,
    apiKey: string,
  ): Promise<UploadResult>;
  /** Dedup cache instance. */
  dedupCache: DedupCacheMin;
  /** FsScan for bash candidate discovery. */
  fs: FsScan;
  /** Now function for TTL / timing purposes. */
  now(): number;
}

export interface RunHookOpts {
  /** Override file-existence check for detectFromWrite (test seam). */
  fileExists?: (path: string) => boolean;
  /** Override readFile for computing sha256 / upload (test seam). */
  readFileFn?: (path: string) => Promise<Buffer>;
}

export interface HookOutput {
  /** JSON string to print to stdout. Absent → print nothing. */
  stdout?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_CANDIDATES = 20;

// ── runHook ───────────────────────────────────────────────────────────────────

/**
 * Main hook logic. Parses `stdin`, detects candidates, deduplicates,
 * uploads, and returns the output JSON (if any).
 *
 * NEVER throws — catches all errors internally and returns `{}` on failure.
 */
export async function runHook(
  stdin: string,
  deps: HookDeps,
  opts: RunHookOpts = {},
): Promise<HookOutput> {
  try {
    return await doRunHook(stdin, deps, opts);
  } catch {
    // Catch-all: never propagate to the caller (hook.ts wraps this in
    // try/catch/finally process.exit(0) anyway)
    return {};
  }
}

async function doRunHook(
  stdin: string,
  deps: HookDeps,
  opts: RunHookOpts,
): Promise<HookOutput> {
  // 1. Parse stdin
  let payload: HookPayload;
  try {
    payload = JSON.parse(stdin) as HookPayload;
  } catch {
    return {};
  }

  // Validate minimal shape
  if (typeof payload !== 'object' || payload === null) return {};
  if (typeof payload.tool_name !== 'string') return {};

  // 2. Filter to supported tools
  if (payload.tool_name !== 'Write' && payload.tool_name !== 'Bash') {
    return {};
  }

  // 3. Read PID file — abort if relay not known
  const pidMeta = await deps.readPidFile();
  if (pidMeta === null) {
    return {};
  }

  // 4. Load config for API key
  const config = await deps.readConfig();
  const apiKey = config.apiKey;
  const uploadUrl = `http://127.0.0.1:${pidMeta.port}/upload`;

  // 5. Detect candidates
  const fileExistsFn = opts.fileExists ?? defaultFileExists;
  let candidates: Candidate[];

  if (payload.tool_name === 'Write') {
    candidates = detectFromWrite(payload, { fileExists: fileExistsFn });
  } else {
    // Bash
    candidates = await detectFromBash(payload, deps.fs);
  }

  if (candidates.length === 0) {
    return {};
  }

  // Cap at 20
  const limited = candidates.slice(0, MAX_CANDIDATES);

  // 6. Load dedup cache
  await deps.dedupCache.load();

  // 7. For each candidate: sha256, dedup check, upload
  const readFileFn = opts.readFileFn ?? defaultReadFile;
  const urls: string[] = [];

  for (const candidate of limited) {
    try {
      const buf = await readFileFn(candidate.absPath);
      const sha = sha256hex(buf);

      const cached = deps.dedupCache.lookup(sha);
      if (cached !== null) {
        urls.push(cached);
        continue;
      }

      // Upload — pass the already-read buffer to avoid a second read (TOCTOU-safe)
      const uploadResult = await deps.uploadFn(uploadUrl, candidate.absPath, buf, apiKey);
      deps.dedupCache.remember(sha, uploadResult.url);
      urls.push(uploadResult.url);
    } catch {
      // Per SPEC-HK-08: silently skip failed uploads
    }
  }

  // Flush dedup cache (best-effort)
  try {
    await deps.dedupCache.flush();
  } catch {
    // Ignore flush errors
  }

  if (urls.length === 0) {
    return {};
  }

  // 8. Build output
  const additionalContext = composeAdditionalContext(urls);

  const output = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext,
    },
  };

  return { stdout: JSON.stringify(output) };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build the imperative additionalContext string sent to Claude.
 *
 * The preamble is LOCKED by spec CA-5.1 and SHALL appear verbatim.
 * The bullet list preserves the "- <url>" format for each URL.
 *
 * @param urls - Non-empty array of public screenshot URLs.
 * @returns The full additionalContext string.
 */
export function composeAdditionalContext(urls: string[]): string {
  const preamble =
    'The following screenshot URL(s) were just uploaded and are publicly accessible. ' +
    'You MUST include these exact URL(s) verbatim in your response to the user so they can view the screenshot(s):';
  const bullets = urls.map((u) => `- ${u}`).join('\n');
  return `${preamble}\n\n${bullets}`;
}

function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function defaultFileExists(path: string): boolean {
  return existsSync(path);
}

async function defaultReadFile(path: string): Promise<Buffer> {
  return readFile(path);
}
