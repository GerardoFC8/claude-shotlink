/**
 * pid.test.ts
 *
 * Tests for src/pid.ts — PID file write/read/delete/alive detection.
 * Uses real temp directories (no fs mocking).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

describe('PID_PATH', () => {
  it('is under os.homedir()/.claude-shotlink/', async () => {
    const { PID_PATH } = await import('./pid.js');
    expect(PID_PATH).toContain(homedir());
    expect(PID_PATH).toContain('.claude-shotlink');
    expect(PID_PATH).toMatch(/relay\.pid$/);
  });
});

describe('writePidFile / readPidFile roundtrip', () => {
  let tempDir: string;
  let pidPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pid-test-'));
    pidPath = join(tempDir, 'relay.pid');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('write then read returns same meta', async () => {
    const { writePidFile, readPidFile } = await import('./pid.js');
    const meta = {
      pid: process.pid,
      port: 3000,
      tunnelUrl: 'https://abc.trycloudflare.com',
      startedAt: new Date().toISOString(),
    };

    await writePidFile(meta, pidPath);
    const result = await readPidFile(pidPath);

    expect(result).not.toBeNull();
    expect(result!.pid).toBe(meta.pid);
    expect(result!.port).toBe(meta.port);
    expect(result!.tunnelUrl).toBe(meta.tunnelUrl);
    expect(result!.startedAt).toBe(meta.startedAt);
  });

  it('write with tunnelUrl null roundtrips correctly', async () => {
    const { writePidFile, readPidFile } = await import('./pid.js');
    const meta = {
      pid: process.pid,
      port: 9000,
      tunnelUrl: null,
      startedAt: new Date().toISOString(),
    };

    await writePidFile(meta, pidPath);
    const result = await readPidFile(pidPath);

    expect(result).not.toBeNull();
    expect(result!.tunnelUrl).toBeNull();
  });

  it('writes file with mode 0o600', async () => {
    const { writePidFile } = await import('./pid.js');
    const meta = {
      pid: process.pid,
      port: 3000,
      tunnelUrl: null,
      startedAt: new Date().toISOString(),
    };

    await writePidFile(meta, pidPath);
    const stats = statSync(pidPath);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('readPidFile returns null when file does not exist', async () => {
    const { readPidFile } = await import('./pid.js');
    const result = await readPidFile(join(tempDir, 'nonexistent.pid'));
    expect(result).toBeNull();
  });

  it('readPidFile returns null and deletes file when PID is not alive (stale)', async () => {
    const { writePidFile, readPidFile } = await import('./pid.js');
    // PID 999999999 is virtually guaranteed to not exist
    const stalePid = 999999999;
    const meta = {
      pid: stalePid,
      port: 3000,
      tunnelUrl: null,
      startedAt: new Date().toISOString(),
    };

    await writePidFile(meta, pidPath);
    expect(existsSync(pidPath)).toBe(true);

    const stderrSpy = vi.spyOn(process.stderr, 'write');
    const result = await readPidFile(pidPath);

    expect(result).toBeNull();
    expect(existsSync(pidPath)).toBe(false);
    // Warning must be printed to stderr
    const stderrOutput = stderrSpy.mock.calls
      .map((args) => String(args[0] ?? ''))
      .join('');
    expect(stderrOutput).toMatch(/[Ss]tale/i);
    stderrSpy.mockRestore();
  });

  it('readPidFile returns meta when PID is alive (using process.pid)', async () => {
    const { writePidFile, readPidFile } = await import('./pid.js');
    const meta = {
      pid: process.pid, // current process is definitely alive
      port: 4000,
      tunnelUrl: null,
      startedAt: new Date().toISOString(),
    };

    await writePidFile(meta, pidPath);
    const result = await readPidFile(pidPath);

    expect(result).not.toBeNull();
    expect(result!.pid).toBe(process.pid);
  });
});

describe('deletePidFile', () => {
  let tempDir: string;
  let pidPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pid-test-'));
    pidPath = join(tempDir, 'relay.pid');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('deletes the file when it exists', async () => {
    const { writePidFile, deletePidFile } = await import('./pid.js');
    await writePidFile(
      { pid: process.pid, port: 3000, tunnelUrl: null, startedAt: new Date().toISOString() },
      pidPath
    );
    expect(existsSync(pidPath)).toBe(true);

    await deletePidFile(pidPath);
    expect(existsSync(pidPath)).toBe(false);
  });

  it('no-ops silently when file does not exist', async () => {
    const { deletePidFile } = await import('./pid.js');
    // Should not throw
    await expect(deletePidFile(join(tempDir, 'nonexistent.pid'))).resolves.toBeUndefined();
  });
});

describe('isProcessAlive', () => {
  it('returns true for the current process pid', async () => {
    const { isProcessAlive } = await import('./pid.js');
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('returns false for a very large pid that cannot exist', async () => {
    const { isProcessAlive } = await import('./pid.js');
    expect(isProcessAlive(999999999)).toBe(false);
  });
});

// ── FIX-2 regression: writePidFile leaves no .tmp-* sibling on success ────────

describe('writePidFile — FIX-2: no temp file remains after successful write', () => {
  let tempDir: string;
  let pidPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pid-atomic-test-'));
    pidPath = join(tempDir, 'relay.pid');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('no .pid-tmp-* sibling file remains after successful writePidFile', async () => {
    const { writePidFile } = await import('./pid.js');
    const meta = {
      pid: process.pid,
      port: 3000,
      tunnelUrl: null,
      startedAt: new Date().toISOString(),
    };

    await writePidFile(meta, pidPath);

    const files = (await import('node:fs/promises')).readdir(tempDir);
    const siblings = (await files).filter((f) => f.startsWith('.pid-tmp-'));
    expect(siblings).toHaveLength(0);
    expect(existsSync(pidPath)).toBe(true);
  });
});
