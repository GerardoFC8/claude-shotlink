import { describe, it, expect, vi } from 'vitest';
import type { FsScan, Candidate, HookPayload } from './hook-detect.js';

// ── isScreenshotPath ──────────────────────────────────────────────────────────

describe('isScreenshotPath', () => {
  it('matches test-results/ paths with image ext', async () => {
    const { isScreenshotPath } = await import('./hook-detect.js');
    expect(isScreenshotPath('test-results/foo.png')).toBe(true);
    expect(isScreenshotPath('/abs/test-results/bar.jpeg')).toBe(true);
  });

  it('matches screenshots/ paths with image ext', async () => {
    const { isScreenshotPath } = await import('./hook-detect.js');
    expect(isScreenshotPath('screenshots/shot.webp')).toBe(true);
  });

  it('matches .playwright/ paths with image ext', async () => {
    const { isScreenshotPath } = await import('./hook-detect.js');
    expect(isScreenshotPath('.playwright/foo.png')).toBe(true);
    expect(isScreenshotPath('/proj/.playwright/shots/x.jpg')).toBe(true);
  });

  it('matches playwright-report/ paths with image ext', async () => {
    const { isScreenshotPath } = await import('./hook-detect.js');
    expect(isScreenshotPath('playwright-report/foo.png')).toBe(true);
  });

  it('rejects .txt even in test-results/', async () => {
    const { isScreenshotPath } = await import('./hook-detect.js');
    expect(isScreenshotPath('test-results/log.txt')).toBe(false);
  });

  it('rejects .html even in test-results/', async () => {
    const { isScreenshotPath } = await import('./hook-detect.js');
    expect(isScreenshotPath('test-results/report.html')).toBe(false);
  });

  it('rejects image ext NOT in a screenshot dir', async () => {
    const { isScreenshotPath } = await import('./hook-detect.js');
    expect(isScreenshotPath('src/assets/logo.png')).toBe(false);
    expect(isScreenshotPath('uploads/photo.jpg')).toBe(false);
  });
});

// ── detectFromWrite ───────────────────────────────────────────────────────────

describe('detectFromWrite', () => {
  it('returns candidate when file_path matches screenshot dir + image ext', async () => {
    const { detectFromWrite } = await import('./hook-detect.js');
    const payload: HookPayload = {
      tool_name: 'Write',
      tool_input: { file_path: 'test-results/screenshot.png' },
    };
    // We can't test existsSync in pure unit test — use _testFileExists injection
    const candidates = detectFromWrite(payload, { fileExists: () => true });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.absPath).toContain('screenshot.png');
    expect(candidates[0]?.source).toBe('write');
  });

  it('returns empty when file_path has image ext but NOT in screenshot dir', async () => {
    const { detectFromWrite } = await import('./hook-detect.js');
    const payload: HookPayload = {
      tool_name: 'Write',
      tool_input: { file_path: 'src/assets/logo.png' },
    };
    const candidates = detectFromWrite(payload, { fileExists: () => true });
    expect(candidates).toHaveLength(0);
  });

  it('returns empty when file_path is in screenshot dir but NOT image ext', async () => {
    const { detectFromWrite } = await import('./hook-detect.js');
    const payload: HookPayload = {
      tool_name: 'Write',
      tool_input: { file_path: 'test-results/results.json' },
    };
    const candidates = detectFromWrite(payload, { fileExists: () => true });
    expect(candidates).toHaveLength(0);
  });

  it('returns empty when tool is not Write', async () => {
    const { detectFromWrite } = await import('./hook-detect.js');
    const payload: HookPayload = {
      tool_name: 'Bash',
      tool_input: { file_path: 'test-results/screenshot.png' },
    };
    const candidates = detectFromWrite(payload, { fileExists: () => true });
    expect(candidates).toHaveLength(0);
  });

  it('returns empty when file does not exist on disk', async () => {
    const { detectFromWrite } = await import('./hook-detect.js');
    const payload: HookPayload = {
      tool_name: 'Write',
      tool_input: { file_path: 'test-results/screenshot.png' },
    };
    const candidates = detectFromWrite(payload, { fileExists: () => false });
    expect(candidates).toHaveLength(0);
  });
});

// ── detectFromBash ────────────────────────────────────────────────────────────

describe('detectFromBash', () => {
  function makeScan(results: Candidate[]): FsScan {
    return {
      walk: vi.fn(async () => results),
    };
  }

  const now = Date.now();
  const fakeCandidate: Candidate = {
    absPath: '/proj/test-results/foo.png',
    source: 'bash-scan',
    mtimeMs: now,
  };

  it('returns candidates found by injected FsScan', async () => {
    const { detectFromBash } = await import('./hook-detect.js');
    const scan = makeScan([fakeCandidate]);
    const payload: HookPayload = {
      tool_name: 'Bash',
      tool_input: { command: 'npx playwright test' },
      cwd: '/proj',
    };
    const results = await detectFromBash(payload, scan);
    expect(results).toHaveLength(1);
    expect(results[0]?.absPath).toBe('/proj/test-results/foo.png');
  });

  it('returns empty when command does not contain "playwright"', async () => {
    const { detectFromBash } = await import('./hook-detect.js');
    const scan = makeScan([fakeCandidate]);
    const payload: HookPayload = {
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      cwd: '/proj',
    };
    const results = await detectFromBash(payload, scan);
    expect(results).toHaveLength(0);
    expect((scan.walk as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('passes sinceMs derived from started_at to FsScan', async () => {
    const { detectFromBash } = await import('./hook-detect.js');
    const scan = makeScan([]);
    const startedAt = new Date(now - 5000).toISOString();
    const payload: HookPayload = {
      tool_name: 'Bash',
      tool_input: { command: 'playwright test', started_at: startedAt },
      cwd: '/proj',
      started_at: startedAt,
    };
    await detectFromBash(payload, scan);
    const walkOpts = (scan.walk as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as { sinceMs: number };
    expect(walkOpts.sinceMs).toBeCloseTo(now - 5000, -2);
  });

  it('falls back to Date.now()-60000 when started_at is absent', async () => {
    const { detectFromBash } = await import('./hook-detect.js');
    const scan = makeScan([]);
    const before = Date.now();
    const payload: HookPayload = {
      tool_name: 'Bash',
      tool_input: { command: 'playwright test' },
      cwd: '/proj',
    };
    await detectFromBash(payload, scan);
    const after = Date.now();
    const walkOpts = (scan.walk as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as { sinceMs: number };
    // sinceMs should be ~60 seconds before "now"
    expect(walkOpts.sinceMs).toBeGreaterThanOrEqual(before - 60_000 - 100);
    expect(walkOpts.sinceMs).toBeLessThanOrEqual(after - 60_000 + 100);
  });

  it('caps maxFiles to 20', async () => {
    const { detectFromBash } = await import('./hook-detect.js');
    const scan = makeScan([]);
    const payload: HookPayload = {
      tool_name: 'Bash',
      tool_input: { command: 'playwright test' },
      cwd: '/proj',
    };
    await detectFromBash(payload, scan);
    const walkOpts = (scan.walk as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as { maxFiles: number };
    expect(walkOpts.maxFiles).toBe(20);
  });

  it('uses payload.cwd as scan root', async () => {
    const { detectFromBash } = await import('./hook-detect.js');
    const scan = makeScan([]);
    const payload: HookPayload = {
      tool_name: 'Bash',
      tool_input: { command: 'playwright test' },
      cwd: '/custom/project',
    };
    await detectFromBash(payload, scan);
    const walkRoots = (scan.walk as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string[];
    expect(walkRoots[0]).toBe('/custom/project');
  });

  it('falls back to process.cwd() when cwd is absent', async () => {
    const { detectFromBash } = await import('./hook-detect.js');
    const scan = makeScan([]);
    const payload: HookPayload = {
      tool_name: 'Bash',
      tool_input: { command: 'playwright test' },
    };
    await detectFromBash(payload, scan);
    const walkRoots = (scan.walk as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string[];
    expect(walkRoots[0]).toBe(process.cwd());
  });

  // ── FIX-3 regression: invalid started_at string must use fallback window ────

  it('FIX-3: falls back to Date.now()-60000 when started_at is a non-empty invalid ISO string', async () => {
    const { detectFromBash } = await import('./hook-detect.js');
    const scan = makeScan([fakeCandidate]);
    const before = Date.now();
    const payload: HookPayload = {
      tool_name: 'Bash',
      tool_input: { command: 'playwright test' },
      cwd: '/proj',
      started_at: 'invalid-iso-string',
    };
    const results = await detectFromBash(payload, scan);
    const after = Date.now();
    const walkOpts = (scan.walk as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as { sinceMs: number };
    // Must use the ~60s-ago fallback, NOT NaN
    expect(Number.isFinite(walkOpts.sinceMs)).toBe(true);
    expect(walkOpts.sinceMs).toBeGreaterThanOrEqual(before - 60_000 - 100);
    expect(walkOpts.sinceMs).toBeLessThanOrEqual(after - 60_000 + 100);
    // Candidates must still be returned (scan was called and returned them)
    expect(results).toHaveLength(1);
  });
});
