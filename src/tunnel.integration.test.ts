/**
 * tunnel.integration.test.ts
 *
 * Integration smoke tests for cloudflared binary spawn args.
 *
 * These tests are SKIPPED by default (requires CLAUDE_SHOTLINK_INTEGRATION=1 env var).
 * They invoke the REAL cloudflared binary to validate:
 *   1. Binary version check
 *   2. --no-autoupdate flag placement
 *   3. Spawn args contract (no parse-level usage banner)
 *
 * The bug regression test catches the v0.2.1 issue where --no-autoupdate
 * was placed after 'run', causing cloudflared to reject the args.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Configuration ─────────────────────────────────────────────────────────────

const BINARY_PATH = join(homedir(), '.claude-shotlink', 'bin', 'cloudflared');
const ENABLED = process.env['CLAUDE_SHOTLINK_INTEGRATION'] === '1';
const BINARY_PRESENT = existsSync(BINARY_PATH);

const SKIP_REASON = (() => {
  if (!ENABLED) return 'Set CLAUDE_SHOTLINK_INTEGRATION=1 to run integration tests';
  if (!BINARY_PRESENT) return `Binary missing at ${BINARY_PATH} — run \`claude-shotlink start\` once or \`pnpm exec\` to download`;
  return null;
})();

// ── Helper: spawn and capture output ──────────────────────────────────────────

interface SpawnResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

function runBinary(args: string[], timeoutMs: number): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(BINARY_PATH, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        code: -1,
        signal: null,
        stdout,
        stderr: `Error spawning: ${err.message}`,
      });
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: timedOut ? -1 : code,
        signal: timedOut ? 'SIGKILL' : signal,
        stdout,
        stderr,
      });
    });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe.skipIf(SKIP_REASON !== null)('cloudflared spawn args (real binary)', () => {
  it('cloudflared --version exits 0 with semver in output', async () => {
    const result = await runBinary(['--version'], 10000);
    expect(result.code).toBe(0);
    // cloudflared prints something like: "cloudflared version 2024.12.2 (built 2024-12-01)"
    expect(result.stdout + result.stderr).toMatch(/cloudflared version \d+\.\d+\.\d+/);
  });

  it('cloudflared tunnel --help documents --no-autoupdate flag', async () => {
    const result = await runBinary(['tunnel', '--help'], 10000);
    expect(result.code).toBe(0);
    // The crucial assertion: --no-autoupdate must appear in the tunnel-level help
    // (not buried in a subcommand). This is what regressed in v0.2.1.
    expect(result.stdout).toContain('--no-autoupdate');
  });

  it('spawn args for named tunnel do not trigger arg-parse rejection', async () => {
    // This is the regression test for v0.2.1 --no-autoupdate placement bug.
    // Args match the v0.3 spawn contract exactly, with --no-autoupdate BEFORE 'run'.
    // Tunnel does not exist + credentials file is /dev/null → cloudflared MUST
    // fail at auth/lookup, NOT at arg-parse time.
    const result = await runBinary(
      [
        'tunnel',
        '--no-autoupdate',
        'run',
        '--credentials-file',
        '/dev/null',
        '--url',
        'http://127.0.0.1:1',
        'nonexistent-tunnel-name',
      ],
      5000,
    );

    // The process WILL exit non-zero (credentials missing, tunnel nonexistent).
    // But it should NOT exit due to arg-parse error, which would print usage banner.
    expect(result.code).not.toBe(0);

    const output = result.stdout + result.stderr;

    // v0.2.1-style failure: "Incorrect Usage" or "flag provided but not defined"
    // If we see these, the args were rejected at parse time (the bug).
    expect(output).not.toMatch(/Incorrect Usage/i);
    expect(output).not.toMatch(/flag provided but not defined/i);

    // Verify we got PAST arg parsing by checking for auth/lookup errors.
    // cloudflared prints various error patterns on auth failure:
    // - "Error: ..." when credentials file missing
    // - "unauthorized" when creds invalid
    // - connection errors when tunnel doesn't exist
    // We just assert that the error is NOT a usage banner (arg-parse).
  });
});
