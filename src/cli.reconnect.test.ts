/**
 * cli.reconnect.test.ts
 *
 * TASK-016-a + TASK-017-a: RED tests for reconnect orchestration and
 * SIGTERM/reconnect race state machine.
 *
 * Tests use injected CliDeps so no real fs, network, or process calls occur.
 * The onFail callback is extracted via the startHealthcheck dep seam.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CliDeps, TunnelHandle, Config } from './cli.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

type OnFailCapture = { cb: (() => void) | null };

/**
 * Build a minimal CliDeps stub. Captures the onFail callback from
 * the startHealthcheck dep so tests can trigger reconnect manually.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildFakeDeps(overrides: Record<string, any> = {}): {
  deps: CliDeps;
  onFailCapture: OnFailCapture;
} {
  const onFailCapture: OnFailCapture = { cb: null };

  const baseConfig: Config = {
    apiKey: 'sk_' + 'a'.repeat(64),
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  const makeTunnelHandle = (publicUrl: string | null = 'https://abc.trycloudflare.com'): TunnelHandle => ({
    publicUrl,
    stop: vi.fn().mockResolvedValue(undefined),
    onUrlReady: vi.fn().mockReturnValue(() => {}),
    onDrop: vi.fn().mockReturnValue(() => {}),
  });

  const defaults: Record<string, unknown> = {
    ensureConfig: vi.fn().mockResolvedValue(baseConfig),
    loadConfig: vi.fn().mockResolvedValue(baseConfig),
    rotateApiKey: vi.fn().mockResolvedValue(baseConfig),
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
    createTunnel: vi.fn().mockResolvedValue(makeTunnelHandle()),
    installHook: vi.fn().mockResolvedValue({ action: 'installed', backupPath: null }),
    uninstallHook: vi.fn().mockResolvedValue({ action: 'removed', backupPath: null, removedCount: 0 }),
    listBackups: vi.fn().mockResolvedValue([]),
    restoreBackup: vi.fn().mockResolvedValue({ action: 'restored', backupUsed: null }),
    writePidFile: vi.fn().mockResolvedValue(undefined),
    readPidFile: vi.fn().mockResolvedValue(null),
    deletePidFile: vi.fn().mockResolvedValue(undefined),
    isProcessAlive: vi.fn().mockReturnValue(false),
    appendLog: vi.fn().mockResolvedValue(undefined),
    readTail: vi.fn().mockResolvedValue([]),
    followTail: vi.fn().mockReturnValue(() => {}),
    saveConfig: vi.fn().mockResolvedValue(undefined),
    // v0.2 reconnect deps
    updatePidFileUrl: vi.fn().mockResolvedValue(undefined),
    purgeDedupCache: vi.fn().mockResolvedValue(undefined),
    // startHealthcheck seam — captures the onFail callback
    startHealthcheck: vi.fn().mockImplementation((opts: { onFail: () => void }) => {
      onFailCapture.cb = opts.onFail;
      return { stop: vi.fn() };
    }),
  };

  const merged = { ...defaults, ...overrides } as unknown as CliDeps;
  return { deps: merged, onFailCapture };
}

// ── TASK-016-a: Quick-mode reconnect sequence ─────────────────────────────────

describe('handleStart reconnect — TASK-016: quick-mode reconnect plumbing', () => {
  beforeEach(() => {
    // Remove any lingering signal handlers from previous tests
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
  });

  it('quick-mode onFail triggers a second createTunnel call', async () => {
    const { handleStart } = await import('./cli.js');

    const newTunnelHandle = {
      publicUrl: 'https://new.trycloudflare.com',
      stop: vi.fn().mockResolvedValue(undefined),
      onUrlReady: vi.fn().mockReturnValue(() => {}),
      onDrop: vi.fn().mockReturnValue(() => {}),
    };

    const { deps, onFailCapture } = buildFakeDeps({
      createTunnel: vi.fn()
        .mockResolvedValueOnce({
          publicUrl: 'https://old.trycloudflare.com',
          stop: vi.fn().mockResolvedValue(undefined),
          onUrlReady: vi.fn().mockReturnValue(() => {}),
          onDrop: vi.fn().mockReturnValue(() => {}),
        })
        .mockResolvedValueOnce(newTunnelHandle),
    });

    const stderr: string[] = [];

    const startPromise = handleStart(['start'], deps, {
      abortAfterReady: false,
      onServerReady: () => {
        // Trigger reconnect immediately after ready
        expect(onFailCapture.cb).not.toBeNull();
        onFailCapture.cb!();
      },
      stderr: (s) => stderr.push(s),
      stdout: () => {},
      exitFn: () => {},
    });

    // Give async reconnect time to complete
    await new Promise((r) => setTimeout(r, 50));

    // createTunnel should have been called twice (initial + reconnect)
    expect((deps.createTunnel as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(deps.updatePidFileUrl).toHaveBeenCalledWith('https://new.trycloudflare.com');
    expect(deps.purgeDedupCache).toHaveBeenCalled();

    // Clean up
    process.emit('SIGTERM');
    await startPromise;
  });

  it('quick-mode reconnect failure keeps state=running (no crash)', async () => {
    const { handleStart } = await import('./cli.js');

    const { deps, onFailCapture } = buildFakeDeps({
      createTunnel: vi.fn()
        .mockResolvedValueOnce({
          publicUrl: 'https://old.trycloudflare.com',
          stop: vi.fn().mockResolvedValue(undefined),
          onUrlReady: vi.fn().mockReturnValue(() => {}),
          onDrop: vi.fn().mockReturnValue(() => {}),
        })
        .mockRejectedValueOnce(new Error('cloudflared spawn failed')),
    });

    const stderr: string[] = [];
    let crashed = false;

    const startPromise = handleStart(['start'], deps, {
      abortAfterReady: false,
      onServerReady: () => {
        expect(onFailCapture.cb).not.toBeNull();
        onFailCapture.cb!();
      },
      stderr: (s) => stderr.push(s),
      stdout: () => {},
      exitFn: (code) => { if (code !== 0) crashed = true; },
    });

    // Give async reconnect time to process
    await new Promise((r) => setTimeout(r, 50));

    // Should NOT have crashed
    expect(crashed).toBe(false);
    // Error should be logged to stderr
    expect(stderr.some((s) => s.includes('Reconnect failed') || s.includes('reconnect'))).toBe(true);

    process.emit('SIGTERM');
    await startPromise;
  });

  it('named-mode onFail does NOT call createTunnel again (warn-only)', async () => {
    const { handleStart } = await import('./cli.js');

    const namedConfig: Config = {
      apiKey: 'sk_' + 'a'.repeat(64),
      createdAt: '2026-01-01T00:00:00.000Z',
      tunnelMode: 'named',
      tunnelName: 'my-tunnel',
      tunnelHostname: 'shots.example.com',
    };

    const createTunnel = vi.fn().mockResolvedValue({
      publicUrl: 'https://shots.example.com',
      stop: vi.fn().mockResolvedValue(undefined),
      onUrlReady: vi.fn().mockReturnValue(() => {}),
      onDrop: vi.fn().mockReturnValue(() => {}),
    });

    const { deps, onFailCapture } = buildFakeDeps({
      ensureConfig: vi.fn().mockResolvedValue(namedConfig),
      createTunnel,
    });

    const stderr: string[] = [];

    const startPromise = handleStart(['start'], deps, {
      abortAfterReady: false,
      onServerReady: () => {
        expect(onFailCapture.cb).not.toBeNull();
        onFailCapture.cb!();
      },
      stderr: (s) => stderr.push(s),
      stdout: () => {},
      exitFn: () => {},
    });

    await new Promise((r) => setTimeout(r, 50));

    // createTunnel called only ONCE (initial tunnel, not again on fail)
    expect(createTunnel.mock.calls.length).toBe(1);
    // A warning should appear in stderr
    expect(stderr.some((s) => s.includes('named') || s.includes('warn') || s.includes('unhealthy') || s.includes('Cloudflare edge'))).toBe(true);

    process.emit('SIGTERM');
    await startPromise;
  });
});

// ── TASK-017-a: SIGTERM during reconnect race ─────────────────────────────────

describe('handleStart reconnect — TASK-017: SIGTERM/reconnect race', () => {
  beforeEach(() => {
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
  });

  it('SIGTERM during reconnect — process exits cleanly, no unhandled exception', async () => {
    const { handleStart } = await import('./cli.js');

    let newTunnelStopCalled = 0;
    // createTunnel second call returns a new handle but takes 50ms (simulates slow spawn)
    const slowNewHandle = {
      publicUrl: 'https://new.trycloudflare.com',
      stop: vi.fn().mockImplementation(async () => {
        newTunnelStopCalled++;
      }),
      onUrlReady: vi.fn().mockReturnValue(() => {}),
      onDrop: vi.fn().mockReturnValue(() => {}),
    };

    const { deps, onFailCapture } = buildFakeDeps({
      createTunnel: vi.fn()
        .mockResolvedValueOnce({
          publicUrl: 'https://old.trycloudflare.com',
          stop: vi.fn().mockResolvedValue(undefined),
          onUrlReady: vi.fn().mockReturnValue(() => {}),
          onDrop: vi.fn().mockReturnValue(() => {}),
        })
        .mockImplementationOnce(
          () => new Promise<typeof slowNewHandle>((resolve) => setTimeout(() => resolve(slowNewHandle), 30)),
        ),
    });

    let exitCode: number | null = null;
    let threwUnhandled = false;

    process.on('uncaughtException', () => {
      threwUnhandled = true;
    });

    const startPromise = handleStart(['start'], deps, {
      abortAfterReady: false,
      onServerReady: () => {
        // Trigger reconnect
        expect(onFailCapture.cb).not.toBeNull();
        onFailCapture.cb!();

        // Fire SIGTERM while reconnect is in-flight (state should be 'reconnecting')
        setTimeout(() => process.emit('SIGTERM'), 10);
      },
      stderr: () => {},
      stdout: () => {},
      exitFn: (code) => { exitCode = code; },
    });

    await new Promise((r) => setTimeout(r, 150));

    // Process should have exited cleanly
    expect(exitCode).toBe(0);
    // No unhandled exceptions
    expect(threwUnhandled).toBe(false);
    // New tunnel should have been stopped (at most once) — or not started at all
    expect(newTunnelStopCalled).toBeLessThanOrEqual(1);

    process.removeAllListeners('uncaughtException');
    await startPromise;
  });

  it('SIGTERM fires while state=running → tunnel stopped exactly once', async () => {
    const { handleStart } = await import('./cli.js');

    const tunnelStop = vi.fn().mockResolvedValue(undefined);
    const { deps } = buildFakeDeps({
      createTunnel: vi.fn().mockResolvedValue({
        publicUrl: 'https://abc.trycloudflare.com',
        stop: tunnelStop,
        onUrlReady: vi.fn().mockReturnValue(() => {}),
        onDrop: vi.fn().mockReturnValue(() => {}),
      }),
    });

    let exitCode: number | null = null;

    const startPromise = handleStart(['start'], deps, {
      abortAfterReady: false,
      onServerReady: () => {
        process.emit('SIGTERM');
      },
      stderr: () => {},
      stdout: () => {},
      exitFn: (code) => { exitCode = code; },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(exitCode).toBe(0);
    // Tunnel stop should be called exactly once
    expect(tunnelStop).toHaveBeenCalledTimes(1);

    await startPromise;
  });
});

// ── FIX-1: reconnect failure restarts healthcheck unconditionally ─────────────

describe('handleStart reconnect — FIX-1: healthcheck restarted after reconnect failure', () => {
  beforeEach(() => {
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
  });

  it('FIX-1: startHealthcheck is called a second time after createTunnel rejects', async () => {
    const { handleStart } = await import('./cli.js');

    const { deps, onFailCapture } = buildFakeDeps({
      createTunnel: vi.fn()
        .mockResolvedValueOnce({
          publicUrl: 'https://old.trycloudflare.com',
          stop: vi.fn().mockResolvedValue(undefined),
          onUrlReady: vi.fn().mockReturnValue(() => {}),
          onDrop: vi.fn().mockReturnValue(() => {}),
        })
        .mockRejectedValueOnce(new Error('cloudflared failed to reconnect')),
    });

    const startHealthcheckSpy = deps.startHealthcheck as ReturnType<typeof vi.fn>;

    const startPromise = handleStart(['start'], deps, {
      abortAfterReady: false,
      onServerReady: () => {
        expect(onFailCapture.cb).not.toBeNull();
        onFailCapture.cb!();
      },
      stderr: () => {},
      stdout: () => {},
      exitFn: () => {},
    });

    // Give async reconnect time to process
    await new Promise((r) => setTimeout(r, 80));

    // startHealthcheck must have been called TWICE:
    // once after initial tunnel up, once after reconnect failure
    expect(startHealthcheckSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    process.emit('SIGTERM');
    await startPromise;
  });
});

// ── FIX-5: shutdown() is exception-safe ──────────────────────────────────────

describe('handleStart shutdown — FIX-5: exception-safe shutdown()', () => {
  beforeEach(() => {
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
  });

  it('FIX-5: deletePidFile and exitFn(0) called even when tunnelHandle.stop() throws', async () => {
    const { handleStart } = await import('./cli.js');

    const deletePidFile = vi.fn().mockResolvedValue(undefined);
    let exitCode: number | null = null;

    const { deps } = buildFakeDeps({
      createTunnel: vi.fn().mockResolvedValue({
        publicUrl: 'https://abc.trycloudflare.com',
        // throws on stop()
        stop: vi.fn().mockRejectedValue(new Error('cloudflared in weird state')),
        onUrlReady: vi.fn().mockReturnValue(() => {}),
        onDrop: vi.fn().mockReturnValue(() => {}),
      }),
      deletePidFile,
    });

    const startPromise = handleStart(['start'], deps, {
      abortAfterReady: false,
      onServerReady: () => {
        // Trigger SIGTERM → shutdown() → tunnelHandle.stop() throws
        process.emit('SIGTERM');
      },
      stderr: () => {},
      stdout: () => {},
      exitFn: (code) => { exitCode = code; },
    });

    await new Promise((r) => setTimeout(r, 80));

    // Despite the throw, deletePidFile and exitFn should still have been called
    expect(deletePidFile).toHaveBeenCalled();
    expect(exitCode).toBe(0);

    await startPromise;
  });
});

// ── FIX-9: updatePidFileUrl called with null (not '') when publicUrl is null ──

describe('handleStart reconnect — FIX-9: updatePidFileUrl gets null not empty string', () => {
  beforeEach(() => {
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
  });

  it('FIX-9: updatePidFileUrl is called with null when newHandle.publicUrl is null', async () => {
    const { handleStart } = await import('./cli.js');

    const updatePidFileUrl = vi.fn().mockResolvedValue(undefined);
    const { deps, onFailCapture } = buildFakeDeps({
      updatePidFileUrl,
      createTunnel: vi.fn()
        .mockResolvedValueOnce({
          publicUrl: 'https://old.trycloudflare.com',
          stop: vi.fn().mockResolvedValue(undefined),
          onUrlReady: vi.fn().mockReturnValue(() => {}),
          onDrop: vi.fn().mockReturnValue(() => {}),
        })
        .mockResolvedValueOnce({
          // publicUrl is null — simulates tunnel that has no URL yet
          publicUrl: null,
          stop: vi.fn().mockResolvedValue(undefined),
          onUrlReady: vi.fn().mockReturnValue(() => {}),
          onDrop: vi.fn().mockReturnValue(() => {}),
        }),
    });

    const startPromise = handleStart(['start'], deps, {
      abortAfterReady: false,
      onServerReady: () => {
        expect(onFailCapture.cb).not.toBeNull();
        onFailCapture.cb!();
      },
      stderr: () => {},
      stdout: () => {},
      exitFn: () => {},
    });

    await new Promise((r) => setTimeout(r, 80));

    // updatePidFileUrl should have been called with null, NOT with ''
    const calls = updatePidFileUrl.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const lastCallArg = calls[calls.length - 1]?.[0];
    expect(lastCallArg).toBeNull();

    process.emit('SIGTERM');
    await startPromise;
  });
});
