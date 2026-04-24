import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { AllowedMime } from './magic-number.js';
import { extensionFor } from './magic-number.js';

export const STORAGE_DIR = join(tmpdir(), 'claude-shotlink');
export const ID_REGEX = /^[a-zA-Z0-9]{16}$/;

export interface StoredEntry {
  id: string;
  path: string;
  mimeType: AllowedMime;
  size: number;
  sha256: string;
  createdAt: number;
  expiresAt: number;
}

export interface StoreResult {
  entry: StoredEntry;
  deduped: boolean;
}

export interface StorageOptions {
  ttlMs: number;
  maxTotalBytes: number;
  dir: string;
}

const DEFAULTS: StorageOptions = {
  ttlMs: 4 * 60 * 60 * 1000,
  maxTotalBytes: 100 * 1024 * 1024,
  dir: STORAGE_DIR,
};

export class Storage {
  private readonly byId = new Map<string, StoredEntry>();
  private readonly byHash = new Map<string, string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private totalBytes = 0;
  private readonly options: StorageOptions;

  constructor(options: Partial<StorageOptions> = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  async init(): Promise<void> {
    await mkdir(this.options.dir, { recursive: true });
  }

  async store(buf: Uint8Array, mimeType: AllowedMime): Promise<StoreResult> {
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const existingId = this.byHash.get(sha256);
    if (existingId) {
      const existing = this.byId.get(existingId);
      if (existing && Date.now() < existing.expiresAt) {
        return { entry: existing, deduped: true };
      }
    }

    const id = generateId();
    const ext = extensionFor(mimeType);
    const filePath = join(this.options.dir, `${id}.${ext}`);
    await writeFile(filePath, buf, { mode: 0o600 });

    const now = Date.now();
    const entry: StoredEntry = {
      id,
      path: filePath,
      mimeType,
      size: buf.byteLength,
      sha256,
      createdAt: now,
      expiresAt: now + this.options.ttlMs,
    };

    this.byId.set(id, entry);
    this.byHash.set(sha256, id);
    this.totalBytes += entry.size;

    const timer = setTimeout(() => {
      void this.remove(id);
    }, this.options.ttlMs);
    timer.unref();
    this.timers.set(id, timer);

    await this.evictIfNeeded();

    return { entry, deduped: false };
  }

  async get(id: string): Promise<{ buf: Buffer; entry: StoredEntry } | null> {
    const entry = this.byId.get(id);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      await this.remove(id);
      return null;
    }
    try {
      const buf = await readFile(entry.path);
      return { buf, entry };
    } catch {
      await this.remove(id);
      return null;
    }
  }

  async remove(id: string): Promise<void> {
    const entry = this.byId.get(id);
    if (!entry) return;

    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }

    this.byId.delete(id);
    this.byHash.delete(entry.sha256);
    this.totalBytes -= entry.size;

    try {
      if (existsSync(entry.path)) {
        await unlink(entry.path);
      }
    } catch {
      // file may already be gone — ignore
    }
  }

  async shutdown(): Promise<void> {
    const ids = [...this.byId.keys()];
    for (const id of ids) {
      await this.remove(id);
    }
  }

  stats(): { entries: number; totalBytes: number } {
    return {
      entries: this.byId.size,
      totalBytes: this.totalBytes,
    };
  }

  private async evictIfNeeded(): Promise<void> {
    while (this.totalBytes > this.options.maxTotalBytes) {
      const entries = [...this.byId.values()].sort((a, b) => a.createdAt - b.createdAt);
      const oldest = entries[0];
      if (!oldest) break;
      await this.remove(oldest.id);
    }
  }
}

function generateId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = randomBytes(16);
  let id = '';
  for (let i = 0; i < 16; i++) {
    const byte = bytes[i] ?? 0;
    id += alphabet.charAt(byte % alphabet.length);
  }
  return id;
}
