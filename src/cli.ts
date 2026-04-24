/**
 * cli.ts
 *
 * CLI dispatcher for claude-shotlink.
 *
 * Each command is an exported handler function taking (argv, deps, io) and
 * returning a Promise<number> (exit code). This makes them unit-testable
 * without spawning a child process.
 *
 * defaultDeps() wires the real implementations.
 * The main() entry point at the bottom parses process.argv and dispatches.
 *
 * Commands:
 *   start [--port <n>] [--ttl <seconds>]
 *   stop
 *   status
 *   install-hook
 *   uninstall-hook [--restore]
 *   rotate-key
 *   logs [--tail]
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

import { ensureConfig, loadConfig, rotateApiKey as rotateApiKeyImpl } from './config.js';
import { Storage } from './storage.js';
import { startServer as startServerImpl } from './server.js';
import { ensureBinary as ensureBinaryImpl } from './cloudflared-bin.js';
import { createTunnel as createTunnelImpl } from './tunnel.js';
import {
  installHook as installHookImpl,
  uninstallHook as uninstallHookImpl,
  listBackups as listBackupsImpl,
  restoreBackup as restoreBackupImpl,
} from './settings-patcher.js';
import {
  writePidFile as writePidFileImpl,
  readPidFile as readPidFileImpl,
  deletePidFile as deletePidFileImpl,
  isProcessAlive as isProcessAliveImpl,
} from './pid.js';
import {
  appendLog as appendLogImpl,
  readTail as readTailImpl,
  followTail as followTailImpl,
} from './logger.js';

// ── Re-exported types for tests ───────────────────────────────────────────────

export type { Config } from './config.js';

export interface ServerHandle {
  port: number;
  host: string;
  close: () => Promise<void>;
}

export interface TunnelHandle {
  readonly publicUrl: string | null;
  stop(gracefulMs?: number): Promise<void>;
  onUrlReady(cb: (url: string) => void): () => void;
  onDrop(cb: () => void): () => void;
}

export interface PidMetaResult {
  pid: number;
  port: number;
  tunnelUrl: string | null;
  startedAt: string;
}

export interface InstallHookResult {
  action: 'installed' | 'already-present';
  backupPath: string | null;
}

export interface UninstallHookResult {
  action: 'removed' | 'not-present';
  backupPath: string | null;
  removedCount: number;
}

export interface RestoreBackupResult {
  action: 'restored' | 'no-backup';
  backupUsed: string | null;
}

export interface StorageInstance {
  init(): Promise<void>;
  shutdown(): Promise<void>;
  stats(): { entries: number; totalBytes: number };
}

// ── Dependency injection contract ─────────────────────────────────────────────

export interface CliDeps {
  ensureConfig: () => Promise<{ apiKey: string; createdAt: string }>;
  loadConfig: () => Promise<{ apiKey: string; createdAt: string }>;
  rotateApiKey: () => Promise<{ apiKey: string; createdAt: string }>;
  StorageFactory: () => StorageInstance;
  startServer: (opts: {
    config: { apiKey: string; createdAt: string };
    storage: StorageInstance;
    port: number;
    host?: string;
    publicBaseUrl?: () => string | null;
  }) => Promise<ServerHandle>;
  ensureBinary: () => Promise<string>;
  createTunnel: (opts: {
    localPort: number;
    binaryPath: string;
  }) => Promise<TunnelHandle>;
  installHook: (opts: {
    settingsPath: string;
    hookCommand: string;
    matcher: string;
    sentinel: string;
  }) => Promise<InstallHookResult>;
  uninstallHook: (opts: {
    settingsPath: string;
    sentinel: string;
  }) => Promise<UninstallHookResult>;
  listBackups: (settingsDir: string) => Promise<string[]>;
  restoreBackup: (opts: {
    settingsDir: string;
    settingsPath: string;
  }) => Promise<RestoreBackupResult>;
  writePidFile: (meta: PidMetaResult) => Promise<void>;
  readPidFile: () => Promise<PidMetaResult | null>;
  deletePidFile: () => Promise<void>;
  isProcessAlive: (pid: number) => boolean;
  appendLog: (rec: object, path?: string, enabled?: boolean) => Promise<void>;
  readTail: (n: number, path?: string) => Promise<string[]>;
  followTail: (onLine: (line: string) => void, path?: string) => () => void;
}

// ── IO abstraction ────────────────────────────────────────────────────────────

export interface CliIO {
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  fetchImpl?: typeof fetch;
  /** Called after server+tunnel are both up and PID written */
  onServerReady?: () => void;
  /** If true, handler exits 0 immediately after onServerReady is invoked */
  abortAfterReady?: boolean;
  /**
   * Injectable exit function for tests. Defaults to process.exit.
   * When injected, the handleStart TTL/signal shutdown calls this instead
   * of process.exit so tests can capture the exit code.
   */
  exitFn?: (code: number) => void;
}

// ── defaultDeps ───────────────────────────────────────────────────────────────

/** Resolve absolute path to dist/hook.js from this module's location */
function resolveHookPath(): string {
  try {
    // When running from dist/, __filename resolves as dist/cli.js
    const _require = createRequire(import.meta.url);
    return _require.resolve('@gerardofc/claude-shotlink/dist/hook.js');
  } catch {
    // Fallback: relative to src/cli.ts (dev mode)
    const __filename = fileURLToPath(import.meta.url);
    return join(dirname(__filename), '..', 'dist', 'hook.js');
  }
}

export function defaultDeps(): CliDeps {
  return {
    ensureConfig,
    loadConfig,
    rotateApiKey: rotateApiKeyImpl,
    StorageFactory: () => new Storage() as unknown as StorageInstance,
    startServer: startServerImpl as unknown as CliDeps['startServer'],
    ensureBinary: ensureBinaryImpl,
    createTunnel: createTunnelImpl,
    installHook: (opts) =>
      installHookImpl(opts) as Promise<InstallHookResult>,
    uninstallHook: (opts) =>
      uninstallHookImpl(opts) as Promise<UninstallHookResult>,
    listBackups: listBackupsImpl,
    restoreBackup: restoreBackupImpl as unknown as CliDeps['restoreBackup'],
    writePidFile: writePidFileImpl,
    readPidFile: readPidFileImpl,
    deletePidFile: deletePidFileImpl,
    isProcessAlive: isProcessAliveImpl,
    appendLog: appendLogImpl as unknown as CliDeps['appendLog'],
    readTail: readTailImpl,
    followTail: followTailImpl,
  };
}

// ── dispatch ──────────────────────────────────────────────────────────────────

/**
 * Main dispatcher. Takes argv (everything after the binary name) and returns
 * an exit code.
 */
export async function dispatch(
  argv: string[],
  deps: CliDeps,
  io: CliIO = {}
): Promise<number> {
  const out = io.stdout ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = io.stderr ?? ((s: string) => process.stderr.write(s + '\n'));

  const cmd = argv[0] ?? 'start';

  switch (cmd) {
    case 'start':
      return handleStart(argv, deps, io);

    case 'stop':
      return handleStop(deps, { ...io, stdout: out, stderr: err });

    case 'status':
      return handleStatus(deps, { ...io, stdout: out, stderr: err });

    case 'install-hook':
      return handleInstallHook(deps, { stdout: out, stderr: err });

    case 'uninstall-hook':
      return handleUninstallHook(argv, deps, { stdout: out, stderr: err });

    case 'rotate-key':
      return handleRotateKey(deps, { stdout: out, stderr: err });

    case 'logs':
      return handleLogs(argv, deps, { ...io, stdout: out, stderr: err });

    default:
      err(`Unknown command: ${cmd}`);
      err('Usage: claude-shotlink <start|stop|status|install-hook|uninstall-hook|rotate-key|logs>');
      return 1;
  }
}

// ── handleStart ───────────────────────────────────────────────────────────────

export async function handleStart(
  argv: string[],
  deps: CliDeps,
  io: CliIO = {}
): Promise<number> {
  const out = io.stdout ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = io.stderr ?? ((s: string) => process.stderr.write(s + '\n'));

  // Parse flags
  let port = 0;
  let ttlSeconds: number | null = null;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--port' && argv[i + 1]) {
      const rawPort = parseInt(argv[++i]!, 10);
      if (!Number.isFinite(rawPort) || rawPort < 1 || rawPort > 65535) {
        err(`Invalid --port value: "${argv[i]}" (must be an integer between 1 and 65535)`);
        return 1;
      }
      port = rawPort;
    } else if (arg === '--ttl' && argv[i + 1]) {
      const rawTtl = parseInt(argv[++i]!, 10);
      if (!Number.isFinite(rawTtl) || rawTtl < 1) {
        err(`Invalid --ttl value: "${argv[i]}" (must be a positive integer)`);
        return 1;
      }
      ttlSeconds = rawTtl;
    }
  }

  // Double-start guard
  const existingPid = await deps.readPidFile();
  if (existingPid !== null) {
    err(`Relay already running (pid ${existingPid.pid})`);
    return 1;
  }

  // Initialize storage + config
  const config = await deps.ensureConfig();
  const storage = deps.StorageFactory();
  await storage.init();

  // Start HTTP server first (no tunnel yet — publicBaseUrl is late-bound)
  let tunnelHandle: TunnelHandle | null = null;
  const getPublicBaseUrl = (): string | null => tunnelHandle?.publicUrl ?? null;

  let server: ServerHandle;
  try {
    server = await deps.startServer({
      config,
      storage,
      port,
      host: '127.0.0.1',
      publicBaseUrl: getPublicBaseUrl,
    });
  } catch (e) {
    err(`Failed to start server: ${String(e)}`);
    await storage.shutdown();
    return 1;
  }

  // Ensure cloudflared binary, then start tunnel
  let binaryPath: string;
  try {
    err('Ensuring cloudflared binary...');
    binaryPath = await deps.ensureBinary();
  } catch (e) {
    err(`Failed to acquire cloudflared binary: ${String(e)}`);
    await server.close();
    await storage.shutdown();
    return 1;
  }

  try {
    tunnelHandle = await deps.createTunnel({
      localPort: server.port,
      binaryPath,
    });
  } catch (e) {
    err(`Failed to start tunnel: ${String(e)}`);
    await server.close();
    await storage.shutdown();
    return 1;
  }

  // Write PID file (after both server and tunnel are up)
  await deps.writePidFile({
    pid: process.pid,
    port: server.port,
    tunnelUrl: tunnelHandle.publicUrl,
    startedAt: new Date().toISOString(),
  });

  // Print banner
  const localUrl = `http://127.0.0.1:${server.port}`;
  const tunnelUrl = tunnelHandle.publicUrl ?? '(no tunnel)';
  out('claude-shotlink running');
  out(`  local:   ${localUrl}`);
  out(`  tunnel:  ${tunnelUrl}`);
  out(`  key:     ${config.apiKey}`);

  // Notify test harness that startup is complete
  io.onServerReady?.();

  if (io.abortAfterReady) {
    // Test mode: clean up and exit
    await server.close();
    await tunnelHandle.stop();
    await storage.shutdown();
    await deps.deletePidFile();
    return 0;
  }

  // ── Shutdown function ─────────────────────────────────────────────────────
  const exitFn = io.exitFn ?? ((code: number) => process.exit(code));
  let shuttingDown = false;
  // Used to resolve the await-forever promise in test scenarios
  let resolveShutdown: (() => void) | null = null;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await server.close();
    await tunnelHandle!.stop();
    await storage.shutdown();
    await deps.deletePidFile();
    resolveShutdown?.();
    exitFn(0);
  };

  // ── TTL shutdown timer ────────────────────────────────────────────────────
  if (ttlSeconds !== null) {
    setTimeout(() => void shutdown(), ttlSeconds * 1000);
  }

  // ── Signal handlers ────────────────────────────────────────────────────────
  const sigintHandler = (): void => void shutdown();
  const sigtermHandler = (): void => void shutdown();
  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);

  // ── Await forever (until signal, TTL, or shutdown completes) ──────────────
  await new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });

  // Clean up signal handlers to avoid leaking
  process.off('SIGINT', sigintHandler);
  process.off('SIGTERM', sigtermHandler);

  return 0;
}

// ── handleStop ────────────────────────────────────────────────────────────────

export async function handleStop(
  deps: CliDeps,
  io: { stdout: (s: string) => void; stderr: (s: string) => void }
): Promise<number> {
  const existing = await deps.readPidFile();
  if (existing === null) {
    io.stdout('No relay running.');
    return 0;
  }

  // Send SIGTERM and poll for PID file deletion
  try {
    process.kill(existing.pid, 'SIGTERM');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EPERM') {
      io.stderr(
        `Cannot signal relay (EPERM) — try stopping it as the same user that started it.`
      );
      // Do NOT delete the PID file — the relay is still running
      return 1;
    }
    // ESRCH: process already exited — continue to cleanup below
  }

  // Poll for up to 5 seconds
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 200));
    const still = await deps.readPidFile();
    if (still === null) return 0;
  }

  // Force kill
  try {
    process.kill(existing.pid, 'SIGKILL');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EPERM') {
      io.stderr(
        `Cannot SIGKILL relay pid=${existing.pid} (EPERM) — likely owned by another user; not deleting PID file.`
      );
      return 1;
    }
    // ESRCH: already dead — continue to cleanup below
  }
  await deps.deletePidFile();
  return 0;
}

// ── handleStatus ──────────────────────────────────────────────────────────────

export async function handleStatus(
  deps: CliDeps,
  io: {
    stdout: (s: string) => void;
    stderr: (s: string) => void;
    fetchImpl?: typeof fetch;
  }
): Promise<number> {
  const pidMeta = await deps.readPidFile();

  if (pidMeta === null) {
    io.stdout('Relay is not running.');
    return 1;
  }

  // Load config for API key
  let apiKey = 'unknown';
  try {
    const config = await deps.loadConfig();
    apiKey = config.apiKey;
  } catch {
    // continue without apiKey
  }

  // Health probe
  let healthOk = false;
  let entries = 0;
  const fetchFn = io.fetchImpl ?? fetch;
  try {
    const healthUrl = `http://127.0.0.1:${pidMeta.port}/health`;
    const res = await fetchFn(healthUrl, {
      headers: { 'X-Api-Key': apiKey },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const body = await res.json() as { ok: boolean; entries: number };
      healthOk = body.ok;
      entries = body.entries;
    }
  } catch {
    // Health probe failed — relay may be starting up or unreachable
  }

  io.stdout(`Relay is running`);
  io.stdout(`  pid:       ${pidMeta.pid}`);
  io.stdout(`  port:      ${pidMeta.port}`);
  io.stdout(`  tunnel:    ${pidMeta.tunnelUrl ?? '(none)'}`);
  io.stdout(`  startedAt: ${pidMeta.startedAt}`);
  io.stdout(`  health:    ${healthOk ? 'ok' : 'unreachable'} (entries: ${entries})`);

  return 0;
}

// ── handleInstallHook ─────────────────────────────────────────────────────────

export async function handleInstallHook(
  deps: CliDeps,
  io: { stdout: (s: string) => void; stderr: (s: string) => void },
  _hookPathExistsOverride?: (p: string) => boolean,
): Promise<number> {
  // Resolve settings path
  const { join: pathJoin } = await import('node:path');
  const { homedir } = await import('node:os');
  const { existsSync } = await import('node:fs');
  const settingsPath = pathJoin(homedir(), '.claude', 'settings.json');

  let hookPath: string;
  try {
    hookPath = resolveHookPath();
  } catch (e) {
    io.stderr(`Cannot resolve hook path: ${String(e)}`);
    io.stderr('Run "pnpm build" first or reinstall the package.');
    return 1;
  }

  const hookExists = _hookPathExistsOverride ?? existsSync;
  if (!hookExists(hookPath)) {
    io.stderr(`Hook binary not found at: ${hookPath}`);
    io.stderr('Run "pnpm build" first or reinstall the package.');
    return 1;
  }

  // Use JSON.stringify to produce a properly shell-quoted path (handles spaces)
  const hookCommand = `node ${JSON.stringify(hookPath)}`;

  try {
    const result = await deps.installHook({
      settingsPath,
      hookCommand,
      matcher: 'Bash|Write',
      sentinel: hookPath,
    });

    if (result.action === 'already-present') {
      io.stdout('Hook already installed.');
    } else {
      io.stdout(`Hook installed successfully.`);
      if (result.backupPath) {
        io.stdout(`  backup: ${result.backupPath}`);
      }
    }
    return 0;
  } catch (e) {
    io.stderr(`Failed to install hook: ${String(e)}`);
    return 1;
  }
}

// ── handleUninstallHook ───────────────────────────────────────────────────────

export async function handleUninstallHook(
  argv: string[],
  deps: CliDeps,
  io: { stdout: (s: string) => void; stderr: (s: string) => void }
): Promise<number> {
  const { join: pathJoin, dirname: pathDirname } = await import('node:path');
  const { homedir } = await import('node:os');
  const settingsPath = pathJoin(homedir(), '.claude', 'settings.json');
  const settingsDir = pathDirname(settingsPath);
  const hookPath = resolveHookPath();
  const restore = argv.includes('--restore');

  if (restore) {
    try {
      const result = await deps.restoreBackup({ settingsDir, settingsPath });
      if (result.action === 'no-backup') {
        io.stdout('No backup found to restore.');
      } else {
        io.stdout(`Restored from backup: ${result.backupUsed ?? 'unknown'}`);
      }
      return 0;
    } catch (e) {
      io.stderr(`Failed to restore backup: ${String(e)}`);
      return 1;
    }
  }

  try {
    const result = await deps.uninstallHook({ settingsPath, sentinel: hookPath });
    if (result.action === 'not-present') {
      io.stdout('Hook not installed.');
    } else {
      io.stdout(`Hook removed (${result.removedCount} entry removed).`);
    }
    return 0;
  } catch (e) {
    io.stderr(`Failed to uninstall hook: ${String(e)}`);
    return 1;
  }
}

// ── handleRotateKey ───────────────────────────────────────────────────────────

export async function handleRotateKey(
  deps: CliDeps,
  io: { stdout: (s: string) => void; stderr: (s: string) => void }
): Promise<number> {
  const config = await deps.rotateApiKey();
  io.stdout(config.apiKey);
  io.stderr('Restart the relay to apply the new key.');
  return 0;
}

// ── handleLogs ────────────────────────────────────────────────────────────────

export async function handleLogs(
  argv: string[],
  deps: CliDeps,
  io: {
    stdout: (s: string) => void;
    stderr: (s: string) => void;
    onServerReady?: () => void;
  }
): Promise<number> {
  const tail = argv.includes('--tail');

  if (tail) {
    // Stream mode: follow the log file until SIGINT
    return new Promise<number>((resolve) => {
      const unsubscribe = deps.followTail((line) => {
        io.stdout(line);
      });

      const cleanup = (): void => {
        process.removeListener('SIGINT', cleanup);
        unsubscribe();
        resolve(0);
      };

      process.once('SIGINT', cleanup);
    });
  }

  // One-shot: read last 100 lines
  const lines = await deps.readTail(100);
  if (lines.length === 0) {
    io.stdout('No log file found.');
  } else {
    for (const line of lines) {
      io.stdout(line);
    }
  }
  return 0;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // argv[0] = node, argv[1] = script path, argv[2..] = command args
  const argv = process.argv.slice(2);
  const deps = defaultDeps();
  const code = await dispatch(argv, deps);
  process.exit(code);
}

// Only run main when this file is the actual entry point.
// The equality check covers `tsx src/cli.ts` (tsx sets argv[1] to the real source
// path) and `node dist/cli.js` (import.meta.url resolves to the dist file).
// We deliberately DO NOT add a broad '/*.ts' fallback to avoid triggering main()
// when any importer's argv[1] happens to end with 'cli.ts' (e.g., test files).
const _isCliMain =
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1]?.endsWith('/dist/cli.js');

if (_isCliMain) {
  main().catch((err) => {
    process.stderr.write(String(err) + '\n');
    process.exit(1);
  });
}
