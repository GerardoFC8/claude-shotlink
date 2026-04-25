/**
 * cli.setup-tunnel.test.ts
 *
 * B5 — TASK-016 + TASK-017: RED + GREEN tests for the `setup-tunnel` subcommand.
 *
 * Tests:
 *   TASK-016: CLI flag parsing — missing --hostname, missing --name, invalid hostname,
 *             default --port=7331, --skip-dns parsed, --port flag overrides default.
 *   TASK-017: Happy path — all flags valid, runSetupTunnel resolves ok:true,
 *             prints success summary + "now run claude-shotlink start", exits 0.
 *   Config persistence: saveConfig called with all 4 wizard fields after success.
 *   configure-tunnel field preservation (Open Point 3).
 *   Cert missing → exit 1 + stderr hint.
 *
 * Uses injected CliDeps so no real fs calls are made.
 * runSetupTunnel is injected via CliDeps.setupTunnel (new dep field added in B5).
 */
import { describe, it, expect, vi } from 'vitest';
import type { CliDeps, Config } from './cli.js';
import type { SetupTunnelResult } from './setup-tunnel.js';

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
    // B5: new dep field for the setup-tunnel orchestration module
    setupTunnel: vi.fn().mockResolvedValue({
      ok: true,
      uuid: 'c0ffee01-2222-3333-4444-555555555555',
      credentialsFile: '/home/user/.cloudflared/c0ffee01-2222-3333-4444-555555555555.json',
      dnsRouted: true,
    } satisfies SetupTunnelResult),
  };

  return { ...defaults, ...overrides } as unknown as CliDeps;
}

// ── TASK-016: CLI flag parsing ────────────────────────────────────────────────

describe('handleSetupTunnel — TASK-016: flag parsing', () => {
  it('exits 1 + stderr explains when --hostname is missing', async () => {
    const { handleSetupTunnel } = await import('./cli.js');

    const deps = buildFakeDeps();
    const stderrLines: string[] = [];
    const code = await handleSetupTunnel(
      ['setup-tunnel', '--name', 'shotlink'],
      deps,
      { stdout: () => {}, stderr: (s) => stderrLines.push(s) },
    );

    expect(code).toBe(1);
    expect(stderrLines.join('')).toMatch(/--hostname/i);
  });

  it('exits 1 + stderr mentions required flags when --name AND --hostname are both missing', async () => {
    const { handleSetupTunnel } = await import('./cli.js');

    const deps = buildFakeDeps();
    const stderrLines: string[] = [];
    const code = await handleSetupTunnel(
      ['setup-tunnel'],
      deps,
      { stdout: () => {}, stderr: (s) => stderrLines.push(s) },
    );

    expect(code).toBe(1);
    expect(stderrLines.join('')).toMatch(/--hostname/i);
  });

  it('exits 1 + stderr explains when --hostname is invalid (has scheme)', async () => {
    const { handleSetupTunnel } = await import('./cli.js');

    const deps = buildFakeDeps();
    const stderrLines: string[] = [];
    const code = await handleSetupTunnel(
      ['setup-tunnel', '--name', 'shotlink', '--hostname', 'https://shots.example.com'],
      deps,
      { stdout: () => {}, stderr: (s) => stderrLines.push(s) },
    );

    expect(code).toBe(1);
    expect(stderrLines.join('')).toMatch(/hostname/i);
  });

  it('--port defaults to 7331 when omitted', async () => {
    const { handleSetupTunnel } = await import('./cli.js');

    const setupTunnelMock = vi.fn().mockResolvedValue({
      ok: true,
      uuid: 'c0ffee01-2222-3333-4444-555555555555',
      credentialsFile: '/home/user/.cloudflared/c0ffee01-2222-3333-4444-555555555555.json',
      dnsRouted: true,
    } satisfies SetupTunnelResult);

    const deps = buildFakeDeps({ setupTunnel: setupTunnelMock });
    const code = await handleSetupTunnel(
      ['setup-tunnel', '--name', 'shotlink', '--hostname', 'shots.example.com'],
      deps,
      { stdout: () => {}, stderr: () => {} },
    );

    expect(code).toBe(0);
    // The setupTunnel function should have been called with port=7331 (default)
    expect(setupTunnelMock).toHaveBeenCalledWith(
      expect.objectContaining({ port: 7331 }),
      expect.anything(),
    );
  });

  it('--skip-dns flag is parsed and forwarded to setupTunnel', async () => {
    const { handleSetupTunnel } = await import('./cli.js');

    const setupTunnelMock = vi.fn().mockResolvedValue({
      ok: true,
      uuid: 'c0ffee01-2222-3333-4444-555555555555',
      credentialsFile: '/home/user/.cloudflared/c0ffee01-2222-3333-4444-555555555555.json',
      dnsRouted: false,
      dnsManualCommand: 'cloudflared tunnel route dns shotlink shots.example.com',
    } satisfies SetupTunnelResult);

    const deps = buildFakeDeps({ setupTunnel: setupTunnelMock });
    const code = await handleSetupTunnel(
      ['setup-tunnel', '--name', 'shotlink', '--hostname', 'shots.example.com', '--skip-dns'],
      deps,
      { stdout: () => {}, stderr: () => {} },
    );

    expect(code).toBe(0);
    expect(setupTunnelMock).toHaveBeenCalledWith(
      expect.objectContaining({ skipDns: true }),
      expect.anything(),
    );
  });

  it('--port flag overrides the default', async () => {
    const { handleSetupTunnel } = await import('./cli.js');

    const setupTunnelMock = vi.fn().mockResolvedValue({
      ok: true,
      uuid: 'c0ffee01-2222-3333-4444-555555555555',
      credentialsFile: '/home/user/.cloudflared/c0ffee01-2222-3333-4444-555555555555.json',
      dnsRouted: true,
    } satisfies SetupTunnelResult);

    const deps = buildFakeDeps({ setupTunnel: setupTunnelMock });
    const code = await handleSetupTunnel(
      ['setup-tunnel', '--name', 'shotlink', '--hostname', 'shots.example.com', '--port', '8080'],
      deps,
      { stdout: () => {}, stderr: () => {} },
    );

    expect(code).toBe(0);
    expect(setupTunnelMock).toHaveBeenCalledWith(
      expect.objectContaining({ port: 8080 }),
      expect.anything(),
    );
  });

  it('--name defaults to "shotlink" when omitted (spec CA-1.1)', async () => {
    const { handleSetupTunnel } = await import('./cli.js');

    const setupTunnelMock = vi.fn().mockResolvedValue({
      ok: true,
      uuid: 'c0ffee01-2222-3333-4444-555555555555',
      credentialsFile: '/home/user/.cloudflared/c0ffee01-2222-3333-4444-555555555555.json',
      dnsRouted: true,
    } satisfies SetupTunnelResult);

    const deps = buildFakeDeps({ setupTunnel: setupTunnelMock });
    const code = await handleSetupTunnel(
      ['setup-tunnel', '--hostname', 'shots.example.com'],
      deps,
      { stdout: () => {}, stderr: () => {} },
    );

    expect(code).toBe(0);
    expect(setupTunnelMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'shotlink' }),
      expect.anything(),
    );
  });
});

// ── TASK-017: Happy path ──────────────────────────────────────────────────────

describe('handleSetupTunnel — TASK-017: happy path + success output', () => {
  it('happy path: exits 0, prints tunnel name + hostname in stdout, hints "claude-shotlink start"', async () => {
    const { handleSetupTunnel } = await import('./cli.js');

    const setupTunnelMock = vi.fn().mockResolvedValue({
      ok: true,
      uuid: 'c0ffee01-2222-3333-4444-555555555555',
      credentialsFile: '/home/user/.cloudflared/c0ffee01-2222-3333-4444-555555555555.json',
      dnsRouted: true,
    } satisfies SetupTunnelResult);

    const deps = buildFakeDeps({ setupTunnel: setupTunnelMock });
    const stdoutLines: string[] = [];

    const code = await handleSetupTunnel(
      ['setup-tunnel', '--name', 'myname', '--hostname', 'shots.example.com'],
      deps,
      { stdout: (s) => stdoutLines.push(s), stderr: () => {} },
    );

    expect(code).toBe(0);
    const output = stdoutLines.join('\n');
    expect(output).toContain('myname');
    expect(output).toContain('shots.example.com');
    expect(output).toMatch(/claude-shotlink start/i);
  });

  it('FIX-4: does NOT call deps.saveConfig directly (setup-tunnel module owns the save — CA-1.5)', async () => {
    // FIX-4: handleSetupTunnel no longer calls saveConfig redundantly.
    // The setup-tunnel module (deps.setupTunnel) is the single source of truth
    // for writing wizard config fields. handleSetupTunnel delegates entirely.
    const { handleSetupTunnel } = await import('./cli.js');

    const credFile = '/home/user/.cloudflared/c0ffee01-2222-3333-4444-555555555555.json';
    const setupTunnelMock = vi.fn().mockResolvedValue({
      ok: true,
      uuid: 'c0ffee01-2222-3333-4444-555555555555',
      credentialsFile: credFile,
      dnsRouted: true,
    } satisfies SetupTunnelResult);

    const saveConfigMock = vi.fn().mockResolvedValue(undefined);

    const deps = buildFakeDeps({
      setupTunnel: setupTunnelMock,
      saveConfig: saveConfigMock,
    });

    const code = await handleSetupTunnel(
      ['setup-tunnel', '--name', 'myname', '--hostname', 'shots.example.com'],
      deps,
      { stdout: () => {}, stderr: () => {} },
    );

    expect(code).toBe(0);
    // FIX-4: handler no longer calls saveConfig — setup-tunnel module owns the save
    expect(saveConfigMock).not.toHaveBeenCalled();
    // setup-tunnel dep was called (it saves internally)
    expect(setupTunnelMock).toHaveBeenCalled();
  });

  it('FIX-4: setupTunnel input includes port=8080 when --port is provided (module owns the save)', async () => {
    // FIX-4: handler no longer saves; assert setupTunnel receives port so the module
    // can write it into config itself.
    const { handleSetupTunnel } = await import('./cli.js');

    const setupTunnelMock = vi.fn().mockResolvedValue({
      ok: true,
      uuid: 'c0ffee01-2222-3333-4444-555555555555',
      credentialsFile: '/home/user/.cloudflared/c0ffee01-2222-3333-4444-555555555555.json',
      dnsRouted: true,
    } satisfies SetupTunnelResult);

    const deps = buildFakeDeps({ setupTunnel: setupTunnelMock });

    await handleSetupTunnel(
      ['setup-tunnel', '--name', 'myname', '--hostname', 'shots.example.com', '--port', '8080'],
      deps,
      { stdout: () => {}, stderr: () => {} },
    );

    // The port is forwarded to the module (which saves it as tunnelLocalPort)
    expect(setupTunnelMock).toHaveBeenCalledWith(
      expect.objectContaining({ port: 8080 }),
      expect.anything(),
    );
  });

  it('FIX-4: setupTunnel input includes port=7331 (default) when --port is omitted', async () => {
    const { handleSetupTunnel } = await import('./cli.js');

    const setupTunnelMock = vi.fn().mockResolvedValue({
      ok: true,
      uuid: 'c0ffee01-2222-3333-4444-555555555555',
      credentialsFile: '/home/user/.cloudflared/c0ffee01-2222-3333-4444-555555555555.json',
      dnsRouted: true,
    } satisfies SetupTunnelResult);

    const deps = buildFakeDeps({ setupTunnel: setupTunnelMock });

    await handleSetupTunnel(
      ['setup-tunnel', '--name', 'myname', '--hostname', 'shots.example.com'],
      deps,
      { stdout: () => {}, stderr: () => {} },
    );

    expect(setupTunnelMock).toHaveBeenCalledWith(
      expect.objectContaining({ port: 7331 }),
      expect.anything(),
    );
  });
});

// ── Cert missing / failure paths ──────────────────────────────────────────────

describe('handleSetupTunnel — failure paths', () => {
  it('surfaces missing-cert error: exit 1, stderr has "cloudflared tunnel login" hint', async () => {
    const { handleSetupTunnel } = await import('./cli.js');

    const setupTunnelMock = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'missing-cert',
      message: 'cloudflared not authenticated.\nRun: cloudflared tunnel login\nThen re-run: claude-shotlink setup-tunnel --name shotlink --hostname shots.example.com',
    } satisfies SetupTunnelResult);

    const deps = buildFakeDeps({ setupTunnel: setupTunnelMock });
    const stderrLines: string[] = [];

    const code = await handleSetupTunnel(
      ['setup-tunnel', '--name', 'shotlink', '--hostname', 'shots.example.com'],
      deps,
      { stdout: () => {}, stderr: (s) => stderrLines.push(s) },
    );

    expect(code).toBe(1);
    expect(stderrLines.join('')).toMatch(/cloudflared tunnel login/i);
  });

  it('surfaces create-failed error: exit 1, stderr contains the cloudflared error', async () => {
    const { handleSetupTunnel } = await import('./cli.js');

    const setupTunnelMock = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'create-failed',
      message: 'Failed to create tunnel "shotlink". cloudflared exited with code 1. stderr tail:\nsome error',
    } satisfies SetupTunnelResult);

    const deps = buildFakeDeps({ setupTunnel: setupTunnelMock });
    const stderrLines: string[] = [];

    const code = await handleSetupTunnel(
      ['setup-tunnel', '--name', 'shotlink', '--hostname', 'shots.example.com'],
      deps,
      { stdout: () => {}, stderr: (s) => stderrLines.push(s) },
    );

    expect(code).toBe(1);
    expect(stderrLines.join('')).toContain('Failed to create tunnel');
  });

  it('DNS routing failure: exits 0 with warning in stderr (partial success)', async () => {
    const { handleSetupTunnel } = await import('./cli.js');

    const setupTunnelMock = vi.fn().mockResolvedValue({
      ok: true,
      uuid: 'c0ffee01-2222-3333-4444-555555555555',
      credentialsFile: '/home/user/.cloudflared/c0ffee01-2222-3333-4444-555555555555.json',
      dnsRouted: false,
      dnsManualCommand: 'cloudflared tunnel route dns shotlink shots.example.com',
    } satisfies SetupTunnelResult);

    const deps = buildFakeDeps({ setupTunnel: setupTunnelMock });
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    const code = await handleSetupTunnel(
      ['setup-tunnel', '--name', 'shotlink', '--hostname', 'shots.example.com'],
      deps,
      { stdout: (s) => stdoutLines.push(s), stderr: (s) => stderrLines.push(s) },
    );

    expect(code).toBe(0);
    const allOutput = [...stderrLines, ...stdoutLines].join('\n');
    // Should include the manual DNS command hint
    expect(allOutput).toMatch(/cloudflared tunnel route dns/i);
  });
});

// ── dispatch routing: 'setup-tunnel' dispatches to handleSetupTunnel ──────────

describe('dispatch — B5: setup-tunnel subcommand routing', () => {
  it('dispatch setup-tunnel routes to handleSetupTunnel', async () => {
    const { dispatch } = await import('./cli.js');

    const setupTunnelMock = vi.fn().mockResolvedValue({
      ok: true,
      uuid: 'c0ffee01-2222-3333-4444-555555555555',
      credentialsFile: '/home/user/.cloudflared/c0ffee01-2222-3333-4444-555555555555.json',
      dnsRouted: true,
    } satisfies SetupTunnelResult);

    const deps = buildFakeDeps({ setupTunnel: setupTunnelMock });

    const code = await dispatch(
      ['setup-tunnel', '--name', 'shotlink', '--hostname', 'shots.example.com'],
      deps,
      { stdout: () => {}, stderr: () => {} },
    );

    expect(code).toBe(0);
    expect(setupTunnelMock).toHaveBeenCalled();
  });

  it('dispatch unknown command still mentions setup-tunnel in usage line', async () => {
    const { dispatch } = await import('./cli.js');

    const deps = buildFakeDeps();
    const stderrLines: string[] = [];

    const code = await dispatch(
      ['foobar'],
      deps,
      { stdout: () => {}, stderr: (s) => stderrLines.push(s) },
    );

    expect(code).toBe(1);
    expect(stderrLines.join('')).toContain('setup-tunnel');
  });
});

// ── Open Point 3: configure-tunnel additive vs full-replace ──────────────────

describe('handleConfigureTunnel — Open Point 3: does NOT clobber new v0.3 fields', () => {
  it('configure-tunnel --mode named does NOT clear tunnelCredentialsFile written by setup-tunnel', async () => {
    const { handleConfigureTunnel } = await import('./cli.js');

    // Simulate a post-setup-tunnel config with the new v0.3 fields
    const existingConfig: Config = {
      apiKey: 'sk_' + 'a'.repeat(64),
      createdAt: '2026-01-01T00:00:00.000Z',
      tunnelMode: 'named',
      tunnelName: 'myname',
      tunnelHostname: 'shots.example.com',
      tunnelCredentialsFile: '/home/user/.cloudflared/c0ffee01-2222-3333-4444-555555555555.json',
      tunnelLocalPort: 7331,
    };

    const savedConfigs: Config[] = [];
    const saveConfigMock = vi.fn().mockImplementation(async (cfg: Config) => {
      savedConfigs.push({ ...cfg });
    });

    const deps = buildFakeDeps({
      ensureConfig: vi.fn().mockResolvedValue(existingConfig),
      saveConfig: saveConfigMock,
    });

    const code = await handleConfigureTunnel(
      ['configure-tunnel', '--mode', 'named', '--name', 'newname', '--hostname', 'new.example.com'],
      deps,
      { stdout: () => {}, stderr: () => {} },
    );

    expect(code).toBe(0);
    const saved = savedConfigs[0]!;
    // The configure-tunnel merge should preserve tunnelCredentialsFile
    expect(saved.tunnelCredentialsFile).toBe(existingConfig.tunnelCredentialsFile);
    // And tunnelLocalPort
    expect(saved.tunnelLocalPort).toBe(existingConfig.tunnelLocalPort);
    // But update name + hostname
    expect(saved.tunnelName).toBe('newname');
    expect(saved.tunnelHostname).toBe('new.example.com');
  });

  it('configure-tunnel --mode quick clears tunnel-specific fields (including v0.3 fields)', async () => {
    const { handleConfigureTunnel } = await import('./cli.js');

    const existingConfig: Config = {
      apiKey: 'sk_' + 'a'.repeat(64),
      createdAt: '2026-01-01T00:00:00.000Z',
      tunnelMode: 'named',
      tunnelName: 'myname',
      tunnelHostname: 'shots.example.com',
      tunnelCredentialsFile: '/home/user/.cloudflared/c0ffee01-2222-3333-4444-555555555555.json',
      tunnelLocalPort: 7331,
    };

    const savedConfigs: Config[] = [];
    const saveConfigMock = vi.fn().mockImplementation(async (cfg: Config) => {
      savedConfigs.push({ ...cfg });
    });

    const deps = buildFakeDeps({
      ensureConfig: vi.fn().mockResolvedValue(existingConfig),
      saveConfig: saveConfigMock,
    });

    const code = await handleConfigureTunnel(
      ['configure-tunnel', '--mode', 'quick'],
      deps,
      { stdout: () => {}, stderr: () => {} },
    );

    expect(code).toBe(0);
    const saved = savedConfigs[0]!;
    // quick mode should clear all named-mode fields
    expect(saved.tunnelName).toBeUndefined();
    expect(saved.tunnelHostname).toBeUndefined();
    // v0.3 fields should also be cleared when switching to quick mode
    expect(saved.tunnelCredentialsFile).toBeUndefined();
    expect(saved.tunnelLocalPort).toBeUndefined();
  });
});
