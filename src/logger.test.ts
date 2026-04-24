/**
 * logger.test.ts
 *
 * Tests for src/logger.ts — append-only JSONL log writer with rotation and tail.
 * Uses real temp directories (no fs mocking).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync, statSync } from 'node:fs';

describe('appendLog', () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'logger-test-'));
    logPath = join(tempDir, 'log.jsonl');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes a valid JSONL line when enabled', async () => {
    const { appendLog } = await import('./logger.js');
    const rec = {
      timestamp: new Date().toISOString(),
      sha256: 'abcdef1234567890',
      size: 1024,
      status: 'uploaded' as const,
    };

    await appendLog(rec, logPath, true);

    const content = await readFile(logPath, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as typeof rec;
    expect(parsed.sha256).toBe(rec.sha256);
    expect(parsed.size).toBe(rec.size);
    expect(parsed.status).toBe('uploaded');
    expect(typeof parsed.timestamp).toBe('string');
  });

  it('appends — does not overwrite existing lines', async () => {
    const { appendLog } = await import('./logger.js');
    const rec1 = {
      timestamp: new Date().toISOString(),
      sha256: 'sha1111',
      size: 100,
      status: 'uploaded' as const,
    };
    const rec2 = {
      timestamp: new Date().toISOString(),
      sha256: 'sha2222',
      size: 200,
      status: 'deduped' as const,
    };

    await appendLog(rec1, logPath, true);
    await appendLog(rec2, logPath, true);

    const content = await readFile(logPath, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    const p1 = JSON.parse(lines[0]!) as typeof rec1;
    const p2 = JSON.parse(lines[1]!) as typeof rec2;
    expect(p1.sha256).toBe('sha1111');
    expect(p2.sha256).toBe('sha2222');
  });

  it('is a no-op when disabled (enabled = false)', async () => {
    const { appendLog } = await import('./logger.js');
    const rec = {
      timestamp: new Date().toISOString(),
      sha256: 'deadbeef',
      size: 50,
      status: 'uploaded' as const,
    };

    await appendLog(rec, logPath, false);

    expect(existsSync(logPath)).toBe(false);
  });

  it('is a no-op by default (enabled defaults to false)', async () => {
    const { appendLog } = await import('./logger.js');
    const rec = {
      timestamp: new Date().toISOString(),
      sha256: 'deadbeef',
      size: 50,
      status: 'uploaded' as const,
    };

    await appendLog(rec, logPath);

    expect(existsSync(logPath)).toBe(false);
  });

  it('record contains only timestamp, sha256, size, status keys', async () => {
    const { appendLog } = await import('./logger.js');
    const rec = {
      timestamp: new Date().toISOString(),
      sha256: 'aabbcc',
      size: 512,
      status: 'error' as const,
    };

    await appendLog(rec, logPath, true);

    const raw = await readFile(logPath, 'utf8');
    const parsed = JSON.parse(raw.trim()) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['sha256', 'size', 'status', 'timestamp']);
  });

  it('supports optional url field when present', async () => {
    const { appendLog } = await import('./logger.js');
    const rec = {
      timestamp: new Date().toISOString(),
      sha256: 'aabb',
      size: 256,
      status: 'uploaded' as const,
      url: 'https://abc.trycloudflare.com/f/xyz',
    };

    await appendLog(rec, logPath, true);

    const raw = await readFile(logPath, 'utf8');
    const parsed = JSON.parse(raw.trim()) as typeof rec;
    expect(parsed.url).toBe(rec.url);
  });
});

describe('readTail', () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'logger-test-'));
    logPath = join(tempDir, 'log.jsonl');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty array when file does not exist', async () => {
    const { readTail } = await import('./logger.js');
    const lines = await readTail(10, logPath);
    expect(lines).toEqual([]);
  });

  it('returns last N lines from a file', async () => {
    const { readTail } = await import('./logger.js');
    const allLines = ['line1', 'line2', 'line3', 'line4', 'line5'];
    await writeFile(logPath, allLines.join('\n') + '\n', 'utf8');

    const result = await readTail(3, logPath);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe('line3');
    expect(result[1]).toBe('line4');
    expect(result[2]).toBe('line5');
  });

  it('returns all lines when n >= total lines', async () => {
    const { readTail } = await import('./logger.js');
    await writeFile(logPath, 'a\nb\nc\n', 'utf8');

    const result = await readTail(100, logPath);
    expect(result).toHaveLength(3);
  });

  it('returns empty array for empty file', async () => {
    const { readTail } = await import('./logger.js');
    await writeFile(logPath, '', 'utf8');
    const result = await readTail(10, logPath);
    expect(result).toEqual([]);
  });
});

describe('log rotation at 10MB', () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'logger-test-'));
    logPath = join(tempDir, 'log.jsonl');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('rotates when file exceeds 10MB: renames to .1 and writes new entry to fresh file', async () => {
    const { appendLog } = await import('./logger.js');

    // Create a file that is just over 10MB
    const tenMBPlus = 'x'.repeat(10 * 1024 * 1024 + 1);
    await writeFile(logPath, tenMBPlus, 'utf8');

    const rec = {
      timestamp: new Date().toISOString(),
      sha256: 'rotationtest',
      size: 1,
      status: 'uploaded' as const,
    };

    await appendLog(rec, logPath, true);

    // The original file should have been renamed to log.jsonl.1
    const rotatedPath = logPath + '.1';
    expect(existsSync(rotatedPath)).toBe(true);

    // The new log.jsonl should contain only the new entry
    const newContent = await readFile(logPath, 'utf8');
    const lines = newContent.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as { sha256: string };
    expect(parsed.sha256).toBe('rotationtest');

    // The rotated file should contain the old content
    const rotatedContent = await readFile(rotatedPath, 'utf8');
    expect(rotatedContent).toBe(tenMBPlus);
  });

  it('does not rotate when file is under 10MB', async () => {
    const { appendLog } = await import('./logger.js');

    // File just under 10MB
    const underLimit = 'x'.repeat(10 * 1024 * 1024 - 100);
    await writeFile(logPath, underLimit, 'utf8');

    const rec = {
      timestamp: new Date().toISOString(),
      sha256: 'norotation',
      size: 1,
      status: 'uploaded' as const,
    };

    await appendLog(rec, logPath, true);

    expect(existsSync(logPath + '.1')).toBe(false);

    const content = await readFile(logPath, 'utf8');
    expect(content.startsWith('x')).toBe(true);
    expect(content.includes('norotation')).toBe(true);
  });
});

describe('followTail', () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'logger-test-'));
    logPath = join(tempDir, 'log.jsonl');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns an unsubscribe function', async () => {
    const { followTail } = await import('./logger.js');
    const unsubscribe = followTail(() => {}, logPath);
    expect(typeof unsubscribe).toBe('function');
    unsubscribe(); // must not throw
  });

  it('calls onLine when new content is appended to the file', async () => {
    const { followTail, appendLog } = await import('./logger.js');

    // Create the file first
    await writeFile(logPath, '', 'utf8');

    const received: string[] = [];
    const unsubscribe = followTail((line) => received.push(line), logPath);

    // Wait a bit for watcher to start then append
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    const rec = {
      timestamp: new Date().toISOString(),
      sha256: 'followtest',
      size: 1,
      status: 'uploaded' as const,
    };
    await appendLog(rec, logPath, true);

    // Wait for the watcher callback to fire
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    unsubscribe();

    expect(received.length).toBeGreaterThanOrEqual(1);
    const found = received.some((l) => l.includes('followtest'));
    expect(found).toBe(true);
  });
});

// ── SUSPECT-5 regression: followTail works after log rotation ─────────────────

describe('followTail — SUSPECT-5: receives lines after rotation', () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'logger-rotate-'));
    logPath = join(tempDir, 'log.jsonl');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('receives new lines written after file rotation (rename + new file)', async () => {
    const { followTail } = await import('./logger.js');

    // Write initial content (simulate old log)
    await writeFile(logPath, 'old-line-1\n', 'utf8');

    const received: string[] = [];
    const unsubscribe = followTail((line) => received.push(line), logPath);

    // Wait for watcher to initialize
    await new Promise<void>((r) => setTimeout(r, 150));

    // Simulate rotation: rename old file, create fresh log
    await rename(logPath, logPath + '.1');
    await writeFile(logPath, '', 'utf8');

    // Wait for watcher to detect the rotation
    await new Promise<void>((r) => setTimeout(r, 350));

    // Write new content to the fresh file
    await writeFile(logPath, 'new-line-after-rotation\n', 'utf8');

    // Wait for watcher to pick up the new line
    await new Promise<void>((r) => setTimeout(r, 400));
    unsubscribe();

    const found = received.some((l) => l.includes('new-line-after-rotation'));
    expect(found).toBe(true);
  }, 10_000);
});

// ── FIX-1 regression: two followers on same path — unsubscribe one, other stays ─

describe('followTail — FIX-1: unwatchFile(path, listener) only removes the specific listener', () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'logger-fix1-'));
    logPath = join(tempDir, 'log.jsonl');
    await writeFile(logPath, '', 'utf8');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('unsubscribing follower A does not stop follower B from receiving new lines', async () => {
    const { followTail } = await import('./logger.js');

    const receivedA: string[] = [];
    const receivedB: string[] = [];

    const unsubscribeA = followTail((line) => receivedA.push(line), logPath);
    const unsubscribeB = followTail((line) => receivedB.push(line), logPath);

    // Wait for watchers to initialize
    await new Promise<void>((r) => setTimeout(r, 150));

    // Append first line — both should see it
    await writeFile(logPath, 'line-before\n', 'utf8');
    await new Promise<void>((r) => setTimeout(r, 400));

    // Unsubscribe A only
    unsubscribeA();

    // Append second line — only B should see it
    await writeFile(logPath, 'line-before\nline-after\n', 'utf8');
    await new Promise<void>((r) => setTimeout(r, 400));

    unsubscribeB();

    expect(receivedB.some((l) => l.includes('line-after'))).toBe(true);
  }, 10_000);
});
