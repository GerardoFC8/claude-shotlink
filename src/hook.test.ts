/**
 * hook.test.ts
 *
 * Tests for src/hook-core.ts (the testable core of the hook runtime).
 *
 * STRICT TDD: all tests written RED-first before implementation.
 * The hook-core.ts module is tested via its exported `runHook(stdin, deps)`
 * function with all external dependencies injected.
 */
import { describe, it, expect, vi } from 'vitest';
import type { HookDeps } from './hook-core.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<HookDeps> = {}): HookDeps {
  return {
    readPidFile: vi.fn().mockResolvedValue({ pid: process.pid, port: 9999, tunnelUrl: 'https://abc.trycloudflare.com', startedAt: new Date().toISOString() }),
    readConfig: vi.fn().mockResolvedValue({ apiKey: 'sk_test' }),
    uploadFn: vi.fn().mockResolvedValue({ id: 'abc123', url: 'https://abc.trycloudflare.com/f/abc123' }),
    dedupCache: {
      load: vi.fn().mockResolvedValue(undefined),
      lookup: vi.fn().mockReturnValue(null),
      remember: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    },
    fs: {
      walk: vi.fn().mockResolvedValue([]),
    },
    now: vi.fn().mockReturnValue(Date.now()),
    ...overrides,
  };
}

function makeWritePayload(filePath: string): string {
  return JSON.stringify({
    tool_name: 'Write',
    tool_input: { file_path: filePath },
    cwd: '/tmp',
    started_at: new Date().toISOString(),
  });
}

function makeBashPayload(command: string, cwd = '/tmp'): string {
  return JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command },
    cwd,
    started_at: new Date().toISOString(),
  });
}

// ── Test 1: Write event with matching screenshot path ─────────────────────────

describe('hook-core: Write event for screenshot path', () => {
  it('returns stdout JSON with hookSpecificOutput.hookEventName and additionalContext with /f/ URL', async () => {
    const { runHook } = await import('./hook-core.js');

    const tmpPng = '/tmp/test-results/foo.png';

    const deps = makeDeps({
      uploadFn: vi.fn().mockResolvedValue({ id: 'abc123', url: 'https://abc.trycloudflare.com/f/abc123' }),
      fs: {
        walk: vi.fn().mockResolvedValue([]),
      },
    });

    // Override fileExists so detectFromWrite doesn't try real fs
    const payload = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: tmpPng },
      cwd: '/tmp',
      started_at: new Date().toISOString(),
    });

    // Provide a fake readFileFn so sha256 can be computed without real disk I/O
    const fakePngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const result = await runHook(payload, deps, {
      fileExists: (_p: string) => true,
      readFileFn: vi.fn().mockResolvedValue(fakePngBuf),
    });

    expect(result.stdout).toBeDefined();
    const parsed = JSON.parse(result.stdout!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('/f/');
  });
});

// ── Test 2: Dedup cache hit skips upload ─────────────────────────────────────

describe('hook-core: dedup cache hit', () => {
  it('reads from cache, skips upload, still emits additionalContext with cached URL', async () => {
    const { runHook } = await import('./hook-core.js');

    const tmpPng = '/tmp/screenshots/bar.png';
    const cachedUrl = 'https://abc.trycloudflare.com/f/cached';

    const uploadMock = vi.fn();
    const deps = makeDeps({
      uploadFn: uploadMock,
      dedupCache: {
        load: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockReturnValue(cachedUrl),
        remember: vi.fn(),
        flush: vi.fn().mockResolvedValue(undefined),
      },
    });

    const payload = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: tmpPng },
      cwd: '/tmp',
      started_at: new Date().toISOString(),
    });

    const fakePngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const result = await runHook(payload, deps, {
      fileExists: () => true,
      readFileFn: vi.fn().mockResolvedValue(fakePngBuf),
    });

    expect(uploadMock).not.toHaveBeenCalled();
    expect(result.stdout).toBeDefined();
    const parsed = JSON.parse(result.stdout!);
    expect(parsed.hookSpecificOutput.additionalContext).toContain(cachedUrl);
  });
});

// ── Test 3: ECONNREFUSED → stdout empty, exit 0 ───────────────────────────────

describe('hook-core: relay not running (upload fails)', () => {
  it('returns no stdout when uploadFn throws ECONNREFUSED', async () => {
    const { runHook } = await import('./hook-core.js');

    const tmpPng = '/tmp/test-results/foo.png';

    const econnError = new Error('connect ECONNREFUSED 127.0.0.1:9999');
    (econnError as NodeJS.ErrnoException).code = 'ECONNREFUSED';

    const deps = makeDeps({
      uploadFn: vi.fn().mockRejectedValue(econnError),
    });

    const payload = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: tmpPng },
      cwd: '/tmp',
      started_at: new Date().toISOString(),
    });

    // Inject a readFileFn so the test actually reaches uploadFn (not ENOENT)
    const fakePngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const result = await runHook(payload, deps, {
      fileExists: () => true,
      readFileFn: vi.fn().mockResolvedValue(fakePngBuf),
    });

    expect(result.stdout).toBeUndefined();
  });
});

// ── Test 4: Malformed stdin → no stdout ───────────────────────────────────────

describe('hook-core: malformed stdin', () => {
  it('returns no stdout when stdin is not valid JSON', async () => {
    const { runHook } = await import('./hook-core.js');
    const deps = makeDeps();

    const result = await runHook('not valid json {{{}}}', deps);

    expect(result.stdout).toBeUndefined();
  });
});

// ── Test 5: Bash event with many candidates — capped at 20 ───────────────────

describe('hook-core: Bash event 20-file cap', () => {
  it('upload count is capped at 20 even when FsScan returns 30 candidates', async () => {
    const { runHook } = await import('./hook-core.js');

    // 30 fake candidates
    const candidates = Array.from({ length: 30 }, (_, i) => ({
      absPath: `/tmp/test-results/shot-${i}.png`,
      source: 'bash-scan' as const,
      mtimeMs: Date.now(),
    }));

    const uploadMock = vi.fn().mockResolvedValue({ id: 'x', url: 'https://x.trycloudflare.com/f/x' });

    const deps = makeDeps({
      uploadFn: uploadMock,
      dedupCache: {
        load: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockReturnValue(null),
        remember: vi.fn(),
        flush: vi.fn().mockResolvedValue(undefined),
      },
      fs: {
        walk: vi.fn().mockResolvedValue(candidates),
      },
    });

    const payload = makeBashPayload('npx playwright test');

    const result = await runHook(payload, deps, {
      fileExists: () => true,
      readFileFn: vi.fn().mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), // PNG magic bytes
    });

    expect(uploadMock.mock.calls.length).toBeLessThanOrEqual(20);
  });
});

// ── Test 6: No PID file → no stdout ──────────────────────────────────────────

describe('hook-core: no PID file', () => {
  it('returns no stdout when PID file is missing', async () => {
    const { runHook } = await import('./hook-core.js');

    const deps = makeDeps({
      readPidFile: vi.fn().mockResolvedValue(null),
    });

    const payload = makeWritePayload('/tmp/test-results/foo.png');

    const result = await runHook(payload, deps, { fileExists: () => true });

    expect(result.stdout).toBeUndefined();
  });
});

// ── Test 7: Unknown tool_name → no stdout ─────────────────────────────────────

describe('hook-core: unknown tool_name', () => {
  it('returns no stdout for tool_name "Read"', async () => {
    const { runHook } = await import('./hook-core.js');

    const deps = makeDeps();

    const payload = JSON.stringify({
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/test-results/foo.png' },
      cwd: '/tmp',
    });

    const result = await runHook(payload, deps);

    expect(result.stdout).toBeUndefined();
  });
});

// ── Test 8: Unhandled exception → caught, no stdout ───────────────────────────

describe('hook-core: unhandled exception inside logic', () => {
  it('returns no stdout when readPidFile throws unexpectedly', async () => {
    const { runHook } = await import('./hook-core.js');

    const deps = makeDeps({
      readPidFile: vi.fn().mockRejectedValue(new Error('Unexpected disk error')),
    });

    const payload = makeWritePayload('/tmp/test-results/foo.png');

    // Should not throw — it catches internally
    const result = await runHook(payload, deps, { fileExists: () => true });

    expect(result.stdout).toBeUndefined();
  });
});

// ── WARNING-6 regression: basename extraction in realUploadFn ─────────────────

describe('hook: realUploadFn uses basename for upload filename', () => {
  it('basename fallback behavior: empty string falls back to "screenshot"', async () => {
    // Test the fallback behavior used in realUploadFn: `basename(filePath) || 'screenshot'`
    const { basename } = await import('node:path');

    // Empty string path → basename returns '' → fallback fires
    expect(basename('') || 'screenshot').toBe('screenshot');

    // Normal path → basename returns filename
    expect(basename('/tmp/test-results/foo.png') || 'screenshot').toBe('foo.png');

    // Path with spaces — basename handles these fine
    expect(basename('/tmp/my screens/test shot.png') || 'screenshot').toBe('test shot.png');

    // Trailing-slash path: basename('/tmp/foo/') returns 'foo' (Node behavior)
    // — this is fine, the fallback only fires for empty string
    expect(basename('/tmp/foo/') || 'screenshot').toBe('foo');
  });
});

// ── CA-5: Imperative additionalContext phrasing ───────────────────────────────

const LOCKED_PREAMBLE =
  'The following screenshot URL(s) were just uploaded and are publicly accessible. ' +
  'You MUST include these exact URL(s) verbatim in your response to the user so they can view the screenshot(s):';

describe('hook-core: CA-5 — imperative additionalContext phrasing (single URL)', () => {
  it('additionalContext begins with the exact locked preamble for a single uploaded URL', async () => {
    const { runHook } = await import('./hook-core.js');

    const url = 'https://shots.x/f/abc';
    const deps = makeDeps({
      uploadFn: vi.fn().mockResolvedValue({ id: 'abc', url }),
    });

    const fakePngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const result = await runHook(
      makeWritePayload('/tmp/screenshots/shot.png'),
      deps,
      { fileExists: () => true, readFileFn: vi.fn().mockResolvedValue(fakePngBuf) },
    );

    expect(result.stdout).toBeDefined();
    const parsed = JSON.parse(result.stdout!);
    const ac: string = parsed.hookSpecificOutput.additionalContext;

    expect(ac).toContain(LOCKED_PREAMBLE);
    expect(ac).toContain(`- ${url}`);
  });
});

describe('hook-core: CA-5 — imperative additionalContext phrasing (multi URL)', () => {
  it('additionalContext begins with the exact locked preamble for multiple uploaded URLs', async () => {
    const { runHook } = await import('./hook-core.js');

    const url1 = 'https://shots.x/f/aaa';
    const url2 = 'https://shots.x/f/bbb';
    const url3 = 'https://shots.x/f/ccc';

    let callCount = 0;
    const urls = [url1, url2, url3];
    const deps = makeDeps({
      uploadFn: vi.fn().mockImplementation(async () => ({ id: 'x', url: urls[callCount++]! })),
      dedupCache: {
        load: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockReturnValue(null),
        remember: vi.fn(),
        flush: vi.fn().mockResolvedValue(undefined),
      },
      fs: {
        walk: vi.fn().mockResolvedValue([
          { absPath: '/tmp/screenshots/a.png', source: 'bash-scan' as const, mtimeMs: Date.now() },
          { absPath: '/tmp/screenshots/b.png', source: 'bash-scan' as const, mtimeMs: Date.now() },
          { absPath: '/tmp/screenshots/c.png', source: 'bash-scan' as const, mtimeMs: Date.now() },
        ]),
      },
    });

    const fakePngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const result = await runHook(
      makeBashPayload('npx playwright test'),
      deps,
      { fileExists: () => true, readFileFn: vi.fn().mockResolvedValue(fakePngBuf) },
    );

    expect(result.stdout).toBeDefined();
    const parsed = JSON.parse(result.stdout!);
    const ac: string = parsed.hookSpecificOutput.additionalContext;

    expect(ac).toContain(LOCKED_PREAMBLE);
    expect(ac).toContain(`- ${url1}`);
    expect(ac).toContain(`- ${url2}`);
    expect(ac).toContain(`- ${url3}`);
  });
});

describe('hook-core: CA-5 — zero screenshots — preamble NOT emitted', () => {
  it('returns no stdout (no additionalContext) when no screenshots are detected', async () => {
    const { runHook } = await import('./hook-core.js');

    const deps = makeDeps({
      fs: { walk: vi.fn().mockResolvedValue([]) },
    });

    // A Bash payload that does NOT produce any candidates (walk returns [])
    const result = await runHook(makeBashPayload('echo hello'), deps);

    // No screenshots → no output at all
    expect(result.stdout).toBeUndefined();
  });
});

// ── SUSPECT-2 regression: uploadFn receives the already-read buffer ───────────

describe('hook-core: uploadFn receives same buffer as sha256', () => {
  it('uploadFn is called with the exact buffer read for sha256 computation', async () => {
    const { runHook } = await import('./hook-core.js');

    const tmpPng = '/tmp/test-results/suspect2.png';
    const fakePngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xDE, 0xAD, 0xBE, 0xEF]);

    const capturedArgs: Array<[string, string, Buffer, string]> = [];
    const uploadMock = vi.fn().mockImplementation(
      async (url: string, path: string, buf: Buffer, apiKey: string) => {
        capturedArgs.push([url, path, buf, apiKey]);
        return { id: 'x', url: 'https://x.tc.com/f/x' };
      }
    );

    const deps = makeDeps({ uploadFn: uploadMock });

    const payload = makeWritePayload(tmpPng);
    const readFileMock = vi.fn().mockResolvedValue(fakePngBuf);

    await runHook(payload, deps, {
      fileExists: () => true,
      readFileFn: readFileMock,
    });

    expect(uploadMock).toHaveBeenCalledOnce();
    const [, , bufArg] = capturedArgs[0]!;
    // The buffer passed to uploadFn must be exactly the same bytes as what readFileFn returned
    expect(Buffer.compare(bufArg, fakePngBuf)).toBe(0);
    // readFileFn should be called exactly once (no double-read)
    expect(readFileMock).toHaveBeenCalledOnce();
  });
});
