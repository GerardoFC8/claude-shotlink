import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Returns true when this module is being executed as the entry point.
 *
 * Both `process.argv[1]` and `import.meta.url` are resolved through
 * `realpathSync` so the check survives:
 *   - Direct invocation (`node dist/cli.js`)
 *   - Symlink invocation (`npm install -g` puts a symlink under bin/)
 *   - Dev-mode invocation (`tsx src/cli.ts`)
 *
 * Any other importer (test runner, other binary) whose argv[1] does not
 * resolve to the same real path returns false — no broad suffix match,
 * no false positives.
 */
export function isEntryPoint(
  argv1: string | undefined,
  metaUrl: string,
): boolean {
  try {
    if (!argv1) return false;
    const realArgv1 = realpathSync(argv1);
    const realModule = realpathSync(fileURLToPath(metaUrl));
    return realArgv1 === realModule;
  } catch {
    return false;
  }
}
