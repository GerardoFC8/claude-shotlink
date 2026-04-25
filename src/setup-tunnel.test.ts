/**
 * setup-tunnel.test.ts
 *
 * Unit tests for src/setup-tunnel.ts — the `setup-tunnel` orchestration module.
 *
 * Strategy: inject all side-effectful deps (spawnImpl, fileExists, readFileUtf8,
 * ensureConfig, saveConfig) so no real cloudflared binary, no real fs calls.
 *
 * TDD cycle: each TASK-xxx-a block is RED-first (the behavior doesn't exist yet
 * when the test is written); TASK-xxx-b implements the green.
 */
import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

import type { SetupTunnelDeps, SetupTunnelInput } from './setup-tunnel.js';
import type { Config } from './config.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a fake ChildProcess whose stdout and stderr can be written to,
 * and whose exit code can be controlled via _exitWithCode.
 */
interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  killed: boolean;
  kill: (signal?: string) => boolean;
  _exitWithCode: (code: number | null) => void;
  _writeStdout: (data: string) => void;
  _writeStderr: (data: string) => void;
  _endAndExit: (code: number | null, stdoutData?: string, stderrData?: string) => void;
}

function makeFakeChild(pid = 99001): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = pid;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  child._writeStdout = (data: string) => child.stdout.push(data);
  child._writeStderr = (data: string) => child.stderr.push(data);
  child._exitWithCode = (code: number | null) => {
    child.stdout.push(null);
    child.stderr.push(null);
    child.emit('close', code);
    child.emit('exit', code);
  };
  child._endAndExit = (code: number | null, stdoutData?: string, stderrData?: string) => {
    if (stdoutData) child.stdout.push(stdoutData);
    if (stderrData) child.stderr.push(stderrData);
    child._exitWithCode(code);
  };
  return child;
}

/** Base config used as the "existing config" in tests. */
const BASE_CONFIG: Config = {
  apiKey: 'sk_' + 'a'.repeat(64),
  createdAt: '2026-01-01T00:00:00.000Z',
};

/** Build minimal SetupTunnelDeps with sensible defaults; override as needed. */
function makeDeps(overrides: Partial<SetupTunnelDeps> = {}): SetupTunnelDeps {
  return {
    binaryPath: '/fake/cloudflared',
    cloudflaredHome: '/fake/.cloudflared',
    configPath: '/fake/.claude-shotlink/config.json',
    ensureConfig: vi.fn().mockResolvedValue(BASE_CONFIG),
    saveConfig: vi.fn().mockResolvedValue(undefined),
    spawnImpl: vi.fn().mockReturnValue(makeFakeChild()) as SetupTunnelDeps['spawnImpl'],
    fileExists: vi.fn().mockReturnValue(false),
    readFileUtf8: vi.fn().mockRejectedValue(new Error('not found')),
    ...overrides,
  };
}

/** Build a minimal valid SetupTunnelInput. */
function makeInput(overrides: Partial<SetupTunnelInput> = {}): SetupTunnelInput {
  return {
    name: 'my-tunnel',
    hostname: 'shots.example.com',
    port: 7331,
    skipDns: false,
    ...overrides,
  };
}

/**
 * Build a spawnImpl that returns a sequence of fake children (one per call).
 * If more calls happen than children provided, throws.
 */
function makeSequentialSpawn(...children: FakeChild[]): SetupTunnelDeps['spawnImpl'] {
  let idx = 0;
  return vi.fn().mockImplementation(() => {
    const child = children[idx++];
    if (!child) throw new Error('makeSequentialSpawn: unexpected extra spawn call');
    return child;
  }) as SetupTunnelDeps['spawnImpl'];
}

/** Simulate a successful `tunnel create --output json` response. */
const HAPPY_CREATE_JSON = JSON.stringify({
  id: 'c0ffee01-1111-2222-3333-444444444444',
  name: 'my-tunnel',
  credentials_file: '/fake/.cloudflared/c0ffee01-1111-2222-3333-444444444444.json',
});

// ── TASK-010: cert.pem check ──────────────────────────────────────────────────

describe('runSetupTunnel — TASK-010: cert.pem check', () => {
  it('TASK-010-a RED: returns missing-cert when cert.pem is absent', async () => {
    const { runSetupTunnel } = await import('./setup-tunnel.js');

    const spawnImpl = vi.fn() as unknown as SetupTunnelDeps['spawnImpl'];
    const deps = makeDeps({
      fileExists: vi.fn().mockReturnValue(false), // cert.pem NOT present
      spawnImpl,
    });

    const result = await runSetupTunnel(makeInput(), deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing-cert');
      expect(result.message).toContain('cloudflared tunnel login');
    }
    // No spawn should have been attempted
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('TASK-010: cert.pem present — passes preflight and continues', async () => {
    const { runSetupTunnel } = await import('./setup-tunnel.js');

    const createChild = makeFakeChild();
    const dnsChild = makeFakeChild();
    const spawnImpl = makeSequentialSpawn(createChild, dnsChild);

    // cert.pem present; credentials file present too (for happy path)
    const fileExists = vi.fn().mockReturnValue(true);

    const deps = makeDeps({ spawnImpl, fileExists });

    const resultPromise = runSetupTunnel(makeInput(), deps);

    // Drive create command to success (after a tick so runCommand sets up listeners)
    await new Promise<void>((r) => setTimeout(r, 10));
    createChild._endAndExit(0, HAPPY_CREATE_JSON);

    // Wait for dns spawn to be set up, then drive it
    await new Promise<void>((r) => setTimeout(r, 10));
    dnsChild._endAndExit(0);

    const result = await resultPromise;
    // Should NOT be missing-cert
    expect(result.ok === false && (result as { reason: string }).reason === 'missing-cert').toBe(false);
  });
});

// ── TASK-011: JSON parsing + credentials_file resolution ─────────────────────

describe('runSetupTunnel — TASK-011: JSON parsing', () => {
  it('TASK-011-a RED: parses uuid and credentials_file from JSON output (credentials_file present)', async () => {
    const { runSetupTunnel } = await import('./setup-tunnel.js');

    const createChild = makeFakeChild();
    const dnsChild = makeFakeChild();
    const spawnImpl = makeSequentialSpawn(createChild, dnsChild);
    const fileExists = vi.fn().mockReturnValue(true);
    const saveConfig = vi.fn().mockResolvedValue(undefined);
    const ensureConfig = vi.fn().mockResolvedValue(BASE_CONFIG);

    const deps = makeDeps({ spawnImpl, fileExists, saveConfig, ensureConfig });
    const resultPromise = runSetupTunnel(makeInput(), deps);

    await new Promise<void>((r) => setTimeout(r, 10));
    createChild._endAndExit(0, HAPPY_CREATE_JSON);

    await new Promise<void>((r) => setTimeout(r, 10));
    dnsChild._endAndExit(0);

    const result = await resultPromise;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.uuid).toBe('c0ffee01-1111-2222-3333-444444444444');
      expect(result.credentialsFile).toBe(
        '/fake/.cloudflared/c0ffee01-1111-2222-3333-444444444444.json',
      );
      expect(result.dnsRouted).toBe(true);
    }
  });

  it('TASK-011-a RED: falls back to <uuid>.json path when credentials_file absent from JSON', async () => {
    const { runSetupTunnel } = await import('./setup-tunnel.js');

    const jsonWithoutCreds = JSON.stringify({
      id: 'deadbeef-aaaa-bbbb-cccc-dddddddddddd',
      name: 'my-tunnel',
      // No credentials_file field
    });

    const createChild = makeFakeChild();
    const dnsChild = makeFakeChild();
    const spawnImpl = makeSequentialSpawn(createChild, dnsChild);
    const fileExists = vi.fn().mockReturnValue(true);

    const deps = makeDeps({ spawnImpl, fileExists });
    const resultPromise = runSetupTunnel(makeInput(), deps);

    await new Promise<void>((r) => setTimeout(r, 10));
    createChild._endAndExit(0, jsonWithoutCreds);

    await new Promise<void>((r) => setTimeout(r, 10));
    dnsChild._endAndExit(0);

    const result = await resultPromise;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.uuid).toBe('deadbeef-aaaa-bbbb-cccc-dddddddddddd');
      // Fallback: <cloudflaredHome>/<uuid>.json
      expect(result.credentialsFile).toBe(
        '/fake/.cloudflared/deadbeef-aaaa-bbbb-cccc-dddddddddddd.json',
      );
    }
  });
});

// ── TASK-012: create-failed branch ───────────────────────────────────────────

describe('runSetupTunnel — TASK-012: create-failed branch', () => {
  it('TASK-012-a RED: returns create-failed when cloudflared exits non-zero (not already-exists)', async () => {
    const { runSetupTunnel } = await import('./setup-tunnel.js');

    const createChild = makeFakeChild();
    const spawnImpl = vi.fn().mockReturnValue(createChild) as unknown as SetupTunnelDeps['spawnImpl'];
    const fileExists = vi.fn().mockReturnValue(true); // cert.pem exists
    const saveConfig = vi.fn();

    const deps = makeDeps({ spawnImpl, fileExists, saveConfig });
    const resultPromise = runSetupTunnel(makeInput(), deps);

    createChild._endAndExit(1, '', 'Error: authentication failed — please login');

    const result = await resultPromise;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('create-failed');
      expect(result.message).toContain('Failed to create tunnel');
    }
    // Config should NOT have been written
    expect(saveConfig).not.toHaveBeenCalled();
  });
});

// ── TASK-013: idempotency — tunnel already exists ────────────────────────────

describe('runSetupTunnel — TASK-013: idempotency (already exists)', () => {
  it('TASK-013-a RED: reuses UUID when tunnel already exists and creds file found via scan', async () => {
    const { runSetupTunnel } = await import('./setup-tunnel.js');

    const credFile = '/fake/.cloudflared/aabbccdd-1111-2222-3333-444444444444.json';
    const credFileContents = JSON.stringify({
      TunnelID: 'aabbccdd-1111-2222-3333-444444444444',
      TunnelName: 'my-tunnel',
    });

    const createChild = makeFakeChild();
    const dnsChild = makeFakeChild();
    const spawnImpl = makeSequentialSpawn(createChild, dnsChild);

    // fileExists: cert.pem present; credential file present
    const fileExists = vi.fn().mockImplementation((p: string) => {
      return p.endsWith('cert.pem') || p === credFile;
    });

    // readFileUtf8: returns the credential file contents when asked
    const readFileUtf8 = vi.fn().mockImplementation(async (p: string) => {
      if (p === credFile) return credFileContents;
      throw new Error(`unexpected readFileUtf8 call: ${p}`);
    });

    // Inject readdirImpl so no dynamic import needed
    const readdirImpl = vi.fn().mockResolvedValue(['aabbccdd-1111-2222-3333-444444444444.json']);

    const saveConfig = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ spawnImpl, fileExists, readFileUtf8, readdirImpl, saveConfig });

    const resultPromise = runSetupTunnel(makeInput(), deps);

    // Drive create to fail with "already exists"
    await new Promise<void>((r) => setTimeout(r, 10));
    createChild._endAndExit(1, '', 'Error: tunnel with name my-tunnel already exists');

    // Drive dns to succeed
    await new Promise<void>((r) => setTimeout(r, 10));
    dnsChild._endAndExit(0);

    const result = await resultPromise;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.uuid).toBe('aabbccdd-1111-2222-3333-444444444444');
      expect(result.credentialsFile).toBe(credFile);
    }
    expect(saveConfig).toHaveBeenCalledTimes(1);
  });

  it('TASK-013-a RED: returns tunnel-exists-no-creds when tunnel exists but no local credentials found', async () => {
    const { runSetupTunnel } = await import('./setup-tunnel.js');

    const createChild = makeFakeChild();
    const spawnImpl = vi.fn().mockReturnValue(createChild) as unknown as SetupTunnelDeps['spawnImpl'];

    // cert.pem present, but no uuid.json files found
    const fileExists = vi.fn().mockImplementation((p: string) => p.endsWith('cert.pem'));

    // Inject readdirImpl returning empty list
    const readdirImpl = vi.fn().mockResolvedValue([]);

    const saveConfig = vi.fn();
    const deps = makeDeps({ spawnImpl, fileExists, readdirImpl, saveConfig });

    const resultPromise = runSetupTunnel(makeInput(), deps);

    await new Promise<void>((r) => setTimeout(r, 10));
    createChild._endAndExit(1, '', 'Error: tunnel with name my-tunnel already exists');

    const result = await resultPromise;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('tunnel-exists-no-creds');
      expect(result.message).toContain('cloudflared tunnel delete');
    }
    expect(saveConfig).not.toHaveBeenCalled();
  });
});

// ── TASK-014: DNS routing ─────────────────────────────────────────────────────

describe('runSetupTunnel — TASK-014: DNS routing', () => {
  it('TASK-014-a RED: dnsRouted=true when route dns exits 0', async () => {
    const { runSetupTunnel } = await import('./setup-tunnel.js');

    const createChild = makeFakeChild();
    const dnsChild = makeFakeChild();
    const spawnImpl = makeSequentialSpawn(createChild, dnsChild);
    const fileExists = vi.fn().mockReturnValue(true);

    const deps = makeDeps({ spawnImpl, fileExists });
    const resultPromise = runSetupTunnel(makeInput(), deps);

    await new Promise<void>((r) => setTimeout(r, 10));
    createChild._endAndExit(0, HAPPY_CREATE_JSON);

    await new Promise<void>((r) => setTimeout(r, 10));
    dnsChild._endAndExit(0);

    const result = await resultPromise;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dnsRouted).toBe(true);
      expect(result.dnsManualCommand).toBeUndefined();
    }
  });

  it('TASK-014-a RED: dnsRouted=false with dnsManualCommand when route dns exits non-zero (continues, ok:true)', async () => {
    const { runSetupTunnel } = await import('./setup-tunnel.js');

    const createChild = makeFakeChild();
    const dnsChild = makeFakeChild();
    const spawnImpl = makeSequentialSpawn(createChild, dnsChild);
    const fileExists = vi.fn().mockReturnValue(true);
    const saveConfig = vi.fn().mockResolvedValue(undefined);

    const deps = makeDeps({ spawnImpl, fileExists, saveConfig });
    const resultPromise = runSetupTunnel(makeInput(), deps);

    await new Promise<void>((r) => setTimeout(r, 10));
    createChild._endAndExit(0, HAPPY_CREATE_JSON);

    await new Promise<void>((r) => setTimeout(r, 10));
    dnsChild._endAndExit(1, '', 'zone not found');

    const result = await resultPromise;

    // DNS failure should NOT abort — config still written, ok:true returned
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dnsRouted).toBe(false);
      expect(result.dnsManualCommand).toBe(
        'cloudflared tunnel route dns my-tunnel shots.example.com',
      );
    }
    // Config WAS written
    expect(saveConfig).toHaveBeenCalledTimes(1);
  });

  it('TASK-014-a RED: --skipDns skips route dns spawn and includes dnsManualCommand hint', async () => {
    const { runSetupTunnel } = await import('./setup-tunnel.js');

    const createChild = makeFakeChild();
    const spawnImpl = vi.fn().mockReturnValue(createChild) as unknown as SetupTunnelDeps['spawnImpl'];
    const fileExists = vi.fn().mockReturnValue(true);
    const saveConfig = vi.fn().mockResolvedValue(undefined);

    const deps = makeDeps({ spawnImpl, fileExists, saveConfig });
    const resultPromise = runSetupTunnel(makeInput({ skipDns: true }), deps);

    await new Promise<void>((r) => setTimeout(r, 10));
    createChild._endAndExit(0, HAPPY_CREATE_JSON);

    const result = await resultPromise;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dnsRouted).toBe(false);
      expect(result.dnsManualCommand).toBe(
        'cloudflared tunnel route dns my-tunnel shots.example.com',
      );
    }
    // Only 1 spawn (create); no dns spawn
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });
});

// ── TASK-015: config write ────────────────────────────────────────────────────

describe('runSetupTunnel — TASK-015: config write', () => {
  it('TASK-015-a RED: writes all wizard fields to config (tunnelMode, name, hostname, credentialsFile, localPort)', async () => {
    const { runSetupTunnel } = await import('./setup-tunnel.js');

    const createChild = makeFakeChild();
    const dnsChild = makeFakeChild();
    const spawnImpl = makeSequentialSpawn(createChild, dnsChild);
    const fileExists = vi.fn().mockReturnValue(true);
    const savedConfigs: Config[] = [];
    const saveConfig = vi.fn().mockImplementation(async (c: Config) => {
      savedConfigs.push({ ...c });
    });
    const ensureConfig = vi.fn().mockResolvedValue(BASE_CONFIG);

    const deps = makeDeps({ spawnImpl, fileExists, saveConfig, ensureConfig });
    const resultPromise = runSetupTunnel(makeInput({ port: 8080 }), deps);

    await new Promise<void>((r) => setTimeout(r, 10));
    createChild._endAndExit(0, HAPPY_CREATE_JSON);

    await new Promise<void>((r) => setTimeout(r, 10));
    dnsChild._endAndExit(0);

    const result = await resultPromise;

    expect(result.ok).toBe(true);
    expect(saveConfig).toHaveBeenCalledTimes(1);

    const saved = savedConfigs[0]!;
    expect(saved.tunnelMode).toBe('named');
    expect(saved.tunnelName).toBe('my-tunnel');
    expect(saved.tunnelHostname).toBe('shots.example.com');
    expect(saved.tunnelCredentialsFile).toBe(
      '/fake/.cloudflared/c0ffee01-1111-2222-3333-444444444444.json',
    );
    expect(saved.tunnelLocalPort).toBe(8080);
  });

  it('TASK-015-a RED: merge preserves existing apiKey from config', async () => {
    const { runSetupTunnel } = await import('./setup-tunnel.js');

    const createChild = makeFakeChild();
    const dnsChild = makeFakeChild();
    const spawnImpl = makeSequentialSpawn(createChild, dnsChild);
    const fileExists = vi.fn().mockReturnValue(true);
    const existingConfig: Config = {
      apiKey: 'sk_original_key_' + 'z'.repeat(48),
      createdAt: '2025-12-01T00:00:00.000Z',
    };
    const savedConfigs: Config[] = [];
    const saveConfig = vi.fn().mockImplementation(async (c: Config) => {
      savedConfigs.push({ ...c });
    });
    const ensureConfig = vi.fn().mockResolvedValue(existingConfig);

    const deps = makeDeps({ spawnImpl, fileExists, saveConfig, ensureConfig });
    const resultPromise = runSetupTunnel(makeInput(), deps);

    await new Promise<void>((r) => setTimeout(r, 10));
    createChild._endAndExit(0, HAPPY_CREATE_JSON);

    await new Promise<void>((r) => setTimeout(r, 10));
    dnsChild._endAndExit(0);

    const result = await resultPromise;

    expect(result.ok).toBe(true);
    const saved = savedConfigs[0]!;
    expect(saved.apiKey).toBe(existingConfig.apiKey);
    expect(saved.createdAt).toBe(existingConfig.createdAt);
  });

  it('TASK-015-a RED: idempotent re-run merges without duplicate keys', async () => {
    const { runSetupTunnel } = await import('./setup-tunnel.js');

    // Second run: create returns "already exists", scan finds credentials
    const credFile = '/fake/.cloudflared/c0ffee01-1111-2222-3333-444444444444.json';
    const credFileContents = JSON.stringify({
      TunnelID: 'c0ffee01-1111-2222-3333-444444444444',
      TunnelName: 'my-tunnel',
    });

    const createChild = makeFakeChild();
    const dnsChild = makeFakeChild();
    const spawnImpl = makeSequentialSpawn(createChild, dnsChild);

    const fileExists = vi.fn().mockImplementation((p: string) => {
      return p.endsWith('cert.pem') || p === credFile;
    });
    const readFileUtf8 = vi.fn().mockImplementation(async (p: string) => {
      if (p === credFile) return credFileContents;
      throw new Error(`unexpected: ${p}`);
    });
    const readdirImpl = vi.fn().mockResolvedValue(['c0ffee01-1111-2222-3333-444444444444.json']);

    // Existing config already has wizard fields from first run
    const existingConfig: Config = {
      apiKey: 'sk_' + 'a'.repeat(64),
      createdAt: '2026-01-01T00:00:00.000Z',
      tunnelMode: 'named',
      tunnelName: 'my-tunnel',
      tunnelHostname: 'shots.example.com',
      tunnelCredentialsFile: credFile,
      tunnelLocalPort: 7331,
    };
    const savedConfigs: Config[] = [];
    const saveConfig = vi.fn().mockImplementation(async (c: Config) => {
      savedConfigs.push({ ...c });
    });
    const ensureConfig = vi.fn().mockResolvedValue(existingConfig);

    const deps = makeDeps({ spawnImpl, fileExists, readFileUtf8, readdirImpl, saveConfig, ensureConfig });
    const resultPromise = runSetupTunnel(makeInput(), deps);

    await new Promise<void>((r) => setTimeout(r, 10));
    createChild._endAndExit(1, '', 'Error: tunnel with name my-tunnel already exists');

    await new Promise<void>((r) => setTimeout(r, 10));
    dnsChild._endAndExit(0);

    const result = await resultPromise;

    expect(result.ok).toBe(true);
    const saved = savedConfigs[0]!;
    // No duplicate keys — just a plain object with the merged values
    const keys = Object.keys(saved);
    const tunnelModeCount = keys.filter((k) => k === 'tunnelMode').length;
    expect(tunnelModeCount).toBe(1);
    // Fields preserved correctly
    expect(saved.apiKey).toBe(existingConfig.apiKey);
    expect(saved.tunnelMode).toBe('named');
  });
});

// ── Hostname validation (early guard) ────────────────────────────────────────

describe('runSetupTunnel — hostname validation', () => {
  it('returns invalid-hostname early (before any spawn) when hostname has a scheme', async () => {
    const { runSetupTunnel } = await import('./setup-tunnel.js');

    const spawnImpl = vi.fn() as unknown as SetupTunnelDeps['spawnImpl'];
    const deps = makeDeps({ spawnImpl });

    const result = await runSetupTunnel(makeInput({ hostname: 'http://shots.example.com' }), deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid-hostname');
    }
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});

// ── parseTunnelCreateOutput unit tests ───────────────────────────────────────

describe('parseTunnelCreateOutput', () => {
  it('parses uuid and credentials_file from canonical JSON', async () => {
    const { parseTunnelCreateOutput } = await import('./setup-tunnel.js');

    const json = JSON.stringify({
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      name: 'test',
      credentials_file: '/home/user/.cloudflared/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json',
    });
    const result = parseTunnelCreateOutput(json);
    expect(result.uuid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(result.credentialsFile).toBe(
      '/home/user/.cloudflared/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json',
    );
  });

  it('returns credentialsFile=undefined when credentials_file absent', async () => {
    const { parseTunnelCreateOutput } = await import('./setup-tunnel.js');

    const json = JSON.stringify({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'test' });
    const result = parseTunnelCreateOutput(json);
    expect(result.credentialsFile).toBeUndefined();
  });

  it('throws when output contains no JSON', async () => {
    const { parseTunnelCreateOutput } = await import('./setup-tunnel.js');
    expect(() => parseTunnelCreateOutput('some log lines without json')).toThrow();
  });

  it('handles log lines before JSON (defensive)', async () => {
    const { parseTunnelCreateOutput } = await import('./setup-tunnel.js');
    const output =
      '2024-01-01T00:00:00Z INF Starting...\n' +
      JSON.stringify({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'test' });
    const result = parseTunnelCreateOutput(output);
    expect(result.uuid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });
});

// ── FIX-2: Fallback credentials path existence check ─────────────────────────

describe('runSetupTunnel — FIX-2: fallback credentials path existence check', () => {
  it('FIX-2 RED: returns error when JSON has no credentials_file and fallback path does not exist', async () => {
    const { runSetupTunnel } = await import('./setup-tunnel.js');

    const jsonWithoutCreds = JSON.stringify({
      id: 'deadbeef-aaaa-bbbb-cccc-dddddddddddd',
      name: 'my-tunnel',
      // No credentials_file field → fallback path is <cloudflaredHome>/<uuid>.json
    });

    const createChild = makeFakeChild();
    const dnsChild = makeFakeChild();
    const spawnImpl = makeSequentialSpawn(createChild, dnsChild);

    // cert.pem exists but the fallback credentials file does NOT exist
    const fileExists = vi.fn().mockImplementation((p: string) => {
      return p.endsWith('cert.pem'); // only cert.pem present
    });

    const deps = makeDeps({ spawnImpl, fileExists });
    const resultPromise = runSetupTunnel(makeInput(), deps);

    await new Promise<void>((r) => setTimeout(r, 10));
    createChild._endAndExit(0, jsonWithoutCreds);

    const result = await resultPromise;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/Could not locate credentials file/i);
      expect(result.message).toContain('deadbeef-aaaa-bbbb-cccc-dddddddddddd');
      // JD R2 (C3): dedicated reason so callers can distinguish from a parse failure
      expect(result.reason).toBe('creds-not-found');
    }
    // DNS spawn should NOT have been attempted
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it('FIX-2 GREEN: succeeds when JSON has no credentials_file but fallback path exists', async () => {
    const { runSetupTunnel } = await import('./setup-tunnel.js');

    const uuid = 'deadbeef-aaaa-bbbb-cccc-dddddddddddd';
    const jsonWithoutCreds = JSON.stringify({
      id: uuid,
      name: 'my-tunnel',
      // No credentials_file field
    });

    const createChild = makeFakeChild();
    const dnsChild = makeFakeChild();
    const spawnImpl = makeSequentialSpawn(createChild, dnsChild);
    const expectedFallbackPath = `/fake/.cloudflared/${uuid}.json`;

    const fileExists = vi.fn().mockImplementation((p: string) => {
      return p.endsWith('cert.pem') || p === expectedFallbackPath;
    });

    const deps = makeDeps({ spawnImpl, fileExists });
    const resultPromise = runSetupTunnel(makeInput(), deps);

    await new Promise<void>((r) => setTimeout(r, 10));
    createChild._endAndExit(0, jsonWithoutCreds);

    await new Promise<void>((r) => setTimeout(r, 10));
    dnsChild._endAndExit(0);

    const result = await resultPromise;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.uuid).toBe(uuid);
      expect(result.credentialsFile).toBe(expectedFallbackPath);
    }
  });
});
