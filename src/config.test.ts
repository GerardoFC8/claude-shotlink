/**
 * config.test.ts
 *
 * Tests for Config schema extension (CA-1) and config loader/writer.
 * Written in strict TDD: RED first, then GREEN via implementation changes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'config-test-'));
}

async function writeCfg(dir: string, obj: unknown): Promise<string> {
  const p = join(dir, 'config.json');
  await writeFile(p, JSON.stringify(obj, null, 2), 'utf8');
  return p;
}

// ── TASK-002-a: Config schema extension ──────────────────────────────────────

describe('loadConfigFrom — CA-1: v0.1 file reads correctly with new optional fields', () => {
  it('returns tunnelMode/tunnelName/tunnelHostname as undefined for v0.1 file', async () => {
    const dir = await makeTempDir();
    try {
      const p = await writeCfg(dir, { apiKey: 'sk_abc', createdAt: '2026-01-01T00:00:00Z' });
      const { loadConfigFrom } = await import('./config.js');
      const cfg = await loadConfigFrom(p);
      expect(cfg.tunnelMode).toBeUndefined();
      expect(cfg.tunnelName).toBeUndefined();
      expect(cfg.tunnelHostname).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns correct typed values for a v0.2 file with all tunnel fields', async () => {
    const dir = await makeTempDir();
    try {
      const p = await writeCfg(dir, {
        apiKey: 'sk_abc',
        createdAt: '2026-01-01T00:00:00Z',
        tunnelMode: 'named',
        tunnelName: 'my-tunnel',
        tunnelHostname: 'shots.example.com',
      });
      const { loadConfigFrom } = await import('./config.js');
      const cfg = await loadConfigFrom(p);
      expect(cfg.tunnelMode).toBe('named');
      expect(cfg.tunnelName).toBe('my-tunnel');
      expect(cfg.tunnelHostname).toBe('shots.example.com');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns correct typed values for tunnelMode: "quick"', async () => {
    const dir = await makeTempDir();
    try {
      const p = await writeCfg(dir, {
        apiKey: 'sk_abc',
        createdAt: '2026-01-01T00:00:00Z',
        tunnelMode: 'quick',
      });
      const { loadConfigFrom } = await import('./config.js');
      const cfg = await loadConfigFrom(p);
      expect(cfg.tunnelMode).toBe('quick');
      expect(cfg.tunnelName).toBeUndefined();
      expect(cfg.tunnelHostname).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid tunnelMode value with descriptive error', async () => {
    const dir = await makeTempDir();
    try {
      const p = await writeCfg(dir, {
        apiKey: 'sk_abc',
        createdAt: '2026-01-01T00:00:00Z',
        tunnelMode: 'weird',
      });
      const { loadConfigFrom } = await import('./config.js');
      await expect(loadConfigFrom(p)).rejects.toThrow(/tunnelMode/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects unknown top-level field with descriptive error', async () => {
    const dir = await makeTempDir();
    try {
      const p = await writeCfg(dir, {
        apiKey: 'sk_abc',
        createdAt: '2026-01-01T00:00:00Z',
        unknownField: 'value',
      });
      const { loadConfigFrom } = await import('./config.js');
      await expect(loadConfigFrom(p)).rejects.toThrow(/Unknown field in config/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── TASK-003-a: Config loader edge cases ──────────────────────────────────────

describe('loadConfigFrom — CA-1: edge cases (ENOENT, invalid JSON, invalid shape)', () => {
  it('propagates ENOENT when file is absent', async () => {
    const dir = await makeTempDir();
    try {
      const { loadConfigFrom } = await import('./config.js');
      await expect(loadConfigFrom(join(dir, 'nonexistent.json'))).rejects.toThrow(/ENOENT/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed JSON with descriptive error containing the path', async () => {
    const dir = await makeTempDir();
    try {
      const p = join(dir, 'config.json');
      await writeFile(p, '{ bad json {{', 'utf8');
      const { loadConfigFrom } = await import('./config.js');
      await expect(loadConfigFrom(p)).rejects.toThrow(p);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects tunnelMode "weird" with message about expected values', async () => {
    const dir = await makeTempDir();
    try {
      const p = await writeCfg(dir, {
        apiKey: 'sk_abc',
        createdAt: '2026-01-01T00:00:00Z',
        tunnelMode: 'weird',
      });
      const { loadConfigFrom } = await import('./config.js');
      await expect(loadConfigFrom(p)).rejects.toThrow(/'quick' or 'named'/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects unknown top-level key naming the specific field', async () => {
    const dir = await makeTempDir();
    try {
      const p = await writeCfg(dir, {
        apiKey: 'sk_abc',
        createdAt: '2026-01-01T00:00:00Z',
        badField: 'oops',
      });
      const { loadConfigFrom } = await import('./config.js');
      await expect(loadConfigFrom(p)).rejects.toThrow(/badField/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects tunnelHostname with invalid shape (has scheme)', async () => {
    const dir = await makeTempDir();
    try {
      const p = await writeCfg(dir, {
        apiKey: 'sk_abc',
        createdAt: '2026-01-01T00:00:00Z',
        tunnelMode: 'named',
        tunnelName: 'x',
        tunnelHostname: 'http://shots.example.com',
      });
      const { loadConfigFrom } = await import('./config.js');
      await expect(loadConfigFrom(p)).rejects.toThrow(/tunnelHostname/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── TASK-004-a: saveConfig atomic write + round-trip ─────────────────────────

describe('saveConfig — CA-1: atomic write, round-trip, undefined fields dropped', () => {
  it('round-trip preserves existing fields and new tunnel fields', async () => {
    const dir = await makeTempDir();
    try {
      const configPath = join(dir, 'config.json');
      // Write a config with all fields
      const { saveConfig, loadConfigFrom } = await import('./config.js');
      const original = {
        apiKey: 'sk_test',
        createdAt: '2026-01-01T00:00:00Z',
        tunnelMode: 'named' as const,
        tunnelName: 'mytunnel',
        tunnelHostname: 'shots.example.com',
      };
      await saveConfig(original, configPath);
      const result = await loadConfigFrom(configPath);
      expect(result.apiKey).toBe('sk_test');
      expect(result.createdAt).toBe('2026-01-01T00:00:00Z');
      expect(result.tunnelMode).toBe('named');
      expect(result.tunnelName).toBe('mytunnel');
      expect(result.tunnelHostname).toBe('shots.example.com');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('drops undefined fields from persisted JSON', async () => {
    const dir = await makeTempDir();
    try {
      const configPath = join(dir, 'config.json');
      const { saveConfig } = await import('./config.js');
      const cfg = {
        apiKey: 'sk_test',
        createdAt: '2026-01-01T00:00:00Z',
        tunnelMode: undefined,
        tunnelName: undefined,
        tunnelHostname: undefined,
      };
      await saveConfig(cfg as Parameters<typeof saveConfig>[0], configPath);
      const raw = await (await import('node:fs/promises')).readFile(configPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect('tunnelMode' in parsed).toBe(false);
      expect('tunnelName' in parsed).toBe(false);
      expect('tunnelHostname' in parsed).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes with mode 0o600 (atomic write)', async () => {
    const dir = await makeTempDir();
    try {
      const configPath = join(dir, 'config.json');
      const { saveConfig } = await import('./config.js');
      const cfg = {
        apiKey: 'sk_test',
        createdAt: '2026-01-01T00:00:00Z',
      };
      await saveConfig(cfg, configPath);
      const { stat } = await import('node:fs/promises');
      const st = await stat(configPath);
      // mode 0o600 = rw------- → last 9 bits: 0o100600
      expect(st.mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
