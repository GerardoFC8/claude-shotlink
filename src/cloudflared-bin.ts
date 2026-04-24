/**
 * cloudflared-bin.ts
 *
 * Pure binary-acquisition concerns: resolve asset name, download, sha256 verify,
 * atomic install, version-marker check.
 *
 * CLOUDFLARED_VERSION is manually bumped per release. When bumping:
 *   1. Update CLOUDFLARED_VERSION below.
 *   2. Download each platform asset and update src/cloudflared-checksums.json.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile, rename, chmod, readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { join } from 'node:path';
import { homedir } from 'node:os';
import checksums from './cloudflared-checksums.json' with { type: 'json' };

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AssetSpec {
  assetName: string;
  url: string;
  sha256: string;
}

export interface EnsureBinaryOptions {
  cacheDir?: string;
  version?: string;
  fetchImpl?: typeof fetch;
  /** @internal test-only: override the expected sha256 so tests can use synthetic bytes */
  _testOverrideChecksum?: string;
  /** @internal test-only: override asset name selection (skip platform detection) */
  _testOverrideAssetName?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Pinned cloudflared version. Bump this (+ checksums JSON) on each release. */
export const CLOUDFLARED_VERSION = '2024.12.2';

const GITHUB_BASE = 'https://github.com/cloudflare/cloudflared/releases/download';

/** Supported platform → arch → asset name. */
const PLATFORM_MATRIX: Record<string, Record<string, string>> = {
  linux: {
    x64: 'cloudflared-linux-amd64',
    arm64: 'cloudflared-linux-arm64',
  },
  darwin: {
    x64: 'cloudflared-darwin-amd64.tgz',
    arm64: 'cloudflared-darwin-arm64.tgz',
  },
};

// ── resolveAsset ──────────────────────────────────────────────────────────────

export function resolveAsset(platform: NodeJS.Platform | string, arch: string): AssetSpec {
  const archMap = PLATFORM_MATRIX[platform];
  if (!archMap) {
    throw new Error(
      `Unsupported platform: "${platform}". cloudflared supports linux and darwin. ` +
        `Visit https://github.com/cloudflare/cloudflared/releases for manual install.`,
    );
  }

  const assetName = archMap[arch];
  if (!assetName) {
    throw new Error(
      `Unsupported arch "${arch}" on platform "${platform}". ` +
        `Supported: ${Object.keys(archMap).join(', ')}.`,
    );
  }

  const version = CLOUDFLARED_VERSION;
  const url = `${GITHUB_BASE}/${version}/${assetName}`;

  // checksums JSON is keyed by asset name; _version and _note are metadata fields
  const checksumMap = checksums as Record<string, string>;
  const sha256 = checksumMap[assetName];
  if (!sha256) {
    throw new Error(`No checksum found for asset "${assetName}" in cloudflared-checksums.json.`);
  }

  return { assetName, url, sha256 };
}

// ── ensureBinary ──────────────────────────────────────────────────────────────

export async function ensureBinary(opts: EnsureBinaryOptions = {}): Promise<string> {
  const version = opts.version ?? CLOUDFLARED_VERSION;
  const cacheDir = opts.cacheDir ?? join(homedir(), '.claude-shotlink', 'bin');
  const fetchImpl = opts.fetchImpl ?? fetch;

  const binaryPath = join(cacheDir, 'cloudflared');
  const versionPath = join(cacheDir, '.version');

  // Resolve asset (or use test override)
  let assetName: string;
  let url: string;
  let expectedSha256: string;

  if (opts._testOverrideAssetName) {
    assetName = opts._testOverrideAssetName;
    url = `${GITHUB_BASE}/${version}/${assetName}`;
    expectedSha256 = opts._testOverrideChecksum ?? '';
  } else {
    const spec = resolveAsset(process.platform, process.arch);
    assetName = spec.assetName;
    url = spec.url;
    expectedSha256 = opts._testOverrideChecksum ?? spec.sha256;
  }

  // Cache hit: binary exists + version marker matches
  if (existsSync(binaryPath) && existsSync(versionPath)) {
    const cachedVersion = await readFile(versionPath, 'utf8').catch(() => '');
    if (cachedVersion.trim() === version) {
      return binaryPath;
    }
    // Version mismatch — delete old binary and re-download
    await unlink(binaryPath).catch(() => undefined);
    await unlink(versionPath).catch(() => undefined);
  }

  // Ensure cache dir exists
  await mkdir(cacheDir, { recursive: true });

  // Download
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Failed to download cloudflared from ${url}: HTTP ${response.status}`);
  }
  const downloadedBytes = new Uint8Array(await response.arrayBuffer());

  // Verify sha256
  const actualSha256 = createHash('sha256').update(downloadedBytes).digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `cloudflared checksum mismatch for ${assetName}. ` +
        `Expected: ${expectedSha256}. Got: ${actualSha256}.`,
    );
  }

  // For .tgz assets: extract, then write the extracted binary
  // For plain binary assets: write directly
  const rand = randomBytes(6).toString('hex');
  const partPath = join(cacheDir, `cloudflared.part-${rand}`);

  if (assetName.endsWith('.tgz')) {
    await extractBinaryFromTgz(downloadedBytes, partPath, cacheDir, rand);
  } else {
    await writeFile(partPath, downloadedBytes);
  }

  // chmod before rename
  await chmod(partPath, 0o755);

  // Atomic rename
  await rename(partPath, binaryPath);

  // Write .version marker AFTER successful rename
  await writeFile(versionPath, version, 'utf8');

  return binaryPath;
}

// ── tar/tgz extraction ────────────────────────────────────────────────────────

/**
 * Extract a file named "cloudflared" from a .tgz archive (in-memory, no child_process).
 * Uses Node's built-in `zlib` for gunzip and a minimal in-memory tar parser.
 */
async function extractBinaryFromTgz(
  tgzBytes: Uint8Array,
  partPath: string,
  cacheDir: string,
  rand: string,
): Promise<void> {
  // Gunzip
  const tarBytes = await gunzip(tgzBytes);

  // Parse tar and find entry named "cloudflared" (or with that basename)
  const binaryBytes = extractFromTar(tarBytes, 'cloudflared');
  if (!binaryBytes) {
    throw new Error('Could not find "cloudflared" binary inside .tgz archive.');
  }

  await writeFile(partPath, binaryBytes);
}

function gunzip(input: Uint8Array): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const gz = createGunzip();
    const chunks: Buffer[] = [];
    gz.on('data', (chunk: Buffer) => chunks.push(chunk));
    gz.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    gz.on('error', reject);
    gz.write(Buffer.from(input));
    gz.end();
  });
}

/**
 * Minimal in-memory POSIX/GNU tar parser.
 * Returns the content of the first entry whose name equals `targetName` (basename match).
 */
function extractFromTar(tarBytes: Uint8Array, targetName: string): Uint8Array | null {
  const buf = Buffer.from(tarBytes);
  let offset = 0;

  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);

    // Check for end-of-archive (two 512-byte zero blocks)
    if (isZeroBlock(header)) {
      break;
    }

    // Name: 100 bytes at offset 0
    const rawName = readCString(header, 0, 100);

    // File size: octal string at offset 124, 12 bytes
    const sizeStr = readCString(header, 124, 12);
    const fileSize = parseInt(sizeStr, 8);

    // Type flag at offset 156 — '0' or '\0' = regular file
    const typeFlag = String.fromCharCode(header[156] ?? 0);
    const isRegular = typeFlag === '0' || typeFlag === '\0';

    offset += 512; // skip header

    if (isRegular && fileSize > 0) {
      const content = buf.subarray(offset, offset + fileSize);

      // Match: exact name, or basename matches
      const basename = rawName.split('/').pop() ?? rawName;
      if (basename === targetName || rawName === targetName) {
        return new Uint8Array(content);
      }
    }

    // Skip content (rounded up to 512-byte blocks)
    const paddedSize = Math.ceil(fileSize / 512) * 512;
    offset += paddedSize;
  }

  return null;
}

function isZeroBlock(block: Uint8Array): boolean {
  for (let i = 0; i < block.length; i++) {
    if ((block[i] ?? 0) !== 0) return false;
  }
  return true;
}

function readCString(buf: Buffer, offset: number, maxLen: number): string {
  const end = buf.indexOf(0, offset);
  const actualEnd = end === -1 || end > offset + maxLen ? offset + maxLen : end;
  return buf.subarray(offset, actualEnd).toString('ascii').trim();
}
