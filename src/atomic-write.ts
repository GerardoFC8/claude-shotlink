/**
 * atomic-write.ts
 *
 * Shared helper for atomic file writes.
 * Writes to a temp file in the same directory, then renames atomically.
 * A crash mid-write leaves the temp file behind — never corrupts the target.
 *
 * File mode defaults to 0o600.
 */
import { writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface WriteAtomicOpts {
  /** File mode bits (default: 0o600) */
  mode?: number;
  /** Prefix for the temp file name (default: ".atomic-tmp-") */
  tmpPrefix?: string;
}

/**
 * Write `data` to `targetPath` atomically.
 * Creates parent directories as needed.
 * On failure the temp file is cleaned up and the original target is untouched.
 *
 * @param targetPath  Absolute path of the destination file.
 * @param data        String or binary data to write.
 * @param opts        Optional mode and tmpPrefix.
 */
export async function writeAtomic(
  targetPath: string,
  data: string | Uint8Array,
  opts: WriteAtomicOpts = {}
): Promise<void> {
  const mode = opts.mode ?? 0o600;
  const prefix = opts.tmpPrefix ?? '.atomic-tmp-';
  const dir = dirname(targetPath);

  await mkdir(dir, { recursive: true });

  const tmpPath = join(dir, `${prefix}${randomBytes(6).toString('hex')}`);
  try {
    await writeFile(tmpPath, data, { mode, encoding: typeof data === 'string' ? 'utf8' : undefined });
    await rename(tmpPath, targetPath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      // Best effort
    }
    throw err;
  }
}
