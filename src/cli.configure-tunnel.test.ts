/**
 * cli.configure-tunnel.test.ts
 *
 * TASK-010: RED + GREEN tests for the `configure-tunnel` subcommand.
 *
 * Tests flag parsing, validation, atomic-write round-trip, and error paths.
 * Uses injected CliDeps so no real fs calls are made.
 */
import { describe, it, expect, vi } from 'vitest';
import type { CliDeps, Config } from './cli.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildFakeDeps(overrides: Record<string, any> = {}): CliDeps {
  const baseConfig: Config = {
    apiKey: 'sk_' + 'a'.repeat(64),
    createdAt: '2026-01-01T00:00:00.000Z',
  };

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
    createTunnel: vi.fn().mockResolvedValue({
      publicUrl: null,
      stop: vi.fn().mockResolvedValue(undefined),
      onUrlReady: vi.fn().mockReturnValue(() => {}),
      onDrop: vi.fn().mockReturnValue(() => {}),
    }),
    installHook: vi.fn().mockResolvedValue({ action: 'installed', backupPath: null }),
    uninstallHook: vi.fn().mockResolvedValue({ action: 'removed', backupPath: null, removedCount: 1 }),
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
    updatePidFileUrl: vi.fn().mockResolvedValue(undefined),
    purgeDedupCache: vi.fn().mockResolvedValue(undefined),
    startHealthcheck: vi.fn().mockReturnValue({ stop: vi.fn(), failCount: 0, stopped: false }),
  };

  return { ...defaults, ...overrides } as unknown as CliDeps;
}

// ── TASK-010 tests — configure-tunnel subcommand ──────────────────────────────

describe('handleConfigureTunnel — TASK-010', () => {
  it('named mode: writes all 3 tunnel fields + preserves existing config fields + exits 0', async () => {
    const { handleConfigureTunnel } = await import('./cli.js');

    const existingConfig: Config = {
      apiKey: 'sk_' + 'a'.repeat(64),
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    const savedConfigs: Config[] = [];
    const saveConfigMock = vi.fn().mockImplementation(async (cfg: Config) => {
      savedConfigs.push({ ...cfg });
    });

    const deps = buildFakeDeps({
      ensureConfig: vi.fn().mockResolvedValue(existingConfig),
      saveConfig: saveConfigMock,
    });

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    const code = await handleConfigureTunnel(
      ['configure-tunnel', '--mode', 'named', '--name', 'my-tunnel', '--hostname', 'shots.example.com'],
      deps,
      { stdout: (s) => stdoutLines.push(s), stderr: (s) => stderrLines.push(s) },
    );

    expect(code).toBe(0);
    expect(saveConfigMock).toHaveBeenCalledTimes(1);

    const saved = savedConfigs[0]!;
    expect(saved.tunnelMode).toBe('named');
    expect(saved.tunnelName).toBe('my-tunnel');
    expect(saved.tunnelHostname).toBe('shots.example.com');
    // Preserved fields
    expect(saved.apiKey).toBe(existingConfig.apiKey);
    expect(saved.createdAt).toBe(existingConfig.createdAt);
    // Success message on stdout
    expect(stdoutLines.join('')).toContain('named');
    // No error messages
    expect(stderrLines).toHaveLength(0);
  });

  it('quick mode: writes tunnelMode=quick, clears name/hostname + exits 0', async () => {
    const { handleConfigureTunnel } = await import('./cli.js');

    const existingConfig: Config = {
      apiKey: 'sk_' + 'a'.repeat(64),
      createdAt: '2026-01-01T00:00:00.000Z',
      tunnelMode: 'named',
      tunnelName: 'old-tunnel',
      tunnelHostname: 'old.example.com',
    };

    const savedConfigs: Config[] = [];
    const saveConfigMock = vi.fn().mockImplementation(async (cfg: Config) => {
      savedConfigs.push({ ...cfg });
    });

    const deps = buildFakeDeps({
      ensureConfig: vi.fn().mockResolvedValue(existingConfig),
      saveConfig: saveConfigMock,
    });

    const stdoutLines: string[] = [];
    const code = await handleConfigureTunnel(
      ['configure-tunnel', '--mode', 'quick'],
      deps,
      { stdout: (s) => stdoutLines.push(s), stderr: () => {} },
    );

    expect(code).toBe(0);
    expect(saveConfigMock).toHaveBeenCalledTimes(1);

    const saved = savedConfigs[0]!;
    expect(saved.tunnelMode).toBe('quick');
    // Name and hostname should be absent (undefined — JSON.stringify drops them)
    expect(saved.tunnelName).toBeUndefined();
    expect(saved.tunnelHostname).toBeUndefined();
    // Preserved fields
    expect(saved.apiKey).toBe(existingConfig.apiKey);
  });

  it('exits 1 + config NOT written when --mode is missing', async () => {
    const { handleConfigureTunnel } = await import('./cli.js');

    const saveConfigMock = vi.fn().mockResolvedValue(undefined);
    const deps = buildFakeDeps({ saveConfig: saveConfigMock });

    const stderrLines: string[] = [];
    const code = await handleConfigureTunnel(
      ['configure-tunnel', '--name', 'my-tunnel', '--hostname', 'shots.example.com'],
      deps,
      { stdout: () => {}, stderr: (s) => stderrLines.push(s) },
    );

    expect(code).toBe(1);
    expect(saveConfigMock).not.toHaveBeenCalled();
    expect(stderrLines.join('')).toMatch(/--mode/i);
  });

  it('exits 1 + config NOT written when --mode named is given without --hostname', async () => {
    const { handleConfigureTunnel } = await import('./cli.js');

    const saveConfigMock = vi.fn().mockResolvedValue(undefined);
    const deps = buildFakeDeps({ saveConfig: saveConfigMock });

    const stderrLines: string[] = [];
    const code = await handleConfigureTunnel(
      ['configure-tunnel', '--mode', 'named', '--name', 'my-tunnel'],
      deps,
      { stdout: () => {}, stderr: (s) => stderrLines.push(s) },
    );

    expect(code).toBe(1);
    expect(saveConfigMock).not.toHaveBeenCalled();
    expect(stderrLines.join('')).toMatch(/hostname/i);
  });

  it('exits 1 + config NOT written when --mode named is given without --name', async () => {
    const { handleConfigureTunnel } = await import('./cli.js');

    const saveConfigMock = vi.fn().mockResolvedValue(undefined);
    const deps = buildFakeDeps({ saveConfig: saveConfigMock });

    const stderrLines: string[] = [];
    const code = await handleConfigureTunnel(
      ['configure-tunnel', '--mode', 'named', '--hostname', 'shots.example.com'],
      deps,
      { stdout: () => {}, stderr: (s) => stderrLines.push(s) },
    );

    expect(code).toBe(1);
    expect(saveConfigMock).not.toHaveBeenCalled();
    expect(stderrLines.join('')).toMatch(/--name/i);
  });

  it('exits 1 + config NOT written when --mode has invalid value', async () => {
    const { handleConfigureTunnel } = await import('./cli.js');

    const saveConfigMock = vi.fn().mockResolvedValue(undefined);
    const deps = buildFakeDeps({ saveConfig: saveConfigMock });

    const stderrLines: string[] = [];
    const code = await handleConfigureTunnel(
      ['configure-tunnel', '--mode', 'invalid-mode'],
      deps,
      { stdout: () => {}, stderr: (s) => stderrLines.push(s) },
    );

    expect(code).toBe(1);
    expect(saveConfigMock).not.toHaveBeenCalled();
    expect(stderrLines.join('')).toMatch(/invalid.*mode|quick.*named/i);
  });

  it('idempotent: running named mode twice yields same config', async () => {
    const { handleConfigureTunnel } = await import('./cli.js');

    let storedConfig: Config = {
      apiKey: 'sk_' + 'a'.repeat(64),
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    const saveConfigMock = vi.fn().mockImplementation(async (cfg: Config) => {
      storedConfig = { ...cfg };
    });

    const deps = buildFakeDeps({
      ensureConfig: vi.fn().mockImplementation(async () => storedConfig),
      saveConfig: saveConfigMock,
    });

    const argv = ['configure-tunnel', '--mode', 'named', '--name', 'T', '--hostname', 'h.example.com'];

    // Run twice
    await handleConfigureTunnel(argv, deps, { stdout: () => {}, stderr: () => {} });
    await handleConfigureTunnel(argv, deps, { stdout: () => {}, stderr: () => {} });

    expect(saveConfigMock).toHaveBeenCalledTimes(2);
    // Both saves should have the same tunnel values
    const [first, second] = saveConfigMock.mock.calls.map((c) => c[0] as Config);
    expect(first!.tunnelMode).toBe('named');
    expect(second!.tunnelMode).toBe('named');
    expect(first!.tunnelHostname).toBe(second!.tunnelHostname);
  });
});

// ── FIX-3: handleConfigureTunnel validates hostname before saving ─────────────

describe('handleConfigureTunnel — FIX-3: hostname validation', () => {
  it('FIX-3: exits 1 + saveConfig NOT called when --hostname has a scheme (http://)', async () => {
    const { handleConfigureTunnel } = await import('./cli.js');

    const saveConfigMock = vi.fn().mockResolvedValue(undefined);
    const deps = buildFakeDeps({ saveConfig: saveConfigMock });

    const stderrLines: string[] = [];
    const code = await handleConfigureTunnel(
      ['configure-tunnel', '--mode', 'named', '--name', 'my-tunnel', '--hostname', 'http://x.com'],
      deps,
      { stdout: () => {}, stderr: (s) => stderrLines.push(s) },
    );

    expect(code).toBe(1);
    expect(saveConfigMock).not.toHaveBeenCalled();
    expect(stderrLines.join('')).toMatch(/hostname/i);
  });

  it('FIX-3: exits 1 + saveConfig NOT called when --hostname has a path segment', async () => {
    const { handleConfigureTunnel } = await import('./cli.js');

    const saveConfigMock = vi.fn().mockResolvedValue(undefined);
    const deps = buildFakeDeps({ saveConfig: saveConfigMock });

    const stderrLines: string[] = [];
    const code = await handleConfigureTunnel(
      ['configure-tunnel', '--mode', 'named', '--name', 'my-tunnel', '--hostname', 'x.com/path'],
      deps,
      { stdout: () => {}, stderr: (s) => stderrLines.push(s) },
    );

    expect(code).toBe(1);
    expect(saveConfigMock).not.toHaveBeenCalled();
    expect(stderrLines.join('')).toMatch(/hostname/i);
  });

  it('FIX-3: valid bare hostname passes validation and saves', async () => {
    const { handleConfigureTunnel } = await import('./cli.js');

    const saveConfigMock = vi.fn().mockResolvedValue(undefined);
    const deps = buildFakeDeps({ saveConfig: saveConfigMock });

    const code = await handleConfigureTunnel(
      ['configure-tunnel', '--mode', 'named', '--name', 'my-tunnel', '--hostname', 'shots.example.com'],
      deps,
      { stdout: () => {}, stderr: () => {} },
    );

    expect(code).toBe(0);
    expect(saveConfigMock).toHaveBeenCalledTimes(1);
  });
});

// ── dispatch routing: 'configure-tunnel' dispatches to handleConfigureTunnel ──

describe('dispatch — TASK-010: configure-tunnel subcommand routing', () => {
  it('dispatch configure-tunnel routes to handleConfigureTunnel', async () => {
    const { dispatch } = await import('./cli.js');

    const saveConfigMock = vi.fn().mockResolvedValue(undefined);
    const deps = buildFakeDeps({
      ensureConfig: vi.fn().mockResolvedValue({
        apiKey: 'sk_' + 'a'.repeat(64),
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      saveConfig: saveConfigMock,
    });

    const stdoutLines: string[] = [];
    const code = await dispatch(
      ['configure-tunnel', '--mode', 'quick'],
      deps,
      { stdout: (s) => stdoutLines.push(s), stderr: () => {} },
    );

    expect(code).toBe(0);
    expect(saveConfigMock).toHaveBeenCalled();
  });
});
