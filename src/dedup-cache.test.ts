import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';

const TWENTY_FIVE_HOURS_MS = 25 * 60 * 60 * 1000;

describe('DedupCache', () => {
  let tempDir: string;
  let cachePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dedup-test-'));
    cachePath = join(tempDir, 'dedup.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('lookup returns null for unknown sha256', async () => {
    const { DedupCache } = await import('./dedup-cache.js');
    const cache = new DedupCache(cachePath);
    await cache.load();
    expect(cache.lookup('deadbeef')).toBeNull();
  });

  it('remember + lookup round-trips sha256 → url', async () => {
    const { DedupCache } = await import('./dedup-cache.js');
    const cache = new DedupCache(cachePath);
    await cache.load();
    cache.remember('abc123', 'https://example.com/f/x');
    expect(cache.lookup('abc123')).toBe('https://example.com/f/x');
  });

  it('flush writes to disk; new instance load() recovers entries', async () => {
    const { DedupCache } = await import('./dedup-cache.js');

    const cache1 = new DedupCache(cachePath);
    await cache1.load();
    cache1.remember('sha1', 'https://url1');
    await cache1.flush();

    const cache2 = new DedupCache(cachePath);
    await cache2.load();
    expect(cache2.lookup('sha1')).toBe('https://url1');
  });

  it('load treats missing file as empty cache', async () => {
    const { DedupCache } = await import('./dedup-cache.js');
    const cache = new DedupCache(join(tempDir, 'nonexistent.json'));
    await cache.load(); // should not throw
    expect(cache.lookup('anything')).toBeNull();
  });

  it('load treats corrupt JSON as empty cache (no throw)', async () => {
    const { DedupCache } = await import('./dedup-cache.js');
    await writeFile(cachePath, 'NOT JSON {{{', 'utf8');
    const cache = new DedupCache(cachePath);
    await cache.load(); // should not throw
    expect(cache.lookup('anything')).toBeNull();
  });

  it('TTL eviction: entries older than 24h are pruned on load()', async () => {
    const { DedupCache } = await import('./dedup-cache.js');

    const oldAt = Date.now() - TWENTY_FIVE_HOURS_MS;
    const freshAt = Date.now();

    const disk = {
      version: 1,
      entries: {
        oldSha: { url: 'https://old', at: oldAt },
        freshSha: { url: 'https://fresh', at: freshAt },
      },
    };
    await writeFile(cachePath, JSON.stringify(disk), 'utf8');

    const cache = new DedupCache(cachePath);
    await cache.load();

    expect(cache.lookup('oldSha')).toBeNull();
    expect(cache.lookup('freshSha')).toBe('https://fresh');
  });

  it('cap eviction: loading a file with 501 entries keeps only the 500 newest by at', async () => {
    const { DedupCache } = await import('./dedup-cache.js');

    const entries: Record<string, { url: string; at: number }> = {};
    const now = Date.now();
    // Create 501 entries with staggered timestamps
    for (let i = 0; i < 501; i++) {
      entries[`sha${i}`] = { url: `https://url/${i}`, at: now + i };
    }
    // sha0 has the oldest 'at', sha500 has the newest
    const disk = { version: 1, entries };
    await writeFile(cachePath, JSON.stringify(disk), 'utf8');

    const cache = new DedupCache(cachePath);
    await cache.load();

    // sha0 (oldest) should be evicted
    expect(cache.lookup('sha0')).toBeNull();
    // sha500 (newest) should be present
    expect(cache.lookup('sha500')).toBe('https://url/500');
    // Exactly 500 entries remain
    let count = 0;
    for (let i = 0; i < 501; i++) {
      if (cache.lookup(`sha${i}`) !== null) count++;
    }
    expect(count).toBe(500);
  });

  it('flush writes file with mode 0o600', async () => {
    const { DedupCache } = await import('./dedup-cache.js');
    const cache = new DedupCache(cachePath);
    await cache.load();
    cache.remember('sha1', 'https://url');
    await cache.flush();

    const { stat } = await import('node:fs/promises');
    const stats = await stat(cachePath);
    // mode & 0o777 gives permission bits
    const perms = stats.mode & 0o777;
    expect(perms).toBe(0o600);
  });

  it('on-disk format has version:1 and entries object', async () => {
    const { DedupCache } = await import('./dedup-cache.js');
    const cache = new DedupCache(cachePath);
    await cache.load();
    cache.remember('shaX', 'https://url/x');
    await cache.flush();

    const raw = await readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as { version: number; entries: Record<string, { url: string; at: number }> };
    expect(parsed.version).toBe(1);
    expect(typeof parsed.entries).toBe('object');
    expect(parsed.entries['shaX']?.url).toBe('https://url/x');
    expect(typeof parsed.entries['shaX']?.at).toBe('number');
  });
});

// ── SUSPECT-3 regression: flush is atomic (no .tmp files left behind) ─────────

describe('DedupCache — SUSPECT-3: flush is atomic', () => {
  let tempDir: string;
  let cachePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dedup-atomic-'));
    cachePath = join(tempDir, 'dedup.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('no .dedup-tmp-* files remain after successful flush', async () => {
    const { DedupCache } = await import('./dedup-cache.js');
    const cache = new DedupCache(cachePath);
    await cache.load();
    cache.remember('sha1', 'https://url1');
    cache.remember('sha2', 'https://url2');
    await cache.flush();

    const files = await readdir(tempDir);
    const tmpFiles = files.filter((f) => f.startsWith('.dedup-tmp-'));
    expect(tmpFiles).toHaveLength(0);
    // Main file must exist
    expect(existsSync(cachePath)).toBe(true);
  });

  it('a partial .tmp file does not corrupt the main cache on load', async () => {
    const { DedupCache } = await import('./dedup-cache.js');

    // Seed a valid cache
    const cache1 = new DedupCache(cachePath);
    await cache1.load();
    cache1.remember('goodSha', 'https://good-url');
    await cache1.flush();

    // Simulate a crashed mid-write: write corrupt JSON to a .tmp file
    // (the real atomic write would rename this — but we left it behind)
    await writeFile(join(tempDir, '.dedup-tmp-deadbeef'), '{ corrupt', 'utf8');

    // Load should still read the correct main file, not the tmp file
    const cache2 = new DedupCache(cachePath);
    await cache2.load();
    expect(cache2.lookup('goodSha')).toBe('https://good-url');
  });
});
