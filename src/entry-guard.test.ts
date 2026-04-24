import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isEntryPoint } from './entry-guard.js';

describe('isEntryPoint', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'entry-guard-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns true when argv[1] matches the module path exactly', async () => {
    const script = join(dir, 'script.js');
    await writeFile(script, '// stub\n');
    const metaUrl = pathToFileURL(script).href;
    expect(isEntryPoint(script, metaUrl)).toBe(true);
  });

  it('returns true when argv[1] is a symlink pointing at the module (global install case)', async () => {
    const real = join(dir, 'real-cli.js');
    await writeFile(real, '// stub\n');
    const link = join(dir, 'claude-shotlink');
    await symlink(real, link);
    const metaUrl = pathToFileURL(real).href;
    expect(isEntryPoint(link, metaUrl)).toBe(true);
  });

  it('returns true when argv[1] is a nested symlink chain', async () => {
    const real = join(dir, 'real-cli.js');
    await writeFile(real, '// stub\n');
    const link1 = join(dir, 'link-1');
    const link2 = join(dir, 'link-2');
    await symlink(real, link1);
    await symlink(link1, link2);
    const metaUrl = pathToFileURL(real).href;
    expect(isEntryPoint(link2, metaUrl)).toBe(true);
  });

  it('returns false when argv[1] points at a different file', async () => {
    const moduleFile = join(dir, 'module.js');
    const otherFile = join(dir, 'other.js');
    await writeFile(moduleFile, '// stub\n');
    await writeFile(otherFile, '// stub\n');
    const metaUrl = pathToFileURL(moduleFile).href;
    expect(isEntryPoint(otherFile, metaUrl)).toBe(false);
  });

  it('returns false when argv[1] is undefined', async () => {
    const script = join(dir, 'script.js');
    await writeFile(script, '// stub\n');
    expect(isEntryPoint(undefined, pathToFileURL(script).href)).toBe(false);
  });

  it('returns false when argv[1] does not exist on disk (realpath throws)', async () => {
    const script = join(dir, 'script.js');
    await writeFile(script, '// stub\n');
    const missing = join(dir, 'does-not-exist');
    expect(isEntryPoint(missing, pathToFileURL(script).href)).toBe(false);
  });

  it('returns false when metaUrl resolves to a file that does not exist', () => {
    const missing = join(dir, 'missing.js');
    expect(isEntryPoint('/usr/bin/node', pathToFileURL(missing).href)).toBe(false);
  });
});
