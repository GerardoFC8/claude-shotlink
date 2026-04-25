/**
 * hook.ts
 *
 * Thin entrypoint for the PostToolUse Claude Code hook.
 * Compiled to dist/hook.js by tsup.
 *
 * Responsibilities:
 *   - Read stdin to completion.
 *   - Wire real HookDeps and call runHook().
 *   - Print returned stdout (if any) to process.stdout.
 *   - ALWAYS exit 0 — never disrupt Claude Code.
 *
 * All real logic lives in hook-core.ts (testable in isolation).
 */
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

import { runHook } from './hook-core.js';
import type { HookDeps, PidMetaMin } from './hook-core.js';
import { readPidFile } from './pid.js';
import { loadConfig } from './config.js';
import { DedupCache } from './dedup-cache.js';
import { SCREENSHOT_DIR_RE, SCREENSHOT_EXT_RE } from './hook-detect.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEDUP_PATH = join(homedir(), '.claude-shotlink', 'dedup.json');
const UPLOAD_TIMEOUT_MS = 5_000;

// ── Upload implementation ─────────────────────────────────────────────────────

async function realUploadFn(
  uploadUrl: string,
  filePath: string,
  buf: Buffer,
  apiKey: string,
): Promise<{ id: string; url: string }> {
  const form = new FormData();
  const filename = basename(filePath) || 'screenshot';
  form.append('file', new Blob([buf]), filename);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

  try {
    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey },
      body: form,
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Upload failed: ${res.status}`);
    }

    const json = await res.json() as { id: string; url: string };
    return { id: json.id, url: json.url };
  } finally {
    clearTimeout(timer);
  }
}

// ── Real deps wiring ──────────────────────────────────────────────────────────

function buildRealDeps(): HookDeps {
  const dedupCache = new DedupCache(DEDUP_PATH);

  return {
    readPidFile: async (): Promise<PidMetaMin | null> => {
      return readPidFile();
    },
    readConfig: async () => {
      const cfg = await loadConfig();
      return { apiKey: cfg.apiKey };
    },
    uploadFn: realUploadFn,
    dedupCache,
    fs: {
      async walk(roots, opts) {
        // Real FsScan using fs.opendir recursion
        const { readdir, stat } = await import('node:fs/promises');
        const results: Array<{ absPath: string; source: 'bash-scan'; mtimeMs: number }> = [];
        const deadline = Date.now() + opts.timeoutMs;

        async function scanDir(dir: string): Promise<void> {
          if (Date.now() > deadline) return;
          if (results.length >= opts.maxFiles) return;

          let entries: string[];
          try {
            entries = await readdir(dir);
          } catch {
            return;
          }

          for (const entry of entries) {
            if (Date.now() > deadline) return;
            if (results.length >= opts.maxFiles) return;

            const full = join(dir, entry);
            let st;
            try {
              st = await stat(full);
            } catch {
              continue;
            }

            if (st.isDirectory()) {
              // Only recurse into screenshot dirs or their parents
              if (SCREENSHOT_DIR_RE.test(full) || roots.some((r) => full.startsWith(r))) {
                await scanDir(full);
              }
            } else if (
              SCREENSHOT_EXT_RE.test(entry) &&
              SCREENSHOT_DIR_RE.test(full) &&
              st.mtimeMs >= opts.sinceMs
            ) {
              results.push({ absPath: full, source: 'bash-scan', mtimeMs: st.mtimeMs });
            }
          }
        }

        for (const root of roots) {
          await scanDir(root);
          if (results.length >= opts.maxFiles) break;
        }

        return results.slice(0, opts.maxFiles);
      },
    },
    now: Date.now.bind(Date),
  };
}

// ── Read stdin ────────────────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    const stdin = await readStdin();
    const deps = buildRealDeps();
    const result = await runHook(stdin, deps);

    if (result.stdout) {
      process.stdout.write(result.stdout + '\n');
    }
  } catch {
    // Swallow all errors — never disrupt Claude Code
  } finally {
    process.exit(0);
  }
}

// Resolve both argv[1] and import.meta.url through realpath so symlinks
// (created by `npm install -g`) are handled correctly. See entry-guard.ts.
import { isEntryPoint } from './entry-guard.js';

if (isEntryPoint(process.argv[1], import.meta.url)) {
  void main();
}
