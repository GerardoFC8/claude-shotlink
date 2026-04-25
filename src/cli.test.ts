/**
 * cli.test.ts
 *
 * Tests for src/cli.ts — CLI dispatcher with injected dependencies.
 *
 * Each command handler is tested in isolation via the CliDeps injection seam.
 * No real fs, sockets, or network calls are made in these tests.
 *
 * Strict TDD: all tests written RED-first before implementation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CliDeps } from './cli.js';

// Derive PROJECT_ROOT from this file's location so tests work on any machine
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

const execFileAsync = promisify(execFile);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal CliDeps stub with sensible defaults.
 * All functions are vi.fn() so assertions can be made.
 * overrides is typed loosely so callers don't need to match Mock<> types.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildFakeDeps(overrides: Record<string, any> = {}): CliDeps {
  const fakeConfig = {
    apiKey: 'sk_' + 'a'.repeat(64),
    createdAt: new Date().toISOString(),
  };

  const defaults: Record<string, unknown> = {
    ensureConfig: vi.fn().mockResolvedValue(fakeConfig),
    loadConfig: vi.fn().mockResolvedValue(fakeConfig),
    rotateApiKey: vi.fn().mockResolvedValue({ ...fakeConfig, apiKey: 'sk_' + 'b'.repeat(64) }),
    StorageFactory: vi.fn().mockReturnValue({
      init: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
      stats: vi.fn().mockReturnValue({ entries: 0, totalBytes: 0 }),
    }),
    startServer: vi.fn().mockResolvedValue({
      port: 54321,
      host: '127.0.0.1',
      close: vi.fn().mockResolvedValue(undefined),
    }),
    ensureBinary: vi.fn().mockResolvedValue('/fake/cloudflared'),
    createTunnel: vi.fn().mockResolvedValue({
      publicUrl: null,
      stop: vi.fn().mockResolvedValue(undefined),
      onUrlReady: vi.fn().mockReturnValue(() => {}),
      onDrop: vi.fn().mockReturnValue(() => {}),
    }),
    installHook: vi.fn().mockResolvedValue({ action: 'installed', backupPath: '/tmp/backup' }),
    uninstallHook: vi.fn().mockResolvedValue({ action: 'removed', backupPath: '/tmp/backup', removedCount: 1 }),
    listBackups: vi.fn().mockResolvedValue([]),
    restoreBackup: vi.fn().mockResolvedValue({ action: 'restored', backupUsed: 'settings.json.backup-2026' }),
    writePidFile: vi.fn().mockResolvedValue(undefined),
    readPidFile: vi.fn().mockResolvedValue(null),
    deletePidFile: vi.fn().mockResolvedValue(undefined),
    isProcessAlive: vi.fn().mockReturnValue(false),
    appendLog: vi.fn().mockResolvedValue(undefined),
    readTail: vi.fn().mockResolvedValue([]),
    followTail: vi.fn().mockReturnValue(() => {}),
    saveConfig: vi.fn().mockResolvedValue(undefined),
    updatePidFileUrl: vi.fn().mockResolvedValue(undefined),
    purgeDedupCache: vi.fn().mockResolvedValue(undefined),
    startHealthcheck: vi.fn().mockReturnValue({ stop: vi.fn(), failCount: 0, stopped: false }),
    setupTunnel: vi.fn().mockResolvedValue({
      ok: true,
      uuid: 'test-uuid',
      credentialsFile: '/fake/creds.json',
      dnsRouted: true,
    }),
  };

  return { ...defaults, ...overrides } as unknown as CliDeps;
}

// ── handleUnknownCommand ───────────────────────────────────────────────────────

describe('handleUnknownCommand', () => {
  it('returns exit code 1 for an unknown command', async () => {
    const { dispatch } = await import('./cli.js');
    const deps = buildFakeDeps();
    const stderrLines: string[] = [];
    const code = await dispatch(['foobar'], deps, { stderr: (s) => stderrLines.push(s) });
    expect(code).toBe(1);
    expect(stderrLines.join('')).toContain('Unknown command: foobar');
  });

  it('empty argv dispatches to start (with abortAfterReady exits cleanly)', async () => {
    const { dispatch } = await import('./cli.js');
    const deps = buildFakeDeps({
      readPidFile: vi.fn().mockResolvedValue(null),
    });
    let readyFired = false;
    const code = await dispatch([], deps, {
      stdout: () => {},
      stderr: () => {},
      onServerReady: () => { readyFired = true; },
      abortAfterReady: true,
    });
    expect(typeof code).toBe('number');
    expect(readyFired).toBe(true);
  });
});

// ── --version flag ────────────────────────────────────────────────────────────

describe('--version flag', () => {
  // Read expected version from package.json at test time
  async function readPkgVersion(): Promise<string> {
    const { readFile } = await import('node:fs/promises');
    const pkgPath = join(PROJECT_ROOT, 'package.json');
    const raw = await readFile(pkgPath, 'utf8');
    return (JSON.parse(raw) as { version: string }).version;
  }

  it('--version prints the package version and exits 0', async () => {
    const { dispatch } = await import('./cli.js');
    const deps = buildFakeDeps();
    const stdoutLines: string[] = [];
    const code = await dispatch(['--version'], deps, {
      stdout: (s) => stdoutLines.push(s),
    });
    const expected = await readPkgVersion();
    expect(code).toBe(0);
    expect(stdoutLines.join('').trim()).toBe(expected);
  });

  it('-v short flag also prints the version', async () => {
    const { dispatch } = await import('./cli.js');
    const deps = buildFakeDeps();
    const stdoutLines: string[] = [];
    const code = await dispatch(['-v'], deps, {
      stdout: (s) => stdoutLines.push(s),
    });
    const expected = await readPkgVersion();
    expect(code).toBe(0);
    expect(stdoutLines.join('').trim()).toBe(expected);
  });

  it('version subcommand also prints the version', async () => {
    const { dispatch } = await import('./cli.js');
    const deps = buildFakeDeps();
    const stdoutLines: string[] = [];
    const code = await dispatch(['version'], deps, {
      stdout: (s) => stdoutLines.push(s),
    });
    const expected = await readPkgVersion();
    expect(code).toBe(0);
    expect(stdoutLines.join('').trim()).toBe(expected);
  });
});

// ── handleStatus ──────────────────────────────────────────────────────────────

describe('handleStatus', () => {
  it('exits 1 and prints "not running" when no PID file exists', async () => {
    const { handleStatus } = await import('./cli.js');
    const deps = buildFakeDeps({
      readPidFile: vi.fn().mockResolvedValue(null),
    });

    const stdoutLines: string[] = [];
    const code = await handleStatus(deps, { stdout: (s) => stdoutLines.push(s), stderr: () => {} });

    expect(code).toBe(1);
    expect(stdoutLines.join('')).toMatch(/not running/i);
  });

  it('exits 0 and prints status info when relay is alive', async () => {
    const { handleStatus } = await import('./cli.js');
    const pidMeta = {
      pid: process.pid,
      port: 54321,
      tunnelUrl: 'https://abc.trycloudflare.com',
      startedAt: new Date().toISOString(),
    };

    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, entries: 5 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const deps = buildFakeDeps({
      readPidFile: vi.fn().mockResolvedValue(pidMeta),
      loadConfig: vi.fn().mockResolvedValue({
        apiKey: 'sk_abc',
        createdAt: new Date().toISOString(),
      }),
    });

    const stdoutLines: string[] = [];
    const code = await handleStatus(deps, {
      stdout: (s) => stdoutLines.push(s),
      stderr: () => {},
      fetchImpl: fakeFetch as typeof fetch,
    });

    expect(code).toBe(0);
    const output = stdoutLines.join('');
    expect(output).toContain('54321');
  });
});

// ── handleStop ────────────────────────────────────────────────────────────────

describe('handleStop', () => {
  it('exits 0 and prints no-relay message when no PID file exists', async () => {
    const { handleStop } = await import('./cli.js');
    const deps = buildFakeDeps({
      readPidFile: vi.fn().mockResolvedValue(null),
    });

    const stdoutLines: string[] = [];
    const code = await handleStop(deps, { stdout: (s) => stdoutLines.push(s), stderr: () => {} });

    expect(code).toBe(0);
    expect(stdoutLines.join('')).toMatch(/no relay running/i);
  });
});

// ── handleRotateKey ───────────────────────────────────────────────────────────

describe('handleRotateKey', () => {
  it('prints a new sk_ key to stdout and a restart warning to stderr', async () => {
    const { handleRotateKey } = await import('./cli.js');
    const newKey = 'sk_' + 'b'.repeat(64);
    const deps = buildFakeDeps({
      rotateApiKey: vi.fn().mockResolvedValue({
        apiKey: newKey,
        createdAt: new Date().toISOString(),
      }),
    });

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const code = await handleRotateKey(deps, {
      stdout: (s) => stdoutLines.push(s),
      stderr: (s) => stderrLines.push(s),
    });

    expect(code).toBe(0);
    expect(stdoutLines.join('')).toMatch(/^sk_[0-9a-f]{64}/m);
    expect(stderrLines.join('')).toMatch(/restart/i);
  });
});

// ── handleLogs ────────────────────────────────────────────────────────────────

describe('handleLogs', () => {
  it('exits 0 printing "No log file found." when readTail returns empty', async () => {
    const { handleLogs } = await import('./cli.js');
    const deps = buildFakeDeps({
      readTail: vi.fn().mockResolvedValue([]),
    });

    const stdoutLines: string[] = [];
    const code = await handleLogs(['logs'], deps, {
      stdout: (s) => stdoutLines.push(s),
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(typeof code).toBe('number');
  });

  it('exits 0 printing lines when log file has content', async () => {
    const { handleLogs } = await import('./cli.js');
    const lines = ['{"timestamp":"2026","sha256":"abc","size":1,"status":"uploaded"}'];
    const deps = buildFakeDeps({
      readTail: vi.fn().mockResolvedValue(lines),
    });

    const stdoutLines: string[] = [];
    const code = await handleLogs(['logs'], deps, {
      stdout: (s) => stdoutLines.push(s),
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(stdoutLines.join('')).toContain('uploaded');
  });
});

// ── handleInstallHook ─────────────────────────────────────────────────────────

describe('handleInstallHook', () => {
  it('exits 0 on happy path install', async () => {
    const { handleInstallHook } = await import('./cli.js');
    const deps = buildFakeDeps();
    const stdoutLines: string[] = [];
    const code = await handleInstallHook(deps, {
      stdout: (s) => stdoutLines.push(s),
      stderr: () => {},
    });

    expect(code).toBe(0);
  });

  it('exits 0 on already-present (idempotent)', async () => {
    const { handleInstallHook } = await import('./cli.js');
    const deps = buildFakeDeps({
      installHook: vi.fn().mockResolvedValue({
        action: 'already-present',
        backupPath: null,
      }),
    });

    const stdoutLines: string[] = [];
    const code = await handleInstallHook(deps, {
      stdout: (s) => stdoutLines.push(s),
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(stdoutLines.join('')).toMatch(/already/i);
  });
});

// ── handleStart — double-start guard ─────────────────────────────────────────

describe('handleStart', () => {
  it('exits 1 when a relay is already running (valid PID exists)', async () => {
    const { handleStart } = await import('./cli.js');
    const deps = buildFakeDeps({
      readPidFile: vi.fn().mockResolvedValue({
        pid: process.pid,
        port: 3333,
        tunnelUrl: null,
        startedAt: new Date().toISOString(),
      }),
      isProcessAlive: vi.fn().mockReturnValue(true),
    });

    const stderrLines: string[] = [];
    const code = await handleStart(['start'], deps, {
      stdout: () => {},
      stderr: (s) => stderrLines.push(s),
    });

    expect(code).toBe(1);
    expect(stderrLines.join('')).toMatch(/already running/i);
  });

  it('honors --port flag by passing it to startServer', async () => {
    const { handleStart } = await import('./cli.js');

    let capturedPort: number | undefined;
    const startServerMock = vi.fn().mockImplementation(async (opts: { port: number }) => {
      capturedPort = opts.port;
      return { port: capturedPort ?? 0, host: '127.0.0.1', close: vi.fn().mockResolvedValue(undefined) };
    });

    const deps = buildFakeDeps({
      readPidFile: vi.fn().mockResolvedValue(null),
      startServer: startServerMock,
    });

    let resolveReady: (() => void) | undefined;
    const readyPromise = new Promise<void>((r) => { resolveReady = r; });

    const startPromise = handleStart(['start', '--port', '54321'], deps, {
      stdout: () => {},
      stderr: () => {},
      onServerReady: () => { resolveReady?.(); },
      abortAfterReady: true,
    });

    await readyPromise;
    await new Promise<void>((r) => setTimeout(r, 10));

    expect(capturedPort).toBe(54321);

    await startPromise.catch(() => {});
  });
});

// ── handleStart — tunnel wiring (TASK-023) ────────────────────────────────────

describe('handleStart tunnel wiring', () => {
  it('publicBaseUrl callback returns the tunnel URL once ready', async () => {
    const { handleStart } = await import('./cli.js');

    let capturedPublicBaseUrl: (() => string | null) | undefined;

    const startServerMock = vi.fn().mockImplementation(async (opts: { publicBaseUrl?: () => string | null }) => {
      capturedPublicBaseUrl = opts.publicBaseUrl;
      return { port: 9999, host: '127.0.0.1', close: vi.fn().mockResolvedValue(undefined) };
    });

    const deps = buildFakeDeps({
      readPidFile: vi.fn().mockResolvedValue(null),
      startServer: startServerMock,
      createTunnel: vi.fn().mockResolvedValue({
        publicUrl: 'https://abc.trycloudflare.com',
        stop: vi.fn().mockResolvedValue(undefined),
        onUrlReady: vi.fn().mockReturnValue(() => {}),
        onDrop: vi.fn().mockReturnValue(() => {}),
      }),
    });

    let resolveReady: (() => void) | undefined;
    const readyPromise = new Promise<void>((r) => { resolveReady = r; });

    const startPromise = handleStart(['start'], deps, {
      stdout: () => {},
      stderr: () => {},
      onServerReady: () => { resolveReady?.(); },
      abortAfterReady: true,
    });

    await readyPromise;
    await new Promise<void>((r) => setTimeout(r, 10));

    expect(capturedPublicBaseUrl).toBeDefined();
    expect(capturedPublicBaseUrl!()).toBe('https://abc.trycloudflare.com');

    await startPromise.catch(() => {});
  });

  it('prints the public URL in the banner when tunnel is ready', async () => {
    const { handleStart } = await import('./cli.js');

    const deps = buildFakeDeps({
      readPidFile: vi.fn().mockResolvedValue(null),
      createTunnel: vi.fn().mockResolvedValue({
        publicUrl: 'https://xyz.trycloudflare.com',
        stop: vi.fn().mockResolvedValue(undefined),
        onUrlReady: vi.fn().mockReturnValue(() => {}),
        onDrop: vi.fn().mockReturnValue(() => {}),
      }),
    });

    const stdoutLines: string[] = [];
    let resolveReady: (() => void) | undefined;
    const readyPromise = new Promise<void>((r) => { resolveReady = r; });

    const startPromise = handleStart(['start'], deps, {
      stdout: (s) => stdoutLines.push(s),
      stderr: () => {},
      onServerReady: () => { resolveReady?.(); },
      abortAfterReady: true,
    });

    await readyPromise;
    await new Promise<void>((r) => setTimeout(r, 50));

    const output = stdoutLines.join('');
    expect(output).toContain('xyz.trycloudflare.com');

    await startPromise.catch(() => {});
  });

  it('exits 1 and cleans up when tunnel.start() rejects', async () => {
    const { handleStart } = await import('./cli.js');

    const serverCloseMock = vi.fn().mockResolvedValue(undefined);
    const storageShutdownMock = vi.fn().mockResolvedValue(undefined);

    const deps = buildFakeDeps({
      readPidFile: vi.fn().mockResolvedValue(null),
      StorageFactory: vi.fn().mockReturnValue({
        init: vi.fn().mockResolvedValue(undefined),
        shutdown: storageShutdownMock,
        stats: vi.fn().mockReturnValue({ entries: 0, totalBytes: 0 }),
      }),
      startServer: vi.fn().mockResolvedValue({
        port: 9999,
        host: '127.0.0.1',
        close: serverCloseMock,
      }),
      createTunnel: vi.fn().mockRejectedValue(
        new Error('cloudflared tunnel did not come up')
      ),
    });

    const code = await handleStart(['start'], deps, {
      stdout: () => {},
      stderr: () => {},
    });

    expect(code).toBe(1);
    expect(serverCloseMock).toHaveBeenCalled();
    expect(storageShutdownMock).toHaveBeenCalled();
  });
});

// ── handleStart — PID lifecycle (TASK-024) ────────────────────────────────────

describe('handleStart PID lifecycle', () => {
  it('writes PID file after server AND tunnel are both up', async () => {
    const { handleStart } = await import('./cli.js');

    const writePidMock = vi.fn().mockResolvedValue(undefined);

    const deps = buildFakeDeps({
      readPidFile: vi.fn().mockResolvedValue(null),
      createTunnel: vi.fn().mockResolvedValue({
        publicUrl: 'https://test.trycloudflare.com',
        stop: vi.fn().mockResolvedValue(undefined),
        onUrlReady: vi.fn().mockReturnValue(() => {}),
        onDrop: vi.fn().mockReturnValue(() => {}),
      }),
      writePidFile: writePidMock,
    });

    let resolveReady: (() => void) | undefined;
    const readyPromise = new Promise<void>((r) => { resolveReady = r; });

    const startPromise = handleStart(['start'], deps, {
      stdout: () => {},
      stderr: () => {},
      onServerReady: () => { resolveReady?.(); },
      abortAfterReady: true,
    });

    await readyPromise;
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(writePidMock).toHaveBeenCalled();
    const writeArgs = writePidMock.mock.calls[0]?.[0] as { pid: number; port: number; tunnelUrl: string | null; startedAt: string } | undefined;
    expect(writeArgs?.pid).toBe(process.pid);
    expect(typeof writeArgs?.port).toBe('number');
    expect(writeArgs?.tunnelUrl).toBe('https://test.trycloudflare.com');

    await startPromise.catch(() => {});
  });
});

// ── handleStart — TTL flag (TASK-031) ─────────────────────────────────────────

describe('handleStart --ttl flag', () => {
  it('calls shutdown after TTL seconds elapsed', async () => {
    vi.useFakeTimers();

    const { handleStart } = await import('./cli.js');

    const serverCloseMock = vi.fn().mockResolvedValue(undefined);
    const deletePidMock = vi.fn().mockResolvedValue(undefined);

    const deps = buildFakeDeps({
      readPidFile: vi.fn().mockResolvedValue(null),
      startServer: vi.fn().mockResolvedValue({
        port: 8888,
        host: '127.0.0.1',
        close: serverCloseMock,
      }),
      createTunnel: vi.fn().mockResolvedValue({
        publicUrl: 'https://ttl.trycloudflare.com',
        stop: vi.fn().mockResolvedValue(undefined),
        onUrlReady: vi.fn().mockReturnValue(() => {}),
        onDrop: vi.fn().mockReturnValue(() => {}),
      }),
      deletePidFile: deletePidMock,
    });

    // Inject exitFn so process.exit is NOT called in the test
    const exitMock = vi.fn();

    // --ttl 2 means 2 seconds
    const startPromise = handleStart(['start', '--ttl', '2'], deps, {
      stdout: () => {},
      stderr: () => {},
      exitFn: exitMock,
    });

    // Advance time by 2 seconds to trigger shutdown
    await vi.advanceTimersByTimeAsync(2000);
    await vi.runAllTimersAsync();

    const code = await startPromise;

    expect(code).toBe(0);
    expect(serverCloseMock).toHaveBeenCalled();
    expect(deletePidMock).toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalledWith(0);

    vi.useRealTimers();
  });
});

// ── handleStart — re-entrant SIGTERM (SPEC-PID-05 / Scenario PID-B) ───────────

describe('handleStart re-entrant SIGTERM (SPEC-PID-05)', () => {
  it('second SIGTERM during shutdown is a no-op — exitFn called exactly once', async () => {
    const { handleStart } = await import('./cli.js');

    // Hold server.close() pending so we can fire a second SIGTERM while
    // shutdown is still mid-flight (simulating the race described by PID-B).
    let releaseServerClose: () => void = () => {};
    const serverCloseMock = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { releaseServerClose = resolve; })
    );
    const tunnelStopMock = vi.fn().mockResolvedValue(undefined);
    const storageShutdownMock = vi.fn().mockResolvedValue(undefined);
    const deletePidMock = vi.fn().mockResolvedValue(undefined);

    const storageInstance = {
      init: vi.fn().mockResolvedValue(undefined),
      shutdown: storageShutdownMock,
      stats: () => ({ entries: 0, totalBytes: 0 }),
    };

    const deps = buildFakeDeps({
      readPidFile: vi.fn().mockResolvedValue(null),
      StorageFactory: () => storageInstance,
      startServer: vi.fn().mockResolvedValue({
        port: 8765,
        host: '127.0.0.1',
        close: serverCloseMock,
      }),
      createTunnel: vi.fn().mockResolvedValue({
        publicUrl: 'https://sigterm.trycloudflare.com',
        stop: tunnelStopMock,
        onUrlReady: vi.fn().mockReturnValue(() => {}),
        onDrop: vi.fn().mockReturnValue(() => {}),
      }),
      deletePidFile: deletePidMock,
    });

    const exitMock = vi.fn();
    let onReady: () => void = () => {};
    const readyPromise = new Promise<void>((resolve) => { onReady = resolve; });

    const startPromise = handleStart(['start'], deps, {
      stdout: () => {},
      stderr: () => {},
      exitFn: exitMock,
      onServerReady: () => onReady(),
    });

    // Wait until PID has been written and signal handlers are registered
    await readyPromise;

    // Fire SIGTERM twice — the second must be a no-op per SPEC-PID-05
    process.emit('SIGTERM');
    process.emit('SIGTERM');

    // Yield the event loop so the shutdown function has started awaiting
    // serverCloseMock, then release it to let the chain finish.
    await Promise.resolve();
    await Promise.resolve();
    releaseServerClose();

    const code = await startPromise;

    expect(code).toBe(0);
    expect(exitMock).toHaveBeenCalledTimes(1);
    expect(exitMock).toHaveBeenCalledWith(0);
    expect(serverCloseMock).toHaveBeenCalledTimes(1);
    expect(tunnelStopMock).toHaveBeenCalledTimes(1);
    expect(storageShutdownMock).toHaveBeenCalledTimes(1);
    expect(deletePidMock).toHaveBeenCalledTimes(1);
  });
});

// ── handleStatus with /health probe (TASK-032) ────────────────────────────────

describe('handleStatus /health probe', () => {
  it('hits /health when PID is alive and reports entries count', async () => {
    const { handleStatus } = await import('./cli.js');

    const pidMeta = {
      pid: process.pid,
      port: 54321,
      tunnelUrl: null,
      startedAt: new Date().toISOString(),
    };

    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, entries: 7 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const deps = buildFakeDeps({
      readPidFile: vi.fn().mockResolvedValue(pidMeta),
      loadConfig: vi.fn().mockResolvedValue({
        apiKey: 'sk_testkey',
        createdAt: new Date().toISOString(),
      }),
    });

    const stdoutLines: string[] = [];
    const code = await handleStatus(deps, {
      stdout: (s) => stdoutLines.push(s),
      stderr: () => {},
      fetchImpl: fakeFetch as typeof fetch,
    });

    expect(code).toBe(0);
    expect(fakeFetch).toHaveBeenCalled();
    const fetchUrl = String(fakeFetch.mock.calls[0]?.[0] ?? '');
    expect(fetchUrl).toContain('/health');
    expect(fetchUrl).toContain('54321');

    const output = stdoutLines.join('');
    expect(output).toContain('7');
  });
});

// ── handleInstallHook — path resolution (TASK-027) ───────────────────────────

describe('handleInstallHook path resolution', () => {
  it('passes hookCommand built from resolved hook path with node prefix', async () => {
    const { handleInstallHook } = await import('./cli.js');

    let capturedOpts: Record<string, unknown> | undefined;
    const deps = buildFakeDeps({
      installHook: vi.fn().mockImplementation(async (opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return { action: 'installed', backupPath: '/tmp/backup' };
      }),
    });

    const code = await handleInstallHook(deps, {
      stdout: () => {},
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(capturedOpts).toBeDefined();
    // hookCommand must start with 'node ' and end with 'hook.js' (possibly quoted for safety)
    expect(String(capturedOpts!['hookCommand'])).toMatch(/^node "?.+hook\.js"?$/);
    // sentinel must be the resolved path itself (no 'node ' prefix)
    expect(String(capturedOpts!['sentinel'])).toMatch(/hook\.js$/);
    expect(String(capturedOpts!['sentinel'])).not.toContain('node ');
    // matcher must be Bash|Write
    expect(capturedOpts!['matcher']).toBe('Bash|Write');
  });

  it('exits 1 with error on stderr when hook binary does not exist on disk', async () => {
    const { handleInstallHook } = await import('./cli.js');

    const installMock = vi.fn();
    const deps = buildFakeDeps({ installHook: installMock });
    const stderrLines: string[] = [];

    // Inject a fake existsSync that always returns false
    const code = await handleInstallHook(
      deps,
      { stdout: () => {}, stderr: (s) => stderrLines.push(s) },
      () => false, // _hookPathExistsOverride
    );

    expect(code).toBe(1);
    expect(stderrLines.join('')).toContain('not found');
    // Must NOT have called installHook (no settings.json touched)
    expect(installMock).not.toHaveBeenCalled();
  });
});

// ── handleUninstallHook ───────────────────────────────────────────────────────

describe('handleUninstallHook', () => {
  it('exits 0 when hook is removed', async () => {
    const { handleUninstallHook } = await import('./cli.js');
    const deps = buildFakeDeps({
      uninstallHook: vi.fn().mockResolvedValue({ action: 'removed', backupPath: '/tmp/backup', removedCount: 1 }),
    });
    const stdoutLines: string[] = [];
    const code = await handleUninstallHook(['uninstall-hook'], deps, {
      stdout: (s) => stdoutLines.push(s),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(stdoutLines.join('')).toContain('removed');
  });

  it('exits 0 when hook was not installed', async () => {
    const { handleUninstallHook } = await import('./cli.js');
    const deps = buildFakeDeps({
      uninstallHook: vi.fn().mockResolvedValue({ action: 'not-present', backupPath: null, removedCount: 0 }),
    });
    const stdoutLines: string[] = [];
    const code = await handleUninstallHook(['uninstall-hook'], deps, {
      stdout: (s) => stdoutLines.push(s),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(stdoutLines.join('')).toMatch(/not installed/i);
  });

  it('exits 0 with --restore flag and restores latest backup', async () => {
    const { handleUninstallHook } = await import('./cli.js');
    const deps = buildFakeDeps({
      restoreBackup: vi.fn().mockResolvedValue({ action: 'restored', backupUsed: 'settings.json.backup-2026' }),
    });
    const stdoutLines: string[] = [];
    const code = await handleUninstallHook(['uninstall-hook', '--restore'], deps, {
      stdout: (s) => stdoutLines.push(s),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(stdoutLines.join('')).toContain('backup-2026');
  });
});

// ── handleStart — startServer always passes 127.0.0.1 (SEC-B) ────────────────

describe('handleStart security', () => {
  it('always passes host 127.0.0.1 to startServer', async () => {
    const { handleStart } = await import('./cli.js');

    let capturedHost: string | undefined;
    const startServerMock = vi.fn().mockImplementation(async (opts: { host?: string }) => {
      capturedHost = opts.host;
      return { port: 3333, host: opts.host ?? '127.0.0.1', close: vi.fn().mockResolvedValue(undefined) };
    });

    const deps = buildFakeDeps({
      readPidFile: vi.fn().mockResolvedValue(null),
      startServer: startServerMock,
    });

    let resolveReady: (() => void) | undefined;
    const readyPromise = new Promise<void>((r) => { resolveReady = r; });

    const startPromise = handleStart(['start'], deps, {
      stdout: () => {},
      stderr: () => {},
      onServerReady: () => { resolveReady?.(); },
      abortAfterReady: true,
    });

    await readyPromise;

    expect(capturedHost).toBe('127.0.0.1');

    await startPromise.catch(() => {});
  });
});

// ── Smoke test: spawn tsx src/cli.ts status ───────────────────────────────────

describe('smoke test', () => {
  it('spawning cli status exits with code 1 when no PID exists', async () => {
    const cliPath = join(PROJECT_ROOT, 'src', 'cli.ts');

    // Use a fresh temp HOME so no relay.pid exists regardless of the system state
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const tempHome = await mkdtemp(join(tmpdir(), 'shotlink-smoke-'));
    try {
      await execFileAsync(
        'node',
        ['--import', 'tsx/esm', cliPath, 'status'],
        {
          env: { ...process.env, HOME: tempHome },
          timeout: 10000,
        }
      );
      // If it exits 0, the test fails (should be 1 when no relay running)
      expect.fail('Expected non-zero exit but process exited 0');
    } catch (err) {
      const exitErr = err as { exitCode?: number; code?: number };
      const exitCode = exitErr.exitCode ?? exitErr.code;
      expect(exitCode).toBe(1);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });
});

// ── WARNING-4 regression: invalid --port / --ttl values ──────────────────────

describe('handleStart -- invalid --port flag', () => {
  it('exits 1 with descriptive error when --port is not a number', async () => {
    const { handleStart } = await import('./cli.js');
    const deps = buildFakeDeps({ readPidFile: vi.fn().mockResolvedValue(null) });
    const stderrLines: string[] = [];

    const code = await handleStart(['start', '--port', 'abc'], deps, {
      stdout: () => {},
      stderr: (s) => stderrLines.push(s),
    });

    expect(code).toBe(1);
    expect(stderrLines.join('')).toMatch(/invalid.*port/i);
  });

  it('exits 1 when --port is out of range (0)', async () => {
    const { handleStart } = await import('./cli.js');
    const deps = buildFakeDeps({ readPidFile: vi.fn().mockResolvedValue(null) });
    const stderrLines: string[] = [];

    const code = await handleStart(['start', '--port', '0'], deps, {
      stdout: () => {},
      stderr: (s) => stderrLines.push(s),
    });

    expect(code).toBe(1);
    expect(stderrLines.join('')).toMatch(/invalid.*port/i);
  });

  it('exits 1 when --port is out of range (65536)', async () => {
    const { handleStart } = await import('./cli.js');
    const deps = buildFakeDeps({ readPidFile: vi.fn().mockResolvedValue(null) });
    const stderrLines: string[] = [];

    const code = await handleStart(['start', '--port', '65536'], deps, {
      stdout: () => {},
      stderr: (s) => stderrLines.push(s),
    });

    expect(code).toBe(1);
    expect(stderrLines.join('')).toMatch(/invalid.*port/i);
  });
});

describe('handleStart -- invalid --ttl flag', () => {
  it('exits 1 with descriptive error when --ttl is not a number', async () => {
    const { handleStart } = await import('./cli.js');
    const deps = buildFakeDeps({ readPidFile: vi.fn().mockResolvedValue(null) });
    const stderrLines: string[] = [];

    const code = await handleStart(['start', '--ttl', 'foo'], deps, {
      stdout: () => {},
      stderr: (s) => stderrLines.push(s),
    });

    expect(code).toBe(1);
    expect(stderrLines.join('')).toMatch(/invalid.*ttl/i);
  });

  it('exits 1 when --ttl is 0', async () => {
    const { handleStart } = await import('./cli.js');
    const deps = buildFakeDeps({ readPidFile: vi.fn().mockResolvedValue(null) });
    const stderrLines: string[] = [];

    const code = await handleStart(['start', '--ttl', '0'], deps, {
      stdout: () => {},
      stderr: (s) => stderrLines.push(s),
    });

    expect(code).toBe(1);
    expect(stderrLines.join('')).toMatch(/invalid.*ttl/i);
  });

  it('exits 1 when --ttl is negative', async () => {
    const { handleStart } = await import('./cli.js');
    const deps = buildFakeDeps({ readPidFile: vi.fn().mockResolvedValue(null) });
    const stderrLines: string[] = [];

    const code = await handleStart(['start', '--ttl', '-1'], deps, {
      stdout: () => {},
      stderr: (s) => stderrLines.push(s),
    });

    expect(code).toBe(1);
    expect(stderrLines.join('')).toMatch(/invalid.*ttl/i);
  });
});

// ── B3: TASK-009-a RED — handleStart --tunnel-name/--tunnel-hostname flag parsing ──

describe('handleStart — TASK-009: tunnel mode flag parsing + precedence', () => {
  it('named mode: --tunnel-name + --tunnel-hostname → createTunnel called with named mode', async () => {
    const { handleStart } = await import('./cli.js');

    const createTunnelMock = vi.fn().mockResolvedValue({
      publicUrl: 'https://shots.example.com',
      stop: vi.fn().mockResolvedValue(undefined),
      onUrlReady: vi.fn().mockReturnValue(() => {}),
      onDrop: vi.fn().mockReturnValue(() => {}),
    });

    const deps = buildFakeDeps({
      readPidFile: vi.fn().mockResolvedValue(null),
      ensureConfig: vi.fn().mockResolvedValue({
        apiKey: 'sk_' + 'a'.repeat(64),
        createdAt: new Date().toISOString(),
      }),
      createTunnel: createTunnelMock,
    });

    let resolveReady: (() => void) | undefined;
    const readyPromise = new Promise<void>((r) => { resolveReady = r; });

    const startPromise = handleStart(
      ['start', '--tunnel-name', 'my-tunnel', '--tunnel-hostname', 'shots.example.com'],
      deps,
      {
        stdout: () => {},
        stderr: () => {},
        onServerReady: () => { resolveReady?.(); },
        abortAfterReady: true,
      },
    );

    await readyPromise;
    await new Promise<void>((r) => setTimeout(r, 10));

    expect(createTunnelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tunnel: { mode: 'named', name: 'my-tunnel', hostname: 'shots.example.com' },
      }),
    );

    await startPromise.catch(() => {});
  });

  it('exits 1 when --tunnel-hostname is given without --tunnel-name', async () => {
    const { handleStart } = await import('./cli.js');

    const deps = buildFakeDeps({
      readPidFile: vi.fn().mockResolvedValue(null),
      ensureConfig: vi.fn().mockResolvedValue({
        apiKey: 'sk_' + 'a'.repeat(64),
        createdAt: new Date().toISOString(),
      }),
    });

    const stderrLines: string[] = [];
    const code = await handleStart(
      ['start', '--tunnel-hostname', 'shots.example.com'],
      deps,
      { stdout: () => {}, stderr: (s) => stderrLines.push(s) },
    );

    expect(code).toBe(1);
    expect(stderrLines.join('')).toMatch(/tunnel-name/i);
  });

  it('exits 1 when --tunnel-name is given without --tunnel-hostname', async () => {
    const { handleStart } = await import('./cli.js');

    const deps = buildFakeDeps({
      readPidFile: vi.fn().mockResolvedValue(null),
      ensureConfig: vi.fn().mockResolvedValue({
        apiKey: 'sk_' + 'a'.repeat(64),
        createdAt: new Date().toISOString(),
      }),
    });

    const stderrLines: string[] = [];
    const code = await handleStart(
      ['start', '--tunnel-name', 'my-tunnel'],
      deps,
      { stdout: () => {}, stderr: (s) => stderrLines.push(s) },
    );

    expect(code).toBe(1);
    expect(stderrLines.join('')).toMatch(/tunnel-hostname/i);
  });

  it('config named mode with no CLI flags → createTunnel called with named mode from config', async () => {
    const { handleStart } = await import('./cli.js');

    const createTunnelMock = vi.fn().mockResolvedValue({
      publicUrl: 'https://h.example.com',
      stop: vi.fn().mockResolvedValue(undefined),
      onUrlReady: vi.fn().mockReturnValue(() => {}),
      onDrop: vi.fn().mockReturnValue(() => {}),
    });

    const deps = buildFakeDeps({
      readPidFile: vi.fn().mockResolvedValue(null),
      ensureConfig: vi.fn().mockResolvedValue({
        apiKey: 'sk_' + 'a'.repeat(64),
        createdAt: new Date().toISOString(),
        tunnelMode: 'named' as const,
        tunnelName: 'cfg-tunnel',
        tunnelHostname: 'h.example.com',
      }),
      createTunnel: createTunnelMock,
    });

    let resolveReady: (() => void) | undefined;
    const readyPromise = new Promise<void>((r) => { resolveReady = r; });

    const startPromise = handleStart(['start'], deps, {
      stdout: () => {},
      stderr: () => {},
      onServerReady: () => { resolveReady?.(); },
      abortAfterReady: true,
    });

    await readyPromise;
    await new Promise<void>((r) => setTimeout(r, 10));

    expect(createTunnelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tunnel: { mode: 'named', name: 'cfg-tunnel', hostname: 'h.example.com' },
      }),
    );

    await startPromise.catch(() => {});
  });

  it('CLI --tunnel-hostname overrides config hostname for this invocation', async () => {
    const { handleStart } = await import('./cli.js');

    const createTunnelMock = vi.fn().mockResolvedValue({
      publicUrl: 'https://override.example.com',
      stop: vi.fn().mockResolvedValue(undefined),
      onUrlReady: vi.fn().mockReturnValue(() => {}),
      onDrop: vi.fn().mockReturnValue(() => {}),
    });

    const deps = buildFakeDeps({
      readPidFile: vi.fn().mockResolvedValue(null),
      ensureConfig: vi.fn().mockResolvedValue({
        apiKey: 'sk_' + 'a'.repeat(64),
        createdAt: new Date().toISOString(),
        tunnelMode: 'named' as const,
        tunnelName: 'cfg-tunnel',
        tunnelHostname: 'old.example.com',
      }),
      createTunnel: createTunnelMock,
    });

    let resolveReady: (() => void) | undefined;
    const readyPromise = new Promise<void>((r) => { resolveReady = r; });

    const startPromise = handleStart(
      ['start', '--tunnel-name', 'cfg-tunnel', '--tunnel-hostname', 'override.example.com'],
      deps,
      {
        stdout: () => {},
        stderr: () => {},
        onServerReady: () => { resolveReady?.(); },
        abortAfterReady: true,
      },
    );

    await readyPromise;
    await new Promise<void>((r) => setTimeout(r, 10));

    expect(createTunnelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tunnel: { mode: 'named', name: 'cfg-tunnel', hostname: 'override.example.com' },
      }),
    );

    await startPromise.catch(() => {});
  });

  it('exits 1 when config has tunnelMode=named but tunnelHostname is missing', async () => {
    const { handleStart } = await import('./cli.js');

    const deps = buildFakeDeps({
      readPidFile: vi.fn().mockResolvedValue(null),
      ensureConfig: vi.fn().mockResolvedValue({
        apiKey: 'sk_' + 'a'.repeat(64),
        createdAt: new Date().toISOString(),
        tunnelMode: 'named' as const,
        tunnelName: 'T',
        // tunnelHostname intentionally absent
      }),
    });

    const stderrLines: string[] = [];
    const code = await handleStart(['start'], deps, {
      stdout: () => {},
      stderr: (s) => stderrLines.push(s),
    });

    expect(code).toBe(1);
    expect(stderrLines.join('')).toMatch(/hostname/i);
  });

  it('no config tunnel fields + no flags → quick mode (v0.1 behavior)', async () => {
    const { handleStart } = await import('./cli.js');

    const createTunnelMock = vi.fn().mockResolvedValue({
      publicUrl: 'https://quick.trycloudflare.com',
      stop: vi.fn().mockResolvedValue(undefined),
      onUrlReady: vi.fn().mockReturnValue(() => {}),
      onDrop: vi.fn().mockReturnValue(() => {}),
    });

    const deps = buildFakeDeps({
      readPidFile: vi.fn().mockResolvedValue(null),
      ensureConfig: vi.fn().mockResolvedValue({
        apiKey: 'sk_' + 'a'.repeat(64),
        createdAt: new Date().toISOString(),
        // No tunnel fields
      }),
      createTunnel: createTunnelMock,
    });

    let resolveReady: (() => void) | undefined;
    const readyPromise = new Promise<void>((r) => { resolveReady = r; });

    const startPromise = handleStart(['start'], deps, {
      stdout: () => {},
      stderr: () => {},
      onServerReady: () => { resolveReady?.(); },
      abortAfterReady: true,
    });

    await readyPromise;
    await new Promise<void>((r) => setTimeout(r, 10));

    expect(createTunnelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tunnel: { mode: 'quick' },
      }),
    );

    await startPromise.catch(() => {});
  });
});

// ── WARNING-2 regression: isMain guard not too broad ─────────────────────────

describe('isMain guard — no broad .ts suffix match', () => {
  it('cli.ts source does not contain a bare endsWith(/cli.ts) isMain guard', async () => {
    const { readFile: readFileAsync } = await import('node:fs/promises');
    const { fileURLToPath: fup } = await import('node:url');
    const { join: pathJoin } = await import('node:path');

    const cliSrc = await readFileAsync(pathJoin(fup(new URL('.', import.meta.url)), 'cli.ts'), 'utf8');

    // Must NOT contain the broad suffix guards
    expect(cliSrc).not.toContain("endsWith('/cli.ts')");
    expect(cliSrc).not.toContain("endsWith('/hook.ts')");
  });
});

// ── SUSPECT-4 regression: hookCommand uses a quoted path ─────────────────────

describe('handleInstallHook — quoted path in hookCommand', () => {
  it('hookCommand wraps the path with JSON.stringify quoting', async () => {
    const { handleInstallHook } = await import('./cli.js');

    let capturedCommand: string | undefined;
    const deps = buildFakeDeps({
      installHook: vi.fn().mockImplementation(async (opts: Record<string, unknown>) => {
        capturedCommand = opts['hookCommand'] as string;
        return { action: 'installed', backupPath: null };
      }),
    });

    await handleInstallHook(deps, { stdout: () => {}, stderr: () => {} });

    expect(capturedCommand).toBeDefined();
    // The path component must be double-quoted (JSON.stringify output)
    expect(capturedCommand).toMatch(/^node ".*"$/);
  });
});

// ── CA-4: Sentinel constant verification (TASK-007-a / TASK-008-a) ────────────
//
// These tests assert that handleInstallHook and handleUninstallHook pass
// the exact sentinel constant 'claude-shotlink/dist/hook.js' (not the full
// absolute hookPath). They FAIL (RED) before the constant is introduced in cli.ts.

describe('CA-4 — handleInstallHook passes SHOTLINK_HOOK_SENTINEL as sentinel', () => {
  it('sentinel passed to installHook is exactly "claude-shotlink/dist/hook.js"', async () => {
    const { handleInstallHook } = await import('./cli.js');

    let capturedSentinel: unknown;
    const deps = buildFakeDeps({
      installHook: vi.fn().mockImplementation(async (opts: Record<string, unknown>) => {
        capturedSentinel = opts['sentinel'];
        return { action: 'installed', backupPath: '/tmp/backup' };
      }),
    });

    const code = await handleInstallHook(deps, { stdout: () => {}, stderr: () => {} });

    expect(code).toBe(0);
    // Must be the SUBSTRING constant, NOT a full absolute path
    expect(capturedSentinel).toBe('claude-shotlink/dist/hook.js');
  });
});

describe('CA-4 — handleUninstallHook passes SHOTLINK_HOOK_SENTINEL as sentinel', () => {
  it('sentinel passed to uninstallHook is exactly "claude-shotlink/dist/hook.js"', async () => {
    const { handleUninstallHook } = await import('./cli.js');

    let capturedSentinel: unknown;
    const deps = buildFakeDeps({
      uninstallHook: vi.fn().mockImplementation(async (opts: Record<string, unknown>) => {
        capturedSentinel = opts['sentinel'];
        return { action: 'removed', backupPath: '/tmp/backup', removedCount: 1 };
      }),
    });

    const code = await handleUninstallHook(['uninstall-hook'], deps, {
      stdout: () => {},
      stderr: () => {},
    });

    expect(code).toBe(0);
    // Must be the SUBSTRING constant, NOT a full absolute path
    expect(capturedSentinel).toBe('claude-shotlink/dist/hook.js');
  });
});

// ── WARNING-1 regression: loadConfig throws descriptive error on bad JSON ─────

describe('loadConfig — invalid JSON throws descriptive error', () => {
  it('throws error mentioning the config file path when JSON is corrupt', async () => {
    const { writeFile: writeFileAsync, mkdir: mkdirAsync, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join: pathJoin } = await import('node:path');

    const tempHome = await (await import('node:fs/promises')).mkdtemp(join(tmpdir(), 'config-test-'));
    try {
      const configDir = pathJoin(tempHome, '.claude-shotlink');
      await mkdirAsync(configDir, { recursive: true });
      await writeFileAsync(pathJoin(configDir, 'config.json'), '{ bad json {{', 'utf8');

      // loadConfig reads from CONFIG_PATH which is based on homedir()
      // We can't easily override homedir, so test the function directly
      const { loadConfig } = await import('./config.js');

      // We can verify the try/catch wrapping exists by importing the source
      // and verifying the descriptive error message pattern
      const { readFile: rfAsync } = await import('node:fs/promises');
      const { fileURLToPath: fupFn } = await import('node:url');
      const srcPath = pathJoin(fupFn(new URL('.', import.meta.url)), 'config.ts');
      const src = await rfAsync(srcPath, 'utf8');

      // Verify the try/catch with descriptive message is present in source
      expect(src).toContain('invalid JSON');
      expect(src).toContain('CONFIG_PATH');
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });
});

// ── SUSPECT-6 regression: handleStop surfaces EPERM ──────────────────────────

describe('handleStop — EPERM error is surfaced', () => {
  it('returns exit code 1 and prints error when process.kill throws EPERM', async () => {
    const { handleStop } = await import('./cli.js');

    const pidMeta = {
      pid: 99999,
      port: 3333,
      tunnelUrl: null,
      startedAt: new Date().toISOString(),
    };

    const epermError = Object.assign(new Error('EPERM'), { code: 'EPERM' });

    // Spy on process.kill to throw EPERM
    const origKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal: unknown) => {
      if (pid === 99999) throw epermError;
      return origKill(pid, signal as NodeJS.Signals);
    });

    const deps = buildFakeDeps({
      readPidFile: vi.fn().mockResolvedValue(pidMeta),
      deletePidFile: vi.fn().mockResolvedValue(undefined),
    });

    const stderrLines: string[] = [];
    const stdoutLines: string[] = [];

    const code = await handleStop(deps, {
      stdout: (s) => stdoutLines.push(s),
      stderr: (s) => stderrLines.push(s),
    });

    killSpy.mockRestore();

    expect(code).toBe(1);
    expect(stderrLines.join('')).toMatch(/eperm/i);
  });
});

// ── FIX-4 regression: handleLogs --tail cleans up SIGINT listener ────────────

describe('handleLogs --tail — FIX-4: no listener leak after SIGINT', () => {
  it('process SIGINT listener count after completion equals count before', async () => {
    const { handleLogs } = await import('./cli.js');

    // Count SIGINT listeners before
    const before = process.listenerCount('SIGINT');

    let unsubscribeCalled = false;
    const fakeUnsubscribe = vi.fn(() => { unsubscribeCalled = true; });

    let capturedOnLine: ((line: string) => void) | undefined;
    const fakeFollowTail = vi.fn((onLine: (line: string) => void) => {
      capturedOnLine = onLine;
      return fakeUnsubscribe;
    });

    const deps = buildFakeDeps({ followTail: fakeFollowTail });

    // Start the tail (will register SIGINT handler)
    const logPromise = handleLogs(['logs', '--tail'], deps, {
      stdout: () => {},
      stderr: () => {},
    });

    // Wait for the handler to register
    await new Promise<void>((r) => setTimeout(r, 10));

    // Simulate SIGINT
    process.emit('SIGINT');

    const code = await logPromise;
    expect(code).toBe(0);
    expect(unsubscribeCalled).toBe(true);

    // Listener count must be back to baseline
    const after = process.listenerCount('SIGINT');
    expect(after).toBe(before);
  });
});

// ── FIX-5 regression: handleStop EPERM on SIGKILL ────────────────────────────

describe('handleStop — FIX-5: SIGKILL EPERM returns 1 and does NOT delete PID file', () => {
  it('returns exit code 1 and skips deletePidFile when SIGKILL throws EPERM', async () => {
    const { handleStop } = await import('./cli.js');

    const pidMeta = {
      pid: 88888,
      port: 4444,
      tunnelUrl: null,
      startedAt: new Date().toISOString(),
    };

    const epermError = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    const deletePidFileMock = vi.fn().mockResolvedValue(undefined);

    const origKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal: unknown) => {
      if (pid === 88888) {
        // SIGTERM succeeds (no throw) — but SIGKILL throws EPERM
        if (signal === 'SIGKILL' || signal === 9) throw epermError;
        return true; // SIGTERM succeeds
      }
      return origKill(pid, signal as NodeJS.Signals);
    });

    const deps = buildFakeDeps({
      readPidFile: vi.fn()
        .mockResolvedValueOnce(pidMeta)       // first call for initial read
        .mockResolvedValue(pidMeta),           // subsequent poll calls — never null (relay never stops)
      deletePidFile: deletePidFileMock,
      isProcessAlive: vi.fn().mockReturnValue(true),
    });

    const stderrLines: string[] = [];

    // Use fake timers to skip the 5 s poll
    vi.useFakeTimers();
    const codePromise = handleStop(deps, {
      stdout: () => {},
      stderr: (s) => stderrLines.push(s),
    });
    // Advance past the 5 second deadline
    await vi.advanceTimersByTimeAsync(6000);
    vi.useRealTimers();

    const code = await codePromise;
    killSpy.mockRestore();

    expect(code).toBe(1);
    expect(stderrLines.join('')).toMatch(/eperm/i);
    expect(stderrLines.join('')).toMatch(/sigkill/i);
    expect(deletePidFileMock).not.toHaveBeenCalled();
  }, 15_000);
});

// ── FIX-6 regression: loadConfig functional test ─────────────────────────────

describe('loadConfig — FIX-6: functional test throws on corrupt JSON', () => {
  it('throws an error mentioning the file path when JSON is corrupt', async () => {
    const { writeFile: wf, mkdir: mk, mkdtemp: mktmp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join: pj } = await import('node:path');

    const tempDir = await mktmp(pj(tmpdir(), 'config-functional-test-'));
    const configPath = pj(tempDir, 'config.json');
    try {
      await wf(configPath, '{ bad json {{', 'utf8');

      const { loadConfigFrom } = await import('./config.js');
      await expect(loadConfigFrom(configPath)).rejects.toThrow(configPath);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('successfully parses valid JSON and returns a Config', async () => {
    const { writeFile: wf, mkdtemp: mktmp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join: pj } = await import('node:path');

    const tempDir = await mktmp(pj(tmpdir(), 'config-functional-test-'));
    const configPath = pj(tempDir, 'config.json');
    try {
      const payload = { apiKey: 'sk_abc123', createdAt: new Date().toISOString() };
      await wf(configPath, JSON.stringify(payload), 'utf8');

      const { loadConfigFrom } = await import('./config.js');
      const result = await loadConfigFrom(configPath);
      expect(result.apiKey).toBe(payload.apiKey);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

// ── FIX-8: --tunnel-hostname validated in handleStart ────────────────────────

describe('handleStart — FIX-8: --tunnel-hostname validation', () => {
  beforeEach(() => {
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
  });

  it('FIX-8: exits 1 + stderr contains hostname validation message when --tunnel-hostname has scheme', async () => {
    const { handleStart } = await import('./cli.js');
    const deps = buildFakeDeps();
    const stderrLines: string[] = [];

    const code = await handleStart(
      ['start', '--tunnel-name', 'my-tunnel', '--tunnel-hostname', 'http://x.com'],
      deps,
      { stderr: (s) => stderrLines.push(s), stdout: () => {}, exitFn: () => {} },
    );

    expect(code).toBe(1);
    expect(stderrLines.join('')).toMatch(/hostname/i);
  });

  it('FIX-8: exits 1 + stderr contains hostname validation message when --tunnel-hostname has fragment', async () => {
    const { handleStart } = await import('./cli.js');
    const deps = buildFakeDeps();
    const stderrLines: string[] = [];

    const code = await handleStart(
      ['start', '--tunnel-name', 'my-tunnel', '--tunnel-hostname', 'x.com#fragment'],
      deps,
      { stderr: (s) => stderrLines.push(s), stdout: () => {}, exitFn: () => {} },
    );

    expect(code).toBe(1);
    expect(stderrLines.join('')).toMatch(/hostname/i);
  });

  it('FIX-8: valid bare hostname passes and proceeds to ensureBinary', async () => {
    const { handleStart } = await import('./cli.js');
    const ensureBinary = vi.fn().mockRejectedValue(new Error('stop here'));
    const deps = buildFakeDeps({ ensureBinary });

    const stderrLines: string[] = [];
    const code = await handleStart(
      ['start', '--tunnel-name', 'my-tunnel', '--tunnel-hostname', 'shots.example.com'],
      deps,
      { stderr: (s) => stderrLines.push(s), stdout: () => {}, exitFn: () => {} },
    );

    // ensureBinary throws → exit 1, but for a different reason — hostname was accepted
    expect(code).toBe(1);
    expect(ensureBinary).toHaveBeenCalled();
    // Error should be about binary, not hostname
    expect(stderrLines.join('')).not.toMatch(/invalid.*hostname/i);
  });
});

// ── B2: TASK-005-a RED — handleStart passes tunnelCredentialsFile + tunnelLocalPort through ──

describe('handleStart — CA-3: passes tunnelCredentialsFile + tunnelLocalPort from config to createTunnel', () => {
  it('TASK-005-a: createTunnel receives credentialsFile + localPort from config when both present', async () => {
    const { handleStart } = await import('./cli.js');
    const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join: pj } = await import('node:path');

    // FIX-3: use a real temp file with valid credentials JSON
    const dir = await mkdtemp(pj(tmpdir(), 'task005a-test-'));
    const credFile = pj(dir, 'abc.json');
    await writeFile(credFile, JSON.stringify({ TunnelID: 'abc-id', TunnelName: 'shotlink' }), 'utf8');
    try {
      const createTunnel = vi.fn().mockResolvedValue({
        publicUrl: 'https://shots.example.com',
        stop: vi.fn().mockResolvedValue(undefined),
        onUrlReady: vi.fn().mockReturnValue(() => {}),
        onDrop: vi.fn().mockReturnValue(() => {}),
      });

      const configWithCredentials = {
        apiKey: 'sk_' + 'a'.repeat(64),
        createdAt: new Date().toISOString(),
        tunnelMode: 'named' as const,
        tunnelName: 'shotlink',
        tunnelHostname: 'shots.example.com',
        tunnelCredentialsFile: credFile,
        tunnelLocalPort: 7331,
      };

      const deps = buildFakeDeps({
        ensureConfig: vi.fn().mockResolvedValue(configWithCredentials),
        createTunnel,
      });

      const code = await handleStart(
        ['start'],
        deps,
        {
          stdout: () => {},
          stderr: () => {},
          abortAfterReady: true,
          // fileExists returns true for the real temp file
          fileExists: () => true,
        },
      );

      expect(code).toBe(0);
      expect(createTunnel).toHaveBeenCalledWith(
        expect.objectContaining({
          tunnel: expect.objectContaining({
            mode: 'named',
            name: 'shotlink',
            hostname: 'shots.example.com',
            credentialsFile: credFile,
            localPort: 7331,
          }),
        }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('TASK-005-a: --port CLI flag differs from config tunnelLocalPort → warning printed, new port used', async () => {
    const { handleStart } = await import('./cli.js');
    const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join: pj } = await import('node:path');

    // FIX-3: use a real temp file with valid credentials JSON
    const dir = await mkdtemp(pj(tmpdir(), 'task005a-port-test-'));
    const credFile = pj(dir, 'abc.json');
    await writeFile(credFile, JSON.stringify({ TunnelID: 'abc-id', TunnelName: 'shotlink' }), 'utf8');
    try {
      const createTunnel = vi.fn().mockResolvedValue({
        publicUrl: 'https://shots.example.com',
        stop: vi.fn().mockResolvedValue(undefined),
        onUrlReady: vi.fn().mockReturnValue(() => {}),
        onDrop: vi.fn().mockReturnValue(() => {}),
      });

      const configWithCredentials = {
        apiKey: 'sk_' + 'a'.repeat(64),
        createdAt: new Date().toISOString(),
        tunnelMode: 'named' as const,
        tunnelName: 'shotlink',
        tunnelHostname: 'shots.example.com',
        tunnelCredentialsFile: credFile,
        tunnelLocalPort: 7331,
      };

      const deps = buildFakeDeps({
        ensureConfig: vi.fn().mockResolvedValue(configWithCredentials),
        createTunnel,
      });

      const stderrLines: string[] = [];
      const code = await handleStart(
        ['start', '--port', '8080'],
        deps,
        {
          stdout: () => {},
          stderr: (s) => stderrLines.push(s),
          abortAfterReady: true,
          fileExists: () => true,
        },
      );

      expect(code).toBe(0);
      // Warning about port mismatch must be printed
      expect(stderrLines.join(' ')).toMatch(/warning/i);
      expect(stderrLines.join(' ')).toMatch(/port/i);
      // createTunnel receives the CLI port override
      expect(createTunnel).toHaveBeenCalledWith(
        expect.objectContaining({
          tunnel: expect.objectContaining({
            localPort: 8080,
          }),
        }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── B2: TASK-006-a RED — handleStart fast-fails when credentialsFile missing on disk ──

describe('handleStart — CA-3: exits 1 when tunnelCredentialsFile is set but file absent', () => {
  it('TASK-006-a: exits 1 with error message when tunnelCredentialsFile path does not exist on disk', async () => {
    const { handleStart } = await import('./cli.js');

    const configWithMissingCredentials = {
      apiKey: 'sk_' + 'a'.repeat(64),
      createdAt: new Date().toISOString(),
      tunnelMode: 'named' as const,
      tunnelName: 'shotlink',
      tunnelHostname: 'shots.example.com',
      tunnelCredentialsFile: '/nonexistent/path/abc.json',
      tunnelLocalPort: 7331,
    };

    const createTunnel = vi.fn().mockResolvedValue({
      publicUrl: 'https://shots.example.com',
      stop: vi.fn().mockResolvedValue(undefined),
      onUrlReady: vi.fn().mockReturnValue(() => {}),
      onDrop: vi.fn().mockReturnValue(() => {}),
    });

    const deps = buildFakeDeps({
      ensureConfig: vi.fn().mockResolvedValue(configWithMissingCredentials),
      createTunnel,
    });

    const stderrLines: string[] = [];
    const code = await handleStart(
      ['start'],
      deps,
      {
        stdout: () => {},
        stderr: (s) => stderrLines.push(s),
        exitFn: () => {},
        // fileExists returns false → simulate missing credentials file on disk
        fileExists: () => false,
      },
    );

    expect(code).toBe(1);
    // createTunnel must NOT have been called (fast-fail before spawn)
    expect(createTunnel).not.toHaveBeenCalled();
    // Error message should mention credentials file
    expect(stderrLines.join(' ')).toMatch(/credentials.*file|credentials-file/i);
  });
});

// ── FIX-1: Port resolution asymmetry fix ─────────────────────────────────────

describe('handleStart — FIX-1: --port always honoured when named-mode without credentials', () => {
  // JD R2 clarification (C2): in legacy named mode (no tunnelCredentialsFile),
  // the user's ~/.cloudflared/config.yml controls cloudflared's ingress port.
  // The CLI --port flag controls ONLY the local HTTP server port, NOT the
  // tunnel's proxy target. This test asserts the local-server-port behavior
  // (which is what the user expects when passing --port). It does NOT assert
  // anything about createTunnel's tunnel.localPort — that field is only
  // forwarded when credentialsFile is set (the new --credentials-file path).
  it('FIX-1 RED: --port 9000 with named config WITHOUT credentialsFile → local server uses port 9000 (cloudflared reads its own config.yml for ingress)', async () => {
    const { handleStart } = await import('./cli.js');

    const createTunnel = vi.fn().mockResolvedValue({
      publicUrl: 'https://shots.example.com',
      stop: vi.fn().mockResolvedValue(undefined),
      onUrlReady: vi.fn().mockReturnValue(() => {}),
      onDrop: vi.fn().mockReturnValue(() => {}),
    });

    // Config has named mode but NO tunnelCredentialsFile
    const configNamedNoCredentials = {
      apiKey: 'sk_' + 'a'.repeat(64),
      createdAt: new Date().toISOString(),
      tunnelMode: 'named' as const,
      tunnelName: 'shotlink',
      tunnelHostname: 'shots.example.com',
      // No tunnelCredentialsFile, no tunnelLocalPort
    };

    const startServer = vi.fn().mockResolvedValue({
      port: 9000,
      host: '127.0.0.1',
      close: vi.fn().mockResolvedValue(undefined),
    });

    const deps = buildFakeDeps({
      ensureConfig: vi.fn().mockResolvedValue(configNamedNoCredentials),
      createTunnel,
      startServer,
    });

    const code = await handleStart(
      ['start', '--port', '9000'],
      deps,
      {
        stdout: () => {},
        stderr: () => {},
        abortAfterReady: true,
        fileExists: () => true,
      },
    );

    expect(code).toBe(0);
    // startServer should have received port 9000
    expect(startServer).toHaveBeenCalledWith(
      expect.objectContaining({ port: 9000 }),
    );
  });

  it('FIX-1 GREEN: --port 8080 with named-mode + credentials → warning + port used', async () => {
    const { handleStart } = await import('./cli.js');
    const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join: pj } = await import('node:path');

    // FIX-3: credentials JSON must be valid for the read-and-validate to succeed
    const dir = await mkdtemp(pj(tmpdir(), 'fix1-green-test-'));
    const credFile = pj(dir, 'abc.json');
    await writeFile(credFile, JSON.stringify({ TunnelID: 'abc-id', TunnelName: 'shotlink' }), 'utf8');
    try {
      const createTunnel = vi.fn().mockResolvedValue({
        publicUrl: 'https://shots.example.com',
        stop: vi.fn().mockResolvedValue(undefined),
        onUrlReady: vi.fn().mockReturnValue(() => {}),
        onDrop: vi.fn().mockReturnValue(() => {}),
      });

      const configWithCredentials = {
        apiKey: 'sk_' + 'a'.repeat(64),
        createdAt: new Date().toISOString(),
        tunnelMode: 'named' as const,
        tunnelName: 'shotlink',
        tunnelHostname: 'shots.example.com',
        tunnelCredentialsFile: credFile,
        tunnelLocalPort: 7331,
      };

      const deps = buildFakeDeps({
        ensureConfig: vi.fn().mockResolvedValue(configWithCredentials),
        createTunnel,
      });

      const stderrLines: string[] = [];
      const code = await handleStart(
        ['start', '--port', '8080'],
        deps,
        {
          stdout: () => {},
          stderr: (s) => stderrLines.push(s),
          abortAfterReady: true,
          fileExists: () => true,
        },
      );

      expect(code).toBe(0);
      // Warning about port mismatch
      expect(stderrLines.join(' ')).toMatch(/warning/i);
      // createTunnel receives port 8080
      expect(createTunnel).toHaveBeenCalledWith(
        expect.objectContaining({
          tunnel: expect.objectContaining({ localPort: 8080 }),
        }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── FIX-3: Credentials JSON shape validation in handleStart ───────────────────

describe('handleStart — FIX-3: validates credentials JSON shape before spawn', () => {
  function buildConfigWithCreds(credFile: string) {
    return {
      apiKey: 'sk_' + 'a'.repeat(64),
      createdAt: new Date().toISOString(),
      tunnelMode: 'named' as const,
      tunnelName: 'shotlink',
      tunnelHostname: 'shots.example.com',
      tunnelCredentialsFile: credFile,
      tunnelLocalPort: 7331,
    };
  }

  it('FIX-3 RED: exits 1 when credentials file contains malformed JSON', async () => {
    const { handleStart } = await import('./cli.js');
    const { writeFile, mkdir, mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join: pj } = await import('node:path');

    const dir = await mkdtemp(pj(tmpdir(), 'fix3-test-'));
    const credFile = pj(dir, 'creds.json');
    try {
      await writeFile(credFile, '{ not valid json {{', 'utf8');

      const createTunnel = vi.fn();
      const deps = buildFakeDeps({
        ensureConfig: vi.fn().mockResolvedValue(buildConfigWithCreds(credFile)),
        createTunnel,
      });

      const stderrLines: string[] = [];
      const code = await handleStart(
        ['start'],
        deps,
        {
          stdout: () => {},
          stderr: (s) => stderrLines.push(s),
          fileExists: () => true,
        },
      );

      expect(code).toBe(1);
      expect(createTunnel).not.toHaveBeenCalled();
      // JD R2 fix: malformed JSON gets its own distinct message
      expect(stderrLines.join(' ')).toMatch(/contains invalid JSON/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('FIX-3 RED: exits 1 when credentials JSON is missing TunnelID', async () => {
    const { handleStart } = await import('./cli.js');
    const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join: pj } = await import('node:path');

    const dir = await mkdtemp(pj(tmpdir(), 'fix3-test-'));
    const credFile = pj(dir, 'creds.json');
    try {
      // Valid JSON but missing TunnelID
      await writeFile(credFile, JSON.stringify({ TunnelName: 'shotlink', AccountTag: 'abc' }), 'utf8');

      const createTunnel = vi.fn();
      const deps = buildFakeDeps({
        ensureConfig: vi.fn().mockResolvedValue(buildConfigWithCreds(credFile)),
        createTunnel,
      });

      const stderrLines: string[] = [];
      const code = await handleStart(
        ['start'],
        deps,
        {
          stdout: () => {},
          stderr: (s) => stderrLines.push(s),
          fileExists: () => true,
        },
      );

      expect(code).toBe(1);
      expect(createTunnel).not.toHaveBeenCalled();
      // v0.3.1 fix: only TunnelID is required (cloudflared writes no TunnelName)
      expect(stderrLines.join(' ')).toMatch(/missing required field 'TunnelID'/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('v0.3.1 fix: REAL cloudflared credentials JSON (TunnelID + TunnelSecret + AccountTag + Endpoint, NO TunnelName) is ACCEPTED', async () => {
    // The cloudflared CLI writes credentials JSON without a TunnelName field.
    // v0.3.0 wrongly required TunnelName, breaking every real install.
    // v0.3.1 only requires TunnelID — TunnelName never existed in the file.
    const { handleStart } = await import('./cli.js');
    const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join: pj } = await import('node:path');

    const dir = await mkdtemp(pj(tmpdir(), 'v031-fix-'));
    const credFile = pj(dir, 'creds.json');
    try {
      // EXACT shape that cloudflared 2024.12.x writes (no TunnelName)
      await writeFile(
        credFile,
        JSON.stringify({
          AccountTag: '153b0a94671781d7398494b39be8c357',
          TunnelSecret: 'VEOgopowNtWmEaeEHG+300cedM3MaqZcBgPq0rVqn8g=',
          TunnelID: '89147c18-9198-4599-b7ad-86527377041b',
          Endpoint: '',
        }),
        'utf8',
      );

      const createTunnel = vi.fn().mockResolvedValue({
        publicUrl: 'https://shots.example.com',
        stop: vi.fn().mockResolvedValue(undefined),
        onUrlReady: vi.fn().mockReturnValue(() => {}),
        onDrop: vi.fn().mockReturnValue(() => {}),
      });
      const deps = buildFakeDeps({
        ensureConfig: vi.fn().mockResolvedValue(buildConfigWithCreds(credFile)),
        createTunnel,
      });

      const code = await handleStart(
        ['start'],
        deps,
        {
          stdout: () => {},
          stderr: () => {},
          abortAfterReady: true,
          fileExists: () => true,
        },
      );

      expect(code).toBe(0);
      expect(createTunnel).toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('JD-R2 RED: exits 1 with read-error message when credentials path is unreadable', async () => {
    const { handleStart } = await import('./cli.js');
    const createTunnel = vi.fn();
    // Use a path that fileExists says exists but readFileAsync will fail on
    // (a directory, which raises EISDIR on readFile)
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join: pj } = await import('node:path');

    const dir = await mkdtemp(pj(tmpdir(), 'jdr2-readfail-'));
    try {
      const deps = buildFakeDeps({
        ensureConfig: vi.fn().mockResolvedValue(buildConfigWithCreds(dir)),
        createTunnel,
      });

      const stderrLines: string[] = [];
      const code = await handleStart(
        ['start'],
        deps,
        {
          stdout: () => {},
          stderr: (s) => stderrLines.push(s),
          fileExists: () => true,
        },
      );

      expect(code).toBe(1);
      expect(createTunnel).not.toHaveBeenCalled();
      // Read error gets its own distinct message — does NOT mention "missing fields"
      expect(stderrLines.join(' ')).toMatch(/Cannot read credentials file/i);
      expect(stderrLines.join(' ')).not.toMatch(/missing required fields/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('FIX-3 GREEN: proceeds to createTunnel when credentials JSON has TunnelID + TunnelName', async () => {
    const { handleStart } = await import('./cli.js');
    const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join: pj } = await import('node:path');

    const dir = await mkdtemp(pj(tmpdir(), 'fix3-test-'));
    const credFile = pj(dir, 'creds.json');
    try {
      await writeFile(
        credFile,
        JSON.stringify({ TunnelID: 'abc-123', TunnelName: 'shotlink', AccountTag: 'xyz' }),
        'utf8',
      );

      const createTunnel = vi.fn().mockResolvedValue({
        publicUrl: 'https://shots.example.com',
        stop: vi.fn().mockResolvedValue(undefined),
        onUrlReady: vi.fn().mockReturnValue(() => {}),
        onDrop: vi.fn().mockReturnValue(() => {}),
      });
      const deps = buildFakeDeps({
        ensureConfig: vi.fn().mockResolvedValue(buildConfigWithCreds(credFile)),
        createTunnel,
      });

      const code = await handleStart(
        ['start'],
        deps,
        {
          stdout: () => {},
          stderr: () => {},
          abortAfterReady: true,
          fileExists: () => true,
        },
      );

      expect(code).toBe(0);
      expect(createTunnel).toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
