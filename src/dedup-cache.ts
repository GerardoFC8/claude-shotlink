/**
 * dedup-cache.ts
 *
 * Client-side sha256 → URL memo for the PostToolUse hook.
 * Prevents re-uploading the same screenshot in the same session.
 *
 * On-disk format:
 *   { "version": 1, "entries": { "<sha256-hex>": { "url": "...", "at": <epoch ms> } } }
 *
 * Eviction rules (applied on load):
 *   - TTL: entries older than 24h are dropped.
 *   - Hard cap: at most 500 entries, pruned by oldest `at` first.
 *
 * File permissions: 0o600.
 */
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { writeAtomic } from './atomic-write.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ENTRIES = 500;
const FILE_VERSION = 1;

/**
 * Default absolute path to the dedup cache file.
 * Exported so callers (e.g., the reconnect path in cli.ts) can reference it
 * without constructing the path themselves.
 */
export const DEDUP_PATH: string = join(homedir(), '.claude-shotlink', 'dedup.json');

// ── Disk shape ────────────────────────────────────────────────────────────────

interface DiskEntry {
  url: string;
  at: number; // epoch ms
}

interface DiskFormat {
  version: number;
  entries: Record<string, DiskEntry>;
}

// ── DedupCache class ──────────────────────────────────────────────────────────

export class DedupCache {
  private map: Map<string, { url: string; at: number }> = new Map();

  constructor(private readonly filePath: string) {}

  /**
   * Load (and evict) entries from disk. Safe to call when file does not exist
   * or contains corrupt JSON — both cases result in an empty cache.
   */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      // File not found or unreadable → start empty
      this.map = new Map();
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt JSON → start empty
      this.map = new Map();
      return;
    }

    if (!isDiskFormat(parsed)) {
      this.map = new Map();
      return;
    }

    const now = Date.now();
    const map = new Map<string, { url: string; at: number }>();

    for (const [sha, entry] of Object.entries(parsed.entries)) {
      // TTL eviction
      if (now - entry.at > TTL_MS) continue;
      map.set(sha, { url: entry.url, at: entry.at });
    }

    // LRU cap: keep the 500 newest by `at`
    if (map.size > MAX_ENTRIES) {
      const sorted = [...map.entries()].sort((a, b) => b[1].at - a[1].at);
      this.map = new Map(sorted.slice(0, MAX_ENTRIES));
    } else {
      this.map = map;
    }
  }

  /** Look up a sha256 hex string. Returns the URL or null on miss. */
  lookup(sha: string): string | null {
    return this.map.get(sha)?.url ?? null;
  }

  /** Record a new sha256 → URL mapping in memory. Call `flush()` to persist. */
  remember(sha: string, url: string): void {
    this.map.set(sha, { url, at: Date.now() });
  }

  /**
   * Delete the on-disk cache file and reset the in-memory map.
   * Used by the quick-mode reconnect path to invalidate the cache when a new
   * tunnel URL is established (old URLs will generate duplicate dedup hits).
   *
   * Safe to call when the file does not exist — no-ops silently.
   */
  async purge(): Promise<void> {
    // Reset in-memory map immediately
    this.map = new Map();

    // Delete file — ignore ENOENT (not present is fine)
    try {
      await unlink(this.filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
    }
  }

  /** Persist the current in-memory cache to disk using an atomic write (mode 0o600). */
  async flush(): Promise<void> {
    const entries: Record<string, DiskEntry> = {};
    for (const [sha, value] of this.map.entries()) {
      entries[sha] = { url: value.url, at: value.at };
    }

    const disk: DiskFormat = { version: FILE_VERSION, entries };
    const json = JSON.stringify(disk, null, 2);

    // Atomic write: write to tmp then rename so a kill mid-write never corrupts
    await writeAtomic(this.filePath, json, { mode: 0o600, tmpPrefix: '.dedup-tmp-' });
  }
}

// ── Type guard ────────────────────────────────────────────────────────────────

function isDiskFormat(value: unknown): value is DiskFormat {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['version'] !== 'number') return false;
  if (typeof v['entries'] !== 'object' || v['entries'] === null) return false;
  return true;
}
