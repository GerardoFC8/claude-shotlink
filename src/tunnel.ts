/**
 * tunnel.ts
 *
 * Cloudflare tunnel lifecycle management.
 *
 * Quick mode (v0.1 behavior): spawns `cloudflared tunnel --url http://127.0.0.1:<port>
 * --no-autoupdate`, watches both stdout and stderr via readline for a
 * trycloudflare.com URL, resolves the promise once the URL is captured.
 *
 * Named mode (v0.2): spawns `cloudflared tunnel run --no-autoupdate <name>`,
 * resolves after "Registered tunnel connection" log line OR a 2s grace timer,
 * whichever comes first. Public URL is `https://<hostname>` (known upfront).
 *
 * Exposes:
 *   - tunnel.publicUrl  — the current URL or null after exit
 *   - tunnel.state      — 'starting' | 'up' | 'reconnecting' | 'stopped'
 *   - tunnel.stop()     — SIGTERM → wait gracefulMs → SIGKILL
 *   - tunnel.onUrlReady(cb) — fires on initial URL and reconnects
 *   - tunnel.onDrop(cb)     — fires when the child exits
 *
 * Injection seam: pass `spawnImpl` in TunnelOptions to inject a fake in tests.
 */
import { createInterface } from 'node:readline';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

// ── Constants ─────────────────────────────────────────────────────────────────

const URL_RE = /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i;
const NAMED_READY_RE = /(Registered tunnel connection|Connection [a-z0-9-]+ registered)/i;
const DEFAULT_URL_TIMEOUT_MS = 30_000;
const DEFAULT_GRACE_MS = 3_000;
const DEFAULT_NAMED_READY_GRACE_MS = 2_000;

// ── Public types ──────────────────────────────────────────────────────────────

export type TunnelMode =
  | { mode: 'quick' }
  | { mode: 'named'; name: string; hostname: string };

export type TunnelState = 'starting' | 'up' | 'reconnecting' | 'stopped';

export interface TunnelOptions {
  localPort: number;
  binaryPath: string;
  urlTimeoutMs?: number;        // default 30_000
  gracefulMs?: number;          // SIGTERM grace period; default 3_000
  namedReadyGraceMs?: number;   // Named-mode ready grace; default 2_000
  onExit?: (code: number | null) => void;
  /** v0.2: when absent → quick-mode (v0.1 behavior). */
  tunnel?: TunnelMode;
  // Injection seam for unit tests — defaults to node:child_process.spawn
  spawnImpl?: (
    cmd: string,
    args: string[],
    opts: { stdio: ['ignore', 'pipe', 'pipe'] }
  ) => ChildProcess;
}

export interface Tunnel {
  readonly publicUrl: string | null;
  readonly state: TunnelState;
  stop(gracefulMs?: number): Promise<void>;
  onUrlReady(cb: (url: string) => void): () => void;
  onDrop(cb: () => void): () => void;
}

// ── createTunnel ──────────────────────────────────────────────────────────────

/**
 * Spawn cloudflared and wait until a public URL is known (or time out).
 *
 * Resolves with a Tunnel handle on success.
 * Rejects (and kills the child) on timeout or early exit.
 */
export function createTunnel(opts: TunnelOptions): Promise<Tunnel> {
  const {
    localPort,
    binaryPath,
    urlTimeoutMs = DEFAULT_URL_TIMEOUT_MS,
    gracefulMs: defaultGrace = DEFAULT_GRACE_MS,
    namedReadyGraceMs = DEFAULT_NAMED_READY_GRACE_MS,
    onExit,
    tunnel,
    spawnImpl: spawnFn = spawn as TunnelOptions['spawnImpl'],
  } = opts;

  const isNamedMode =
    tunnel !== undefined && tunnel.mode === 'named';

  if (isNamedMode) {
    return createNamedTunnel({
      binaryPath,
      tunnel: tunnel as { mode: 'named'; name: string; hostname: string },
      urlTimeoutMs,
      defaultGrace,
      namedReadyGraceMs,
      onExit,
      spawnFn: spawnFn!,
    });
  }

  return createQuickTunnel({
    localPort,
    binaryPath,
    urlTimeoutMs,
    defaultGrace,
    onExit,
    spawnFn: spawnFn!,
  });
}

// ── Quick-mode implementation (unchanged from v0.1) ───────────────────────────

interface QuickTunnelInternalOpts {
  localPort: number;
  binaryPath: string;
  urlTimeoutMs: number;
  defaultGrace: number;
  onExit?: (code: number | null) => void;
  spawnFn: NonNullable<TunnelOptions['spawnImpl']>;
}

function createQuickTunnel(opts: QuickTunnelInternalOpts): Promise<Tunnel> {
  const { localPort, binaryPath, urlTimeoutMs, defaultGrace, onExit, spawnFn } = opts;

  return new Promise<Tunnel>((resolve, reject) => {
    const args = [
      'tunnel',
      '--url',
      `http://127.0.0.1:${localPort}`,
      '--no-autoupdate',
    ];

    const child = spawnFn(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    // ── Mutable state ──────────────────────────────────────────────────────
    let publicUrl: string | null = null;
    let tunnelState: TunnelState = 'starting';
    let settled = false;
    let exitCode: number | null = null;
    const stderrLines: string[] = [];

    const urlReadyListeners = new Set<(url: string) => void>();
    const dropListeners = new Set<() => void>();

    // ── Watch both streams for URL ─────────────────────────────────────────

    function watchStream(stream: Readable, isStderr: boolean): void {
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', (line) => {
        // Collect only stderr lines for error diagnostics
        if (isStderr) {
          stderrLines.push(line);
          if (stderrLines.length > 20) stderrLines.shift();
        }

        const match = URL_RE.exec(line);
        if (!match) return;
        const url = match[1]!;

        if (!settled) {
          // First URL — resolve the outer promise
          publicUrl = url;
          tunnelState = 'up';
          settled = true;
          clearTimeout(timer);

          // Build the Tunnel handle
          const tunnel: Tunnel = {
            get publicUrl() {
              return publicUrl;
            },

            get state() {
              return tunnelState;
            },

            stop(graceMs: number = defaultGrace): Promise<void> {
              return new Promise<void>((res) => {
                if (child.killed || exitCode !== null) {
                  // Already dead
                  res();
                  return;
                }

                let sigkillTimer: ReturnType<typeof setTimeout> | null = null;

                const onEarlyExit = () => {
                  if (sigkillTimer) clearTimeout(sigkillTimer);
                  res();
                };
                child.once('exit', onEarlyExit);

                child.kill('SIGTERM');

                sigkillTimer = setTimeout(() => {
                  child.removeListener('exit', onEarlyExit);
                  if (!child.killed && exitCode === null) {
                    child.kill('SIGKILL');
                  }
                  res();
                }, graceMs);
              });
            },

            onUrlReady(cb: (url: string) => void): () => void {
              urlReadyListeners.add(cb);
              return () => urlReadyListeners.delete(cb);
            },

            onDrop(cb: () => void): () => void {
              dropListeners.add(cb);
              return () => dropListeners.delete(cb);
            },
          };

          resolve(tunnel);
        } else {
          // Subsequent URL — fire callbacks only if URL actually changed
          // (dedup: same URL emitted on both streams should not fire twice)
          if (url !== publicUrl) {
            publicUrl = url;
            for (const cb of urlReadyListeners) cb(url);
          }
        }
      });
    }

    watchStream(child.stdout as Readable, false);
    watchStream(child.stderr as Readable, true);

    // ── Timeout ────────────────────────────────────────────────────────────

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(
        new Error(
          `cloudflared tunnel did not come up within ${urlTimeoutMs}ms — stderr tail:\n${stderrLines.slice(-10).join('\n')}`
        )
      );
    }, urlTimeoutMs);

    // Make the timer non-blocking so it doesn't keep the process alive
    if (typeof timer === 'object' && 'unref' in timer) {
      (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    }

    // ── Child exit ────────────────────────────────────────────────────────

    child.on('exit', (code) => {
      exitCode = code;
      clearTimeout(timer);

      if (!settled) {
        // Died before URL appeared
        settled = true;
        reject(
          new Error(
            `cloudflared exited (code ${code}) before URL was parsed — stderr tail:\n${stderrLines.slice(-10).join('\n')}`
          )
        );
      } else {
        // Normal post-URL exit
        tunnelState = 'stopped';
        publicUrl = null;
        for (const cb of dropListeners) cb();
        onExit?.(code);
      }
    });
  });
}

// ── Named-mode implementation (v0.2 new) ─────────────────────────────────────

interface NamedTunnelInternalOpts {
  binaryPath: string;
  tunnel: { mode: 'named'; name: string; hostname: string };
  urlTimeoutMs: number;
  defaultGrace: number;
  namedReadyGraceMs: number;
  onExit?: (code: number | null) => void;
  spawnFn: NonNullable<TunnelOptions['spawnImpl']>;
}

function createNamedTunnel(opts: NamedTunnelInternalOpts): Promise<Tunnel> {
  const { binaryPath, tunnel, urlTimeoutMs, defaultGrace, namedReadyGraceMs, onExit, spawnFn } =
    opts;
  const { name, hostname } = tunnel;
  const publicBaseUrl = `https://${hostname}`;

  return new Promise<Tunnel>((resolve, reject) => {
    const args = [
      'tunnel',
      'run',
      '--no-autoupdate',
      name,
    ];

    const child = spawnFn(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    // ── Mutable state ──────────────────────────────────────────────────────
    let publicUrl: string | null = null;
    let tunnelState: TunnelState = 'starting';
    let settled = false;
    let exitCode: number | null = null;
    let intentionallyStopped = false; // FIX-4: track deliberate stop()
    const stderrLines: string[] = [];

    const urlReadyListeners = new Set<(url: string) => void>();
    const dropListeners = new Set<() => void>();

    // ── Collect stderr for error diagnostics ──────────────────────────────

    const stderrRl = createInterface({
      input: child.stderr as Readable,
      crlfDelay: Infinity,
    });

    stderrRl.on('line', (line) => {
      stderrLines.push(line);
      if (stderrLines.length > 20) stderrLines.shift();

      // Check for ready signal on stderr
      if (!settled && NAMED_READY_RE.test(line)) {
        settleReady();
      }
    });

    // Also check stdout for ready signal
    const stdoutRl = createInterface({
      input: child.stdout as Readable,
      crlfDelay: Infinity,
    });

    stdoutRl.on('line', (line) => {
      if (!settled && NAMED_READY_RE.test(line)) {
        settleReady();
      }
    });

    // ── Ready settlement (idempotent) ──────────────────────────────────────

    function settleReady(): void {
      if (settled) return;
      settled = true;
      clearTimeout(urlTimeoutTimer);
      clearTimeout(graceTimer);
      child.removeListener('exit', earlyExitListener);

      publicUrl = publicBaseUrl;
      tunnelState = 'up';

      // Build the Tunnel handle
      const tunnelHandle: Tunnel = {
        get publicUrl() {
          return publicUrl;
        },

        get state() {
          return tunnelState;
        },

        stop(graceMs: number = defaultGrace): Promise<void> {
          intentionallyStopped = true; // FIX-4: mark before child exits
          return new Promise<void>((res) => {
            if (child.killed || exitCode !== null) {
              res();
              return;
            }

            let sigkillTimer: ReturnType<typeof setTimeout> | null = null;

            const onEarlyExit = () => {
              if (sigkillTimer) clearTimeout(sigkillTimer);
              res();
            };
            child.once('exit', onEarlyExit);

            child.kill('SIGTERM');

            sigkillTimer = setTimeout(() => {
              child.removeListener('exit', onEarlyExit);
              if (!child.killed && exitCode === null) {
                child.kill('SIGKILL');
              }
              res();
            }, graceMs);
          });
        },

        onUrlReady(cb: (url: string) => void): () => void {
          urlReadyListeners.add(cb);
          return () => urlReadyListeners.delete(cb);
        },

        onDrop(cb: () => void): () => void {
          dropListeners.add(cb);
          return () => dropListeners.delete(cb);
        },
      };

      // FIX-4: register postReadyExitListener BEFORE resolve() to close the
      // synchronous-microtask race window where child could exit between
      // resolve() and the once() registration.
      child.once('exit', postReadyExitListener);

      resolve(tunnelHandle);
    }

    // ── Post-ready exit listener ───────────────────────────────────────────

    function postReadyExitListener(code: number | null): void {
      exitCode = code;
      tunnelState = 'stopped';
      publicUrl = null;
      // FIX-4: only invoke drop callbacks for unexpected exits, not deliberate stop()
      if (!intentionallyStopped) {
        for (const cb of dropListeners) cb();
      }
      onExit?.(code);
    }

    // ── Early exit (before grace) ──────────────────────────────────────────

    const earlyExitListener = (code: number | null): void => {
      exitCode = code;
      if (settled) return;
      settled = true;
      clearTimeout(urlTimeoutTimer);
      clearTimeout(graceTimer);

      const stderrTail = stderrLines.slice(-10).join('\n');
      const hint = 'run `cloudflared tunnel login` first and verify the tunnel exists';
      reject(
        new Error(
          `cloudflared exited (code ${code}) before ready — ${hint}. stderr tail:\n${stderrTail}`
        )
      );
    };

    child.once('exit', earlyExitListener);

    // ── Grace timer — resolve after namedReadyGraceMs if still alive ──────

    const graceTimer = setTimeout(() => {
      if (settled) return;
      // Only resolve via grace if child is still alive
      if (exitCode === null) {
        settleReady();
      }
    }, namedReadyGraceMs);

    if (typeof graceTimer === 'object' && 'unref' in graceTimer) {
      (graceTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    }

    // ── Hard timeout (urlTimeoutMs) ────────────────────────────────────────

    const urlTimeoutTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(
        new Error(
          `cloudflared tunnel did not come up within ${urlTimeoutMs}ms — stderr tail:\n${stderrLines.slice(-10).join('\n')}`
        )
      );
    }, urlTimeoutMs);

    if (typeof urlTimeoutTimer === 'object' && 'unref' in urlTimeoutTimer) {
      (urlTimeoutTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    }
  });
}
