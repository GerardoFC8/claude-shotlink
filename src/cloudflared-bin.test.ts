import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';

// ── resolveAsset ──────────────────────────────────────────────────────────────

describe('resolveAsset', () => {
  it('linux x64 → cloudflared-linux-amd64', async () => {
    const { resolveAsset } = await import('./cloudflared-bin.js');
    const spec = resolveAsset('linux', 'x64');
    expect(spec.assetName).toBe('cloudflared-linux-amd64');
  });

  it('linux arm64 → cloudflared-linux-arm64', async () => {
    const { resolveAsset } = await import('./cloudflared-bin.js');
    const spec = resolveAsset('linux', 'arm64');
    expect(spec.assetName).toBe('cloudflared-linux-arm64');
  });

  it('darwin x64 → asset name ends with .tgz', async () => {
    const { resolveAsset } = await import('./cloudflared-bin.js');
    const spec = resolveAsset('darwin', 'x64');
    expect(spec.assetName).toMatch(/\.tgz$/);
  });

  it('darwin arm64 → asset name ends with .tgz', async () => {
    const { resolveAsset } = await import('./cloudflared-bin.js');
    const spec = resolveAsset('darwin', 'arm64');
    expect(spec.assetName).toMatch(/\.tgz$/);
  });

  it('win32 throws with helpful message', async () => {
    const { resolveAsset } = await import('./cloudflared-bin.js');
    expect(() => resolveAsset('win32', 'x64')).toThrow(/unsupported/i);
  });

  it('url contains cloudflare/cloudflared/releases/download', async () => {
    const { resolveAsset } = await import('./cloudflared-bin.js');
    const spec = resolveAsset('linux', 'x64');
    expect(spec.url).toContain('cloudflare/cloudflared/releases/download');
  });

  it('sha256 matches value from cloudflared-checksums.json', async () => {
    const { resolveAsset } = await import('./cloudflared-bin.js');
    const checksums = (await import('./cloudflared-checksums.json', { with: { type: 'json' } })).default as Record<string, string>;
    const spec = resolveAsset('linux', 'x64');
    expect(spec.sha256).toBe(checksums['cloudflared-linux-amd64']);
  });
});

// ── CRITICAL-1 regression: every checksum must be a valid 64-char hex string ──

describe('cloudflared-checksums.json — all checksums must be valid sha256', () => {
  it('every non-metadata entry is exactly 64 lowercase hex chars', async () => {
    const checksums = (await import('./cloudflared-checksums.json', { with: { type: 'json' } })).default as Record<string, string>;
    const sha256Re = /^[a-f0-9]{64}$/;

    for (const [key, value] of Object.entries(checksums)) {
      // Skip metadata fields starting with '_'
      if (key.startsWith('_')) continue;
      expect(
        sha256Re.test(value),
        `checksum for "${key}" must be 64 lowercase hex chars, got ${value.length} chars: ${value}`
      ).toBe(true);
    }
  });
});

// ── ensureBinary ──────────────────────────────────────────────────────────────

describe('ensureBinary', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cbin-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeFakeBinaryBytes(): Uint8Array {
    // A minimal "binary" — just some bytes
    return new TextEncoder().encode('fake-cloudflared-binary');
  }

  function sha256hex(data: Uint8Array): string {
    return createHash('sha256').update(data).digest('hex');
  }

  function makeFetchImpl(bytes: Uint8Array): typeof fetch {
    return async (_url: string | URL | Request): Promise<Response> => {
      return new Response(bytes, { status: 200 });
    };
  }

  it('downloads binary when cache missing, verifies sha256, places at cacheDir/cloudflared', async () => {
    const { ensureBinary, resolveAsset } = await import('./cloudflared-bin.js');
    const fakeBytes = makeFakeBinaryBytes();
    const hash = sha256hex(fakeBytes);
    // We need to make resolveAsset return our fake hash for the current platform
    // Instead we pass a custom assetSpec override through options — but design says
    // ensureBinary uses opts.version and resolveAsset internally, so we need to
    // make the checksum match. We'll use a test-only override approach:
    // inject assetSpec directly.
    const result = await ensureBinary({
      cacheDir: tempDir,
      fetchImpl: makeFetchImpl(fakeBytes),
      _testOverrideChecksum: hash,
      _testOverrideAssetName: 'cloudflared-linux-amd64',
    });
    expect(result).toBe(join(tempDir, 'cloudflared'));
    expect(existsSync(join(tempDir, 'cloudflared'))).toBe(true);
  });

  it('rejects with "checksum mismatch" when sha256 wrong', async () => {
    const { ensureBinary } = await import('./cloudflared-bin.js');
    const fakeBytes = makeFakeBinaryBytes();
    // Pass wrong hash → should reject
    await expect(
      ensureBinary({
        cacheDir: tempDir,
        fetchImpl: makeFetchImpl(fakeBytes),
        _testOverrideChecksum: 'deadbeef'.repeat(8), // wrong hash
        _testOverrideAssetName: 'cloudflared-linux-amd64',
      }),
    ).rejects.toThrow('checksum mismatch');
  });

  it('does not call fetchImpl when binary already cached at correct version', async () => {
    const { ensureBinary, CLOUDFLARED_VERSION } = await import('./cloudflared-bin.js');
    const fakeBytes = makeFakeBinaryBytes();
    const hash = sha256hex(fakeBytes);

    // Pre-populate the cache
    await writeFile(join(tempDir, 'cloudflared'), fakeBytes, { mode: 0o755 });
    await writeFile(join(tempDir, '.version'), CLOUDFLARED_VERSION, 'utf8');

    const fetchSpy = vi.fn(makeFetchImpl(fakeBytes));
    await ensureBinary({
      cacheDir: tempDir,
      fetchImpl: fetchSpy,
      _testOverrideChecksum: hash,
      _testOverrideAssetName: 'cloudflared-linux-amd64',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('writes .version file after successful install', async () => {
    const { ensureBinary, CLOUDFLARED_VERSION } = await import('./cloudflared-bin.js');
    const fakeBytes = makeFakeBinaryBytes();
    const hash = sha256hex(fakeBytes);

    await ensureBinary({
      cacheDir: tempDir,
      fetchImpl: makeFetchImpl(fakeBytes),
      _testOverrideChecksum: hash,
      _testOverrideAssetName: 'cloudflared-linux-amd64',
    });

    const versionFile = join(tempDir, '.version');
    expect(existsSync(versionFile)).toBe(true);
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(versionFile, 'utf8')).toBe(CLOUDFLARED_VERSION);
  });

  it('writes to temp file first, then renames (no .part file remains after call)', async () => {
    const { ensureBinary } = await import('./cloudflared-bin.js');
    const fakeBytes = makeFakeBinaryBytes();
    const hash = sha256hex(fakeBytes);

    await ensureBinary({
      cacheDir: tempDir,
      fetchImpl: makeFetchImpl(fakeBytes),
      _testOverrideChecksum: hash,
      _testOverrideAssetName: 'cloudflared-linux-amd64',
    });

    // No .part files should remain
    const files = await import('node:fs/promises').then((m) => m.readdir(tempDir));
    const partFiles = files.filter((f) => f.includes('.part'));
    expect(partFiles).toHaveLength(0);
  });

  it('extracts tgz for darwin platform and places binary at cacheDir/cloudflared', async () => {
    const { ensureBinary } = await import('./cloudflared-bin.js');

    // Build a minimal valid .tgz containing a file named "cloudflared"
    const tgzBytes = await buildMinimalTgz('cloudflared', new TextEncoder().encode('fake-darwin-binary'));
    const hash = sha256hex(tgzBytes);

    await ensureBinary({
      cacheDir: tempDir,
      fetchImpl: makeFetchImpl(tgzBytes),
      _testOverrideChecksum: hash,
      _testOverrideAssetName: 'cloudflared-darwin-amd64.tgz',
    });

    expect(existsSync(join(tempDir, 'cloudflared'))).toBe(true);
  });
});

// ── CRITICAL-2 regression: no bare require() in ESM source files ─────────────

describe('ESM source files — no bare require() calls', () => {
  it('src/ files must not contain bare require( calls (would throw in ESM at runtime)', async () => {
    const { readdir, readFile: readFileAsync } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { join: pathJoin } = await import('node:path');

    const srcDir = fileURLToPath(new URL('.', import.meta.url));
    const entries = await readdir(srcDir);
    const tsFiles = entries.filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'));

    const bareRequireRe = /(?<![a-zA-Z_$])require\s*\(/;
    // Allowlist: createRequire( is fine — it's the ESM-compatible wrapper
    const allowlistRe = /createRequire\s*\(/;

    const violations: string[] = [];
    for (const file of tsFiles) {
      const content = await readFileAsync(pathJoin(srcDir, file), 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (bareRequireRe.test(line) && !allowlistRe.test(line)) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    expect(
      violations,
      `Bare require() found in ESM source files:\n${violations.join('\n')}`
    ).toHaveLength(0);
  });
});

// ── Helper: build a minimal .tgz in memory ───────────────────────────────────

async function buildMinimalTgz(filename: string, content: Uint8Array): Promise<Uint8Array> {
  const { createGzip } = await import('node:zlib');
  const { Readable } = await import('node:stream');

  // Build a POSIX tar entry manually
  const tarBuf = buildTarEntry(filename, content);

  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const gz = createGzip();
    gz.on('data', (chunk: Buffer) => chunks.push(chunk));
    gz.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    gz.on('error', reject);

    const src = Readable.from([Buffer.from(tarBuf)]);
    src.pipe(gz);
  });
}

function buildTarEntry(name: string, content: Uint8Array): Uint8Array {
  // Tar header: 512 bytes. We'll build a minimal POSIX ustar header.
  const headerBuf = Buffer.alloc(512, 0);
  // name (100 bytes at offset 0)
  headerBuf.write(name, 0, 100, 'ascii');
  // mode (8 bytes at offset 100)
  headerBuf.write('0000755\0', 100, 8, 'ascii');
  // uid (8 bytes at offset 108)
  headerBuf.write('0000000\0', 108, 8, 'ascii');
  // gid (8 bytes at offset 116)
  headerBuf.write('0000000\0', 116, 8, 'ascii');
  // size (12 bytes at offset 124) — octal
  const sizeOctal = content.length.toString(8).padStart(11, '0') + '\0';
  headerBuf.write(sizeOctal, 124, 12, 'ascii');
  // mtime (12 bytes at offset 136) — octal seconds
  const mtimeOctal = Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0';
  headerBuf.write(mtimeOctal, 136, 12, 'ascii');
  // typeflag (1 byte at offset 156) — '0' = regular file
  headerBuf.write('0', 156, 1, 'ascii');
  // magic (6 bytes at offset 257)
  headerBuf.write('ustar\0', 257, 6, 'ascii');
  // version (2 bytes at offset 263)
  headerBuf.write('00', 263, 2, 'ascii');

  // Compute checksum: sum of all bytes in header with checksum field as spaces
  headerBuf.fill(0x20, 148, 156); // checksum field = 8 spaces
  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += headerBuf[i] ?? 0;
  }
  headerBuf.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');

  // Content padded to 512-byte boundary
  const paddedSize = Math.ceil(content.length / 512) * 512;
  const contentBuf = Buffer.alloc(paddedSize, 0);
  Buffer.from(content).copy(contentBuf);

  // Two 512-byte zero blocks at end (end-of-archive marker)
  const eof = Buffer.alloc(1024, 0);

  return new Uint8Array(Buffer.concat([headerBuf, contentBuf, eof]));
}
