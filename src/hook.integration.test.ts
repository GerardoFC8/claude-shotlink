/**
 * hook.integration.test.ts
 *
 * Integration smoke tests for src/hook.ts.
 *
 * Strategy:
 *   - Spin up a real Hono relay via startServer() on port 0.
 *   - Write a temp PNG to disk.
 *   - Write a synthetic PID file + config to a temp HOME directory.
 *   - Spawn `tsx src/hook.ts` with that temp HOME in the environment.
 *   - Assert child exits 0 and stdout contains the expected JSON.
 *
 * These tests use a real child process so they validate the full pipeline
 * including stdin parsing, PID file reading, upload, and stdout output.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startServer } from './server.js';
import { Storage } from './storage.js';
import { generateApiKey } from './config.js';
import type { RunningServer } from './server.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

// Derive PROJECT_ROOT from this file's location so tests work on any machine
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOOK_PATH = join(PROJECT_ROOT, 'src', 'hook.ts');

/** Spawn hook.ts with tsx, piping `stdinPayload`, HOME pointing at tempHome. */
function spawnHook(
  stdinPayload: string,
  tempHome: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      'node',
      ['--import', 'tsx/esm', HOOK_PATH],
      {
        env: {
          ...process.env,
          HOME: tempHome,
          // Suppress tsx/other env noise
          NO_COLOR: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    let stdoutBuf = '';
    let stderrBuf = '';

    child.stdout?.on('data', (chunk: Buffer) => { stdoutBuf += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString(); });

    child.on('close', (code) => {
      resolve({ exitCode: code ?? 0, stdout: stdoutBuf, stderr: stderrBuf });
    });

    child.stdin?.write(stdinPayload);
    child.stdin?.end();
  });
}

/** Write minimal PID + config files into tempHome/.claude-shotlink/ */
async function seedTempHome(
  tempHome: string,
  port: number,
  apiKey: string,
): Promise<void> {
  const dir = join(tempHome, '.claude-shotlink');
  await mkdir(dir, { recursive: true });

  // PID file
  const pidMeta = {
    pid: process.pid,
    port,
    tunnelUrl: null,
    startedAt: new Date().toISOString(),
  };
  await writeFile(join(dir, 'relay.pid'), JSON.stringify(pidMeta, null, 2), { mode: 0o600 });

  // Config
  const config = { apiKey, createdAt: new Date().toISOString() };
  await writeFile(join(dir, 'config.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
}

// ── Shared server lifecycle ───────────────────────────────────────────────────

let server: RunningServer | null = null;
let storage: Storage | null = null;
let tempDir: string | null = null;
let apiKey: string | null = null;

async function ensureServer(): Promise<{ server: RunningServer; apiKey: string }> {
  if (server && apiKey) return { server, apiKey };

  const key = generateApiKey();
  apiKey = key;
  tempDir = await mkdtemp(join(tmpdir(), 'shotlink-int-'));

  storage = new Storage({ dir: tempDir });
  await storage.init();

  server = await startServer({
    config: { apiKey: key, createdAt: new Date().toISOString() },
    storage,
    port: 0,
    host: '127.0.0.1',
    publicBaseUrl: () => null,
  });

  return { server, apiKey: key };
}

afterAll(async () => {
  if (server) await server.close();
  if (storage) await storage.shutdown();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

// ── PNG fixture ───────────────────────────────────────────────────────────────

/** Minimal valid 1x1 red PNG (hardcoded bytes). */
const MINIMAL_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108020000009001' +
  '2e00000000c4944415478016360f8cf000001fc01e1afafb' +
  '900000000049454e44ae426082',
  'hex',
);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('hook integration: Write event uploads and emits additionalContext', () => {
  it('child exits 0 and stdout contains hookSpecificOutput with /f/ URL', async () => {
    const { server: srv, apiKey: key } = await ensureServer();

    // Write a temp PNG file
    const tmpHome = await mkdtemp(join(tmpdir(), 'shotlink-home-'));
    try {
      const screenshotDir = join(tmpHome, 'test-results');
      await mkdir(screenshotDir, { recursive: true });
      const pngPath = join(screenshotDir, 'foo.png');
      await writeFile(pngPath, MINIMAL_PNG);

      await seedTempHome(tmpHome, srv.port, key);

      const payload = JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: pngPath },
        cwd: tmpHome,
        started_at: new Date().toISOString(),
      });

      const { exitCode, stdout } = await spawnHook(payload, tmpHome);

      expect(exitCode).toBe(0);
      expect(stdout.trim()).not.toBe('');

      const parsed = JSON.parse(stdout.trim()) as {
        hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
      };
      expect(parsed.hookSpecificOutput?.hookEventName).toBe('PostToolUse');
      expect(parsed.hookSpecificOutput?.additionalContext).toContain('/f/');
    } finally {
      await rm(tmpHome, { recursive: true, force: true });
    }
  }, 15_000);
});

describe('hook integration: no PID file → child exits 0, stdout empty', () => {
  it('exits 0 with empty stdout when no PID file exists', async () => {
    // Use a fresh temp home with no PID file seeded
    const tmpHome = await mkdtemp(join(tmpdir(), 'shotlink-nopid-'));
    try {
      const payload = JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: join(tmpHome, 'test-results', 'foo.png') },
        cwd: tmpHome,
        started_at: new Date().toISOString(),
      });

      const { exitCode, stdout } = await spawnHook(payload, tmpHome);

      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe('');
    } finally {
      await rm(tmpHome, { recursive: true, force: true });
    }
  }, 10_000);
});
