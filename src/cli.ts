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
import { readFile as readFileAsync } from 'node:fs/promises';
import { homedir } from 'node:os';

import { ensureConfig, loadConfig, saveConfig as saveConfigImpl, rotateApiKey as rotateApiKeyImpl, HOSTNAME_RE } from './config.js';
import type { Config } from './config.js';
import { Storage } from './storage.js';
import { startServer as startServerImpl } from './server.js';
import { ensureBinary as ensureBinaryImpl } from './cloudflared-bin.js';
import { createTunnel as createTunnelImpl } from './tunnel.js';
import {
  installHook as installHookImpl,
  uninstallHook as uninstallHookImpl,
  listBackups as listBackupsImpl,
  restoreBackup as restoreBackupImpl,
  SHOTLINK_HOOK_SENTINEL,
} from './settings-patcher.js';
import {
  writePidFile as writePidFileImpl,
  readPidFile as readPidFileImpl,
  deletePidFile as deletePidFileImpl,
  isProcessAlive as isProcessAliveImpl,
  updatePidFileUrl as updatePidFileUrlImpl,
} from './pid.js';
import {
  appendLog as appendLogImpl,
  readTail as readTailImpl,
  followTail as followTailImpl,
} from './logger.js';
import {
  startHealthcheck as startHealthcheckImpl,
  type HealthcheckOptions,
  type HealthcheckHandle,
} from './healthcheck.js';
import { DedupCache, DEDUP_PATH } from './dedup-cache.js';
import { runSetupTunnel, defaultSetupTunnelDeps, type SetupTunnelInput, type SetupTunnelResult } from './setup-tunnel.js';

// ── Re-exported types for tests ───────────────────────────────────────────────

export type { Config } from './config.js';

/**
 * Orchestration state for handleStart. Lives in the handleStart closure.
 * The tunnel's own state field is informational; orchestration state lives here.
 *
 * running      — server up, tunnel up, healthcheck running
 * reconnecting — healthcheck triggered onFail, mid-replace
 * shuttingDown — SIGTERM/SIGINT/TTL fired (terminal)
 */
export type RelayState = 'running' | 'reconnecting' | 'shuttingDown';

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

/**
 * Options for createTunnel. v0.2: `tunnel` is optional — absent means quick mode.
 * Named mode: tunnel.mode === 'named' requires name + hostname.
 * v0.3: named mode optionally includes credentialsFile + localPort for inline-args spawn.
 */
export interface TunnelStartOpts {
  localPort: number;
  binaryPath: string;
  /** v0.2: when absent → quick-mode (v0.1 behavior). */
  tunnel?:
    | { mode: 'quick' }
    | {
        mode: 'named';
        name: string;
        hostname: string;
        /** v0.3: when present (with localPort), spawns with --credentials-file + --url */
        credentialsFile?: string;
        /** v0.3: local port for --url arg; required when credentialsFile is set */
        localPort?: number;
      };
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
  ensureConfig: () => Promise<Config>;
  loadConfig: () => Promise<Config>;
  rotateApiKey: () => Promise<Config>;
  StorageFactory: () => StorageInstance;
  startServer: (opts: {
    config: Config;
    storage: StorageInstance;
    port: number;
    host?: string;
    publicBaseUrl?: () => string | null;
  }) => Promise<ServerHandle>;
  ensureBinary: () => Promise<string>;
  createTunnel: (opts: TunnelStartOpts) => Promise<TunnelHandle>;
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
  /** v0.2: persist updated Config atomically. Used by configure-tunnel subcommand. */
  saveConfig: (cfg: Config) => Promise<void>;
  /** v0.2: update the tunnelUrl field in the PID file atomically (reconnect path). */
  updatePidFileUrl: (url: string | null) => Promise<void>;
  /** v0.2: delete the dedup cache file and reset in-memory state (reconnect path). */
  purgeDedupCache: () => Promise<void>;
  /** v0.2: start the edge healthcheck poll. Injectable for tests. */
  startHealthcheck: (opts: HealthcheckOptions) => HealthcheckHandle;
  /** v0.3: setup-tunnel wizard orchestration. Injected for testability. */
  setupTunnel: (input: SetupTunnelInput, configPath: string) => Promise<SetupTunnelResult>;
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
  /**
   * Injectable file-existence check for tests. Defaults to fs.existsSync.
   * Used by handleStart to verify tunnelCredentialsFile exists before spawning.
   */
  fileExists?: (p: string) => boolean;
}

// ── defaultDeps ───────────────────────────────────────────────────────────────

/** Read package.json version. Falls back to 'unknown' if neither path resolves. */
function resolveVersion(): string {
  const _require = createRequire(import.meta.url);
  try {
    const pkg = _require('@gerardofc/claude-shotlink/package.json') as { version: string };
    return pkg.version;
  } catch {
    try {
      const __filename = fileURLToPath(import.meta.url);
      const pkg = _require(join(dirname(__filename), '..', 'package.json')) as { version: string };
      return pkg.version;
    } catch {
      return 'unknown';
    }
  }
}

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
    saveConfig: saveConfigImpl,
    updatePidFileUrl: updatePidFileUrlImpl,
    purgeDedupCache: async () => {
      const cache = new DedupCache(DEDUP_PATH);
      await cache.purge();
    },
    startHealthcheck: startHealthcheckImpl,
    setupTunnel: async (input, configPath) => {
      const binaryPath = await ensureBinaryImpl();
      const deps = defaultSetupTunnelDeps(binaryPath, configPath, ensureConfig, saveConfigImpl);
      return runSetupTunnel(input, deps);
    },
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

  // Short-circuit: --version / -v / version
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    out(resolveVersion());
    return 0;
  }

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

    case 'setup-tunnel':
      return handleSetupTunnel(argv, deps, { stdout: out, stderr: err });

    case 'configure-tunnel':
      return handleConfigureTunnel(argv, deps, { stdout: out, stderr: err });

    default:
      err(`Unknown command: ${cmd}`);
      err('Usage: claude-shotlink <start|stop|status|install-hook|uninstall-hook|rotate-key|logs|setup-tunnel|configure-tunnel> [--version]');
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
  const fileExistsFn = io.fileExists ?? existsSync;

  // Parse flags
  let port = 0;
  let ttlSeconds: number | null = null;
  let cliTunnelName: string | undefined;
  let cliTunnelHostname: string | undefined;

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
    } else if (arg === '--tunnel-name' && argv[i + 1]) {
      cliTunnelName = argv[++i];
    } else if (arg === '--tunnel-hostname' && argv[i + 1]) {
      cliTunnelHostname = argv[++i];
    }
  }

  // Validate CLI tunnel flag completeness early (before any async ops)
  if (cliTunnelName !== undefined && cliTunnelHostname === undefined) {
    err('Both --tunnel-name and --tunnel-hostname are required for named mode. Missing: --tunnel-hostname');
    return 1;
  }
  if (cliTunnelHostname !== undefined && cliTunnelName === undefined) {
    err('Both --tunnel-name and --tunnel-hostname are required for named mode. Missing: --tunnel-name');
    return 1;
  }
  // FIX-8: validate hostname shape immediately after parsing
  if (cliTunnelHostname !== undefined && !HOSTNAME_RE.test(cliTunnelHostname)) {
    err(
      `Invalid --tunnel-hostname: "${cliTunnelHostname}" — expected a bare hostname (no scheme, no path), e.g. "shots.example.com".`,
    );
    return 1;
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

  // Resolve tunnel mode: CLI flags > config > default 'quick'
  let resolvedTunnelOpts: TunnelStartOpts['tunnel'];

  if (cliTunnelName !== undefined && cliTunnelHostname !== undefined) {
    // CLI flags win — named mode (legacy v0.2 CLI path; no credentials file here)
    resolvedTunnelOpts = { mode: 'named', name: cliTunnelName, hostname: cliTunnelHostname };
  } else if (config.tunnelMode === 'named') {
    // Config says named — validate completeness
    if (!config.tunnelName || !config.tunnelHostname) {
      err(
        'Config has tunnelMode="named" but tunnelName or tunnelHostname is missing. ' +
        'Run `claude-shotlink configure-tunnel` to fix.',
      );
      await server.close();
      await storage.shutdown();
      return 1;
    }

    // v0.3: if credentials file is configured, guard that it exists before spawning
    if (config.tunnelCredentialsFile) {
      if (!fileExistsFn(config.tunnelCredentialsFile)) {
        err(
          `Credentials file not found at ${config.tunnelCredentialsFile}. ` +
          `Re-run \`claude-shotlink setup-tunnel --name ${config.tunnelName} --hostname ${config.tunnelHostname}\` to recreate.`,
        );
        await server.close();
        await storage.shutdown();
        return 1;
      }

      // FIX-3: validate credentials JSON shape before spawning cloudflared.
      // A bogus path that exists but has wrong content produces a cryptic cloudflared
      // spawn error. Fail fast with a clear message instead.
      // JD Round 2 (C1 + SA-2): each failure mode gets a distinct, actionable message
      // so users diagnosing EACCES vs malformed JSON vs missing fields aren't misled.
      let credsRaw: string;
      try {
        credsRaw = await readFileAsync(config.tunnelCredentialsFile, 'utf8');
      } catch (e) {
        err(
          `Cannot read credentials file at '${config.tunnelCredentialsFile}': ${String(e)}. ` +
          `Check file permissions, or re-run setup-tunnel.`,
        );
        await server.close();
        await storage.shutdown();
        return 1;
      }
      let credsParsed: unknown;
      try {
        credsParsed = JSON.parse(credsRaw);
      } catch (e) {
        err(
          `Credentials file at '${config.tunnelCredentialsFile}' contains invalid JSON: ${String(e)}. ` +
          `Fix the file manually or re-run setup-tunnel.`,
        );
        await server.close();
        await storage.shutdown();
        return 1;
      }
      const credsObj = (credsParsed !== null && typeof credsParsed === 'object') ? credsParsed as Record<string, unknown> : {};
      if (typeof credsObj['TunnelID'] !== 'string' || typeof credsObj['TunnelName'] !== 'string') {
        err(
          `Credentials file at '${config.tunnelCredentialsFile}' is missing required fields ` +
          `(TunnelID and TunnelName). Re-run setup-tunnel to recreate.`,
        );
        await server.close();
        await storage.shutdown();
        return 1;
      }
    }

    // FIX-1: resolve effective local port — CLI --port ALWAYS overrides config
    // tunnelLocalPort when present, regardless of credentialsFile presence.
    // Previously the condition gated on credentialsFile which silently ignored
    // --port when named-mode config had no credentials file.
    let effectiveLocalPort: number | undefined = config.tunnelLocalPort;
    if (port !== 0) {
      // A CLI --port was specified; warn if it differs from config tunnelLocalPort
      if (config.tunnelCredentialsFile && config.tunnelLocalPort !== undefined && port !== config.tunnelLocalPort) {
        err(
          `WARNING: --port ${port} overrides tunnelLocalPort=${config.tunnelLocalPort} from config. ` +
          `The tunnel was set up to proxy to port ${config.tunnelLocalPort}; cloudflared will fail to reach ` +
          `127.0.0.1:${port}. Re-run setup-tunnel with --port ${port} to fix.`,
        );
      }
      effectiveLocalPort = port;
    }

    resolvedTunnelOpts = {
      mode: 'named',
      name: config.tunnelName,
      hostname: config.tunnelHostname,
      // v0.3: pass through credentials file + port when present; absent → legacy path
      ...(config.tunnelCredentialsFile
        ? {
            credentialsFile: config.tunnelCredentialsFile,
            localPort: effectiveLocalPort ?? server.port,
          }
        : {}),
    };
  } else {
    // Default: quick mode
    resolvedTunnelOpts = { mode: 'quick' };
  }

  try {
    tunnelHandle = await deps.createTunnel({
      localPort: server.port,
      binaryPath,
      tunnel: resolvedTunnelOpts,
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

  // ── State machine (initialized before onServerReady so tests can trigger it) ─
  const exitFn = io.exitFn ?? ((code: number) => process.exit(code));
  // Reads go through `getState()` so TS does not narrow across awaits —
  // `shutdown()` may mutate `_state` concurrently when SIGTERM races with
  // `onHealthcheckFail`. Function-call returns block control-flow narrowing.
  let _state: RelayState = 'running';
  const getState = (): RelayState => _state;
  // Used to resolve the await-forever promise. Initialized here so that
  // signal handlers registered before onServerReady can resolve it even
  // if the SIGTERM fires synchronously inside onServerReady.
  let resolveShutdown: (() => void) | null = null;
  const shutdownPromise = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });

  // ── Healthcheck setup ─────────────────────────────────────────────────────
  const QUICK_GRACE = 5_000;
  const NAMED_GRACE = 15_000;
  const FAIL_THRESHOLD = 3;
  const POLL_MS = 30_000;

  const resolvedMode = resolvedTunnelOpts?.mode ?? 'quick';

  let healthcheck: HealthcheckHandle | null = null;

  const startHc = (publicUrl: string): HealthcheckHandle => {
    return deps.startHealthcheck({
      publicUrl,
      graceMs: resolvedMode === 'named' ? NAMED_GRACE : QUICK_GRACE,
      intervalMs: POLL_MS,
      failThreshold: FAIL_THRESHOLD,
      onFail: () => void onHealthcheckFail(),
    });
  };

  // ── Reconnect handler ─────────────────────────────────────────────────────
  const onHealthcheckFail = async (): Promise<void> => {
    if (getState() !== 'running') return;

    if (resolvedMode === 'named') {
      // Named mode: warn only — hostname is stable, don't respawn
      err(
        `[healthcheck] ${FAIL_THRESHOLD} consecutive failures pinging ${tunnelHandle!.publicUrl}/health — ` +
        `Cloudflare edge unreachable. Hostname is stable; not restarting. Investigate DNS / tunnel status.`,
      );
      return;
    }

    // Quick mode: reconnect
    _state = 'reconnecting';
    err('[healthcheck] Quick tunnel unhealthy; reconnecting…');
    healthcheck?.stop();

    const oldHandle = tunnelHandle!;
    // Capture last known URL BEFORE stopping (stop() sets publicUrl → null)
    const lastKnownUrl = oldHandle.publicUrl;
    try {
      await oldHandle.stop();
    } catch {
      // best effort — cloudflared may already be dead
    }

    if (getState() === 'shuttingDown') return;

    let newHandle: TunnelHandle;
    try {
      newHandle = await deps.createTunnel({
        localPort: server.port,
        binaryPath,
        tunnel: { mode: 'quick' },
      });
    } catch (e) {
      // SIGTERM raced us during createTunnel — abandon, do not start a new healthcheck
      if (getState() === 'shuttingDown') return;
      err(`[healthcheck] Reconnect failed: ${String(e)}`);
      // Stay alive; retry on next healthcheck cycle.
      // Restart healthcheck unconditionally — if no URL, next ping fails and re-triggers.
      if (getState() === 'reconnecting') _state = 'running';
      const urlForHc = lastKnownUrl ?? tunnelHandle?.publicUrl;
      if (urlForHc) {
        healthcheck = startHc(urlForHc);
      } else {
        // No URL available — still restart with a placeholder so reconnect cycles continue
        healthcheck = startHc('http://127.0.0.1');
      }
      return;
    }

    if (getState() === 'shuttingDown') {
      await newHandle.stop().catch(() => {});
      return;
    }

    tunnelHandle = newHandle;
    // FIX-9: use null (not '') when no URL — matches PidMeta.tunnelUrl: string | null
    await deps.updatePidFileUrl(newHandle.publicUrl ?? null).catch((e) =>
      err(`[healthcheck] PID update failed: ${String(e)}`),
    );
    await deps.purgeDedupCache().catch(() => { /* benign */ });
    // SIGTERM may have raced us during PID/dedup awaits — re-check before
    // restoring 'running' state and starting a new healthcheck
    if (getState() === 'shuttingDown') {
      await newHandle.stop().catch(() => {});
      return;
    }
    out(`[healthcheck] reconnected: ${newHandle.publicUrl}`);
    _state = 'running';
    if (newHandle.publicUrl) {
      healthcheck = startHc(newHandle.publicUrl);
    }
  };

  // ── Shutdown function ─────────────────────────────────────────────────────
  const shutdown = async (): Promise<void> => {
    if (getState() === 'shuttingDown') return;
    _state = 'shuttingDown';
    healthcheck?.stop();
    try {
      await server.close();
    } catch { /* best effort */ }
    try {
      await tunnelHandle!.stop();
    } catch { /* best effort */ }
    try {
      await storage.shutdown();
    } catch { /* best effort */ }
    try {
      await deps.deletePidFile();
    } catch { /* best effort */ }
    resolveShutdown?.();
    exitFn(0);
  };

  // ── Start healthcheck (after tunnel up and PID written) ───────────────────
  if (tunnelHandle.publicUrl) {
    healthcheck = startHc(tunnelHandle.publicUrl);
  }

  // ── TTL shutdown timer ────────────────────────────────────────────────────
  if (ttlSeconds !== null) {
    setTimeout(() => void shutdown(), ttlSeconds * 1000);
  }

  // ── Signal handlers — registered BEFORE onServerReady so tests can emit signals ──
  const sigintHandler = (): void => void shutdown();
  const sigtermHandler = (): void => void shutdown();
  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);

  // ── Notify test harness that startup is complete ──────────────────────────
  // NOTE: Called AFTER state machine is initialized (including signal handlers)
  // so onServerReady callbacks can trigger reconnects, shutdowns, etc. without
  // race conditions.
  io.onServerReady?.();

  if (io.abortAfterReady) {
    // Test mode: clean up and exit — remove signal handlers before returning
    process.off('SIGINT', sigintHandler);
    process.off('SIGTERM', sigtermHandler);
    healthcheck?.stop();
    await server.close();
    await tunnelHandle.stop();
    await storage.shutdown();
    await deps.deletePidFile();
    return 0;
  }

  // ── Await forever (until signal, TTL, or shutdown completes) ──────────────
  await shutdownPromise;

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
      sentinel: SHOTLINK_HOOK_SENTINEL,
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
    const result = await deps.uninstallHook({ settingsPath, sentinel: SHOTLINK_HOOK_SENTINEL });
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

// ── handleSetupTunnel ─────────────────────────────────────────────────────────

/**
 * `setup-tunnel` subcommand handler (CA-1, B5, TASK-016/017).
 *
 * Accepts:
 *   --name <name>         (required, defaults to "shotlink")
 *   --hostname <fqdn>     (required)
 *   --port <n>            (optional, defaults to 7331)
 *   --skip-dns            (optional, skips DNS routing step)
 *
 * Parses flags, calls deps.setupTunnel (the orchestration module), and
 * prints success/failure messages. On success, config is written by the
 * setup-tunnel module before returning.
 *
 * Exit codes:
 *   0 — tunnel created + config written (DNS may have failed but is recoverable)
 *   1 — missing cert, invalid flags, or create/parse failed
 */
export async function handleSetupTunnel(
  argv: string[],
  deps: CliDeps,
  io: { stdout: (s: string) => void; stderr: (s: string) => void },
): Promise<number> {
  const out = io.stdout;
  const err = io.stderr;

  let name = 'shotlink';
  let hostname: string | undefined;
  let port = 7331;
  let skipDns = false;

  // Parse flags
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--name' && argv[i + 1]) {
      name = argv[++i]!;
    } else if (arg === '--hostname' && argv[i + 1]) {
      hostname = argv[++i];
    } else if (arg === '--port' && argv[i + 1]) {
      const rawPort = parseInt(argv[++i]!, 10);
      if (!Number.isFinite(rawPort) || rawPort < 1 || rawPort > 65535) {
        err(`Invalid --port value: "${argv[i]}" (must be an integer between 1 and 65535)`);
        return 1;
      }
      port = rawPort;
    } else if (arg === '--skip-dns') {
      skipDns = true;
    }
  }

  // Validate required flags
  if (!hostname) {
    err('setup-tunnel requires both --name and --hostname.');
    err('Usage: setup-tunnel --name <tunnel> --hostname <fqdn> [--port 7331] [--skip-dns]');
    return 1;
  }

  // Validate hostname shape (CA-1.1)
  if (!HOSTNAME_RE.test(hostname)) {
    err(
      `Invalid --hostname: "${hostname}" — expected a bare hostname (no scheme, no path), e.g. "shots.example.com".`,
    );
    return 1;
  }

  // Find CONFIG_PATH — use the same path as ensureConfig
  const CONFIG_PATH = join(homedir(), '.claude-shotlink', 'config.json');

  // Call the setup-tunnel orchestration module
  const result = await deps.setupTunnel({ name, hostname, port, skipDns }, CONFIG_PATH);

  if (!result.ok) {
    // Failure cases
    err(result.message);
    if (result.recoveryHint) {
      err(`  hint: ${result.recoveryHint}`);
    }
    return 1;
  }

  // Success case (ok: true).
  // FIX-4: setup-tunnel module already saves all 5 fields (tunnelMode, tunnelName,
  // tunnelHostname, tunnelCredentialsFile, tunnelLocalPort) atomically inside
  // runSetupTunnel. The previous redundant saveConfig call here could silently
  // overwrite if the two saves diverged, so it is removed.

  // Print success summary
  out(`Tunnel created successfully`);
  out(`  name:      ${name}`);
  out(`  hostname:  ${hostname}`);
  out(`  UUID:      ${result.uuid}`);
  out(`  creds:     ${result.credentialsFile}`);

  if (result.dnsManualCommand) {
    out(`  DNS:       manual (run: ${result.dnsManualCommand})`);
  } else if (result.dnsRouted) {
    out(`  DNS:       routed`);
  }

  out(`\nConfig written. Next: claude-shotlink start`);
  return 0;
}

// ── handleConfigureTunnel ─────────────────────────────────────────────────────

/**
 * `configure-tunnel` subcommand handler.
 *
 * Accepts:
 *   --mode <quick|named>
 *   --name <name>        (required when --mode named)
 *   --hostname <host>    (required when --mode named)
 *
 * Reads existing config, merges the tunnel fields, and atomically writes
 * the result back. Exits 0 on success, 1 on validation failure.
 * Does NOT start any tunnel.
 */
export async function handleConfigureTunnel(
  argv: string[],
  deps: CliDeps,
  io: { stdout: (s: string) => void; stderr: (s: string) => void },
): Promise<number> {
  let mode: 'quick' | 'named' | undefined;
  let name: string | undefined;
  let hostname: string | undefined;

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--mode' && argv[i + 1]) {
      const m = argv[++i];
      if (m !== 'quick' && m !== 'named') {
        io.stderr(`Invalid --mode: "${m}" (expected "quick" or "named")`);
        return 1;
      }
      mode = m;
    } else if (a === '--name' && argv[i + 1]) {
      name = argv[++i];
    } else if (a === '--hostname' && argv[i + 1]) {
      hostname = argv[++i];
    }
  }

  if (mode === undefined) {
    io.stderr('Missing required --mode flag (expected "quick" or "named").');
    return 1;
  }

  if (mode === 'named') {
    if (!name && !hostname) {
      io.stderr('--mode named requires both --name and --hostname.');
      return 1;
    }
    if (!name) {
      io.stderr('--mode named requires --name <tunnel-name>.');
      return 1;
    }
    if (!hostname) {
      io.stderr('--mode named requires --hostname <hostname>.');
      return 1;
    }
    // Validate hostname shape: no scheme, no path (FIX-3)
    if (!HOSTNAME_RE.test(hostname)) {
      io.stderr(
        `Invalid --hostname: "${hostname}" — expected a bare hostname (no scheme, no path), e.g. "shots.example.com".`,
      );
      return 1;
    }
  }

  // Read existing config → merge → write
  const existing = await deps.ensureConfig();
  const next: Config = { ...existing, tunnelMode: mode };

  if (mode === 'named') {
    next.tunnelName = name;
    next.tunnelHostname = hostname;
    // PRESERVE v0.3 fields when staying in named mode (Open Point 3)
    // tunnelCredentialsFile + tunnelLocalPort remain untouched if they exist
  } else {
    // quick mode: clear the named-only fields AND the v0.3 fields
    delete next.tunnelName;
    delete next.tunnelHostname;
    delete next.tunnelCredentialsFile;
    delete next.tunnelLocalPort;
  }

  await deps.saveConfig(next);

  const summary =
    mode === 'named'
      ? `mode=named name=${name} hostname=${hostname}`
      : 'mode=quick';
  io.stdout(`Tunnel configured: ${summary}`);
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
// Resolve both argv[1] and import.meta.url through realpath so symlinks
// (created by `npm install -g`) are handled correctly. See entry-guard.ts.
import { isEntryPoint } from './entry-guard.js';

if (isEntryPoint(process.argv[1], import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(String(err) + '\n');
    process.exit(1);
  });
}
