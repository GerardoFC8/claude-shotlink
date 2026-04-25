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

  // ── TASK-018-a: RED — widened SCREENSHOT_DIR_RE ───────────────────────────

  it('TASK-018: matches .playwright-cli/ paths with image ext', async () => {
    const { isScreenshotPath } = await import('./hook-detect.js');
    expect(isScreenshotPath('.playwright-cli/shot.png')).toBe(true);
    expect(isScreenshotPath('/proj/.playwright-cli/output.jpg')).toBe(true);
  });

  it('TASK-018: matches tmp/ paths with image ext (root-anchored only)', async () => {
    const { isScreenshotPath } = await import('./hook-detect.js');
    // Root-relative tmp/ still matches (option b)
    expect(isScreenshotPath('tmp/shot.png')).toBe(true);
    // Mid-path /home/user/tmp/ no longer matches (FIX-7: build cache false positive removed)
    // /tmp/out.webp is still covered via ABSOLUTE_TMP_RE
    expect(isScreenshotPath('/tmp/out.webp')).toBe(true);
  });

  it('TASK-018: matches temp/ paths with image ext (root-anchored only)', async () => {
    const { isScreenshotPath } = await import('./hook-detect.js');
    // Root-relative temp/ still matches (option b)
    expect(isScreenshotPath('temp/shot.png')).toBe(true);
    // Mid-path /home/user/temp/ no longer matches (FIX-7)
    // /var/tmp is still covered via ABSOLUTE_TMP_RE
    expect(isScreenshotPath('/var/tmp/out.jpeg')).toBe(true);
  });

  it('TASK-018: matches playwright-<anything>/ paths (playwright-*)', async () => {
    const { isScreenshotPath } = await import('./hook-detect.js');
    expect(isScreenshotPath('playwright-abc/shot.png')).toBe(true);
    expect(isScreenshotPath('playwright-screenshots/foo.webp')).toBe(true);
    expect(isScreenshotPath('/proj/playwright-output/bar.jpg')).toBe(true);
  });

  it('TASK-018: matches <anything>-playwright/ paths (*-playwright)', async () => {
    const { isScreenshotPath } = await import('./hook-detect.js');
    expect(isScreenshotPath('my-playwright/shot.png')).toBe(true);
    expect(isScreenshotPath('e2e-playwright/foo.webp')).toBe(true);
    expect(isScreenshotPath('/proj/ci-playwright/bar.jpeg')).toBe(true);
  });

  it('TASK-018: still rejects src/foo.png (unrelated directory)', async () => {
    const { isScreenshotPath } = await import('./hook-detect.js');
    expect(isScreenshotPath('src/foo.png')).toBe(false);
    expect(isScreenshotPath('dist/bundle.png')).toBe(false);
    expect(isScreenshotPath('images/photo.jpg')).toBe(false);
  });

  // ── TASK-019-a: RED — ABSOLUTE_TMP_RE ────────────────────────────────────

  it('TASK-019: isScreenshotPath matches /tmp/shot.png via ABSOLUTE_TMP_RE', async () => {
    const { isScreenshotPath } = await import('./hook-detect.js');
    expect(isScreenshotPath('/tmp/shot.png')).toBe(true);
    expect(isScreenshotPath('/tmp/nested/out.jpg')).toBe(true);
  });

  it('TASK-019: isScreenshotPath matches /var/tmp/shot.png via ABSOLUTE_TMP_RE', async () => {
    const { isScreenshotPath } = await import('./hook-detect.js');
    expect(isScreenshotPath('/var/tmp/shot.png')).toBe(true);
    expect(isScreenshotPath('/var/tmp/subdir/out.webp')).toBe(true);
  });

  it('TASK-019: ABSOLUTE_TMP_RE does NOT match non-screenshot extension', async () => {
    const { isScreenshotPath } = await import('./hook-detect.js');
    expect(isScreenshotPath('/var/tmp/report.html')).toBe(false);
    expect(isScreenshotPath('/tmp/data.json')).toBe(false);
  });

  // ── FIX-7: build-cache false positive removed ────────────────────────────

  it('FIX-7: /home/user/.npm/cache/tmp/x.png does NOT match (build cache false positive)', async () => {
    const { isScreenshotPath } = await import('./hook-detect.js');
    expect(isScreenshotPath('/home/user/.npm/cache/tmp/x.png')).toBe(false);
  });

  it('FIX-7: /work/old-temp/x.png does NOT match (mid-path temp)', async () => {
    const { isScreenshotPath } = await import('./hook-detect.js');
    expect(isScreenshotPath('/work/old-temp/x.png')).toBe(false);
  });

  it('FIX-7: /tmp/x.png STILL matches via ABSOLUTE_TMP_RE', async () => {
    const { isScreenshotPath } = await import('./hook-detect.js');
    expect(isScreenshotPath('/tmp/x.png')).toBe(true);
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

// ── detectPathsFromBashFlags — TASK-020 ──────────────────────────────────────

describe('detectPathsFromBashFlags', () => {
  // All 11 CA-4.2 scenarios

  it('TASK-020: --filename space form returns absolute path when file exists', async () => {
    const { detectPathsFromBashFlags } = await import('./hook-detect.js');
    const results = detectPathsFromBashFlags(
      'playwright screenshot --filename /tmp/shot.png',
      { cwd: '/home/user', fileExists: () => true },
    );
    expect(results).toContain('/tmp/shot.png');
  });

  it('TASK-020: --filename= form returns absolute path when file exists', async () => {
    const { detectPathsFromBashFlags } = await import('./hook-detect.js');
    const results = detectPathsFromBashFlags(
      'playwright screenshot --filename=/tmp/shot.png',
      { cwd: '/home/user', fileExists: () => true },
    );
    expect(results).toContain('/tmp/shot.png');
  });

  it('TASK-020: --output space form returns path when file exists', async () => {
    const { detectPathsFromBashFlags } = await import('./hook-detect.js');
    const results = detectPathsFromBashFlags(
      'playwright screenshot --output /tmp/out.jpg',
      { cwd: '/home/user', fileExists: () => true },
    );
    expect(results).toContain('/tmp/out.jpg');
  });

  it('TASK-020: --output= form returns path when file exists', async () => {
    const { detectPathsFromBashFlags } = await import('./hook-detect.js');
    const results = detectPathsFromBashFlags(
      'playwright screenshot --output=/tmp/out.jpg',
      { cwd: '/home/user', fileExists: () => true },
    );
    expect(results).toContain('/tmp/out.jpg');
  });

  it('TASK-020: -o short flag returns path when file exists', async () => {
    const { detectPathsFromBashFlags } = await import('./hook-detect.js');
    const results = detectPathsFromBashFlags(
      'playwright screenshot -o /tmp/out.webp',
      { cwd: '/home/user', fileExists: () => true },
    );
    expect(results).toContain('/tmp/out.webp');
  });

  it('TASK-020: --path space form returns path when file exists', async () => {
    const { detectPathsFromBashFlags } = await import('./hook-detect.js');
    const results = detectPathsFromBashFlags(
      'playwright screenshot --path /tmp/shot.png',
      { cwd: '/home/user', fileExists: () => true },
    );
    expect(results).toContain('/tmp/shot.png');
  });

  it('TASK-020: --screenshot space form returns path when file exists (youtube.png production case)', async () => {
    const { detectPathsFromBashFlags } = await import('./hook-detect.js');
    const results = detectPathsFromBashFlags(
      'playwright-cli screenshot --screenshot /tmp/youtube.png',
      { cwd: '/home/user', fileExists: () => true },
    );
    expect(results).toContain('/tmp/youtube.png');
  });

  it('TASK-020: quoted path with embedded space is handled correctly', async () => {
    const { detectPathsFromBashFlags } = await import('./hook-detect.js');
    const results = detectPathsFromBashFlags(
      'playwright screenshot --filename "/tmp/my shot.png"',
      { cwd: '/home/user', fileExists: () => true },
    );
    expect(results).toContain('/tmp/my shot.png');
  });

  it('TASK-020: relative path resolved against cwd when file exists', async () => {
    const { detectPathsFromBashFlags } = await import('./hook-detect.js');
    const results = detectPathsFromBashFlags(
      'playwright screenshot --output tmp/img.png',
      { cwd: '/home/user/project', fileExists: () => true },
    );
    expect(results).toContain('/home/user/project/tmp/img.png');
  });

  it('TASK-020: missing file is filtered out (returns empty)', async () => {
    const { detectPathsFromBashFlags } = await import('./hook-detect.js');
    const results = detectPathsFromBashFlags(
      'playwright screenshot --filename /tmp/missing.png',
      { cwd: '/home/user', fileExists: () => false },
    );
    expect(results).toHaveLength(0);
  });

  it('TASK-020: non-screenshot extension (.html) is filtered out', async () => {
    const { detectPathsFromBashFlags } = await import('./hook-detect.js');
    const results = detectPathsFromBashFlags(
      'playwright screenshot --output /tmp/report.html',
      { cwd: '/home/user', fileExists: () => true },
    );
    expect(results).toHaveLength(0);
  });

  // ── FIX-6: tokenizer splits on newline ───────────────────────────────────

  it('FIX-6: multi-line bash command detects path after newline', async () => {
    const { detectPathsFromBashFlags } = await import('./hook-detect.js');
    // Simulate Claude Code Bash tool emitting multi-line command
    const cmd = 'playwright test\nplaywright screenshot --filename /tmp/shot.png';
    const results = detectPathsFromBashFlags(cmd, {
      cwd: '/home/user',
      fileExists: () => true,
    });
    expect(results).toContain('/tmp/shot.png');
  });

  it('FIX-6: multi-line command with \\r\\n line endings detects path', async () => {
    const { detectPathsFromBashFlags } = await import('./hook-detect.js');
    const cmd = 'playwright test\r\nplaywright screenshot --filename /tmp/out.jpg';
    const results = detectPathsFromBashFlags(cmd, {
      cwd: '/home/user',
      fileExists: () => true,
    });
    expect(results).toContain('/tmp/out.jpg');
  });
});

// ── detectFromBash TASK-021: integration with flag paths + dedup ──────────────

describe('detectFromBash — TASK-021: flag path integration', () => {
  function makeScan(results: Candidate[]): FsScan {
    return {
      walk: vi.fn(async () => results),
    };
  }

  it('TASK-021: --screenshot flag path appears in candidates via bash-flag source', async () => {
    const { detectFromBash } = await import('./hook-detect.js');
    const scan = makeScan([]);
    const payload: HookPayload = {
      tool_name: 'Bash',
      tool_input: { command: 'playwright-cli screenshot --screenshot /tmp/youtube.png' },
      cwd: '/home/user',
    };
    const results = await detectFromBash(payload, scan, { fileExists: () => true });
    const absPath = results.find(c => c.absPath === '/tmp/youtube.png');
    expect(absPath).toBeDefined();
    expect(absPath?.source).toBe('bash-flag');
  });

  it('TASK-021: same path from scan and flag appears exactly once (deduped)', async () => {
    const { detectFromBash } = await import('./hook-detect.js');
    const shared: Candidate = {
      absPath: '/tmp/shot.png',
      source: 'bash-scan',
      mtimeMs: Date.now(),
    };
    const scan = makeScan([shared]);
    const payload: HookPayload = {
      tool_name: 'Bash',
      tool_input: { command: 'playwright screenshot --filename /tmp/shot.png' },
      cwd: '/home/user',
    };
    const results = await detectFromBash(payload, scan, { fileExists: () => true });
    const matching = results.filter(c => c.absPath === '/tmp/shot.png');
    expect(matching).toHaveLength(1);
    // flag source wins on tie
    expect(matching[0]?.source).toBe('bash-flag');
  });
});
