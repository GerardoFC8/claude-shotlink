/**
 * tunnel.ts
 *
 * Cloudflare tunnel lifecycle management.
 *
 * Spawns `cloudflared tunnel --url http://127.0.0.1:<port> --no-autoupdate`,
 * watches both stdout and stderr via readline for a trycloudflare.com URL,
 * resolves the promise once the URL is captured, and exposes:
 *   - tunnel.publicUrl  — the current URL or null after exit
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
const DEFAULT_URL_TIMEOUT_MS = 30_000;
const DEFAULT_GRACE_MS = 3_000;

// ── Public types ──────────────────────────────────────────────────────────────

export interface TunnelOptions {
  localPort: number;
  binaryPath: string;
  urlTimeoutMs?: number; // default 30_000
  gracefulMs?: number;   // SIGTERM grace period; default 3_000
  onExit?: (code: number | null) => void;
  // Injection seam for unit tests — defaults to node:child_process.spawn
  spawnImpl?: (
    cmd: string,
    args: string[],
    opts: { stdio: ['ignore', 'pipe', 'pipe'] }
  ) => ChildProcess;
}

export interface Tunnel {
  readonly publicUrl: string | null;
  stop(gracefulMs?: number): Promise<void>;
  onUrlReady(cb: (url: string) => void): () => void;
  onDrop(cb: () => void): () => void;
}

// ── createTunnel ──────────────────────────────────────────────────────────────

/**
 * Spawn cloudflared and wait until a public URL is captured (or time out).
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
    onExit,
    spawnImpl: spawnFn = spawn as TunnelOptions['spawnImpl'],
  } = opts;

  return new Promise<Tunnel>((resolve, reject) => {
    const args = [
      'tunnel',
      '--url',
      `http://127.0.0.1:${localPort}`,
      '--no-autoupdate',
    ];

    const child = spawnFn!(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    // ── Mutable state ──────────────────────────────────────────────────────
    let publicUrl: string | null = null;
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
          settled = true;
          clearTimeout(timer);

          // Build the Tunnel handle
          const tunnel: Tunnel = {
            get publicUrl() {
              return publicUrl;
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
        publicUrl = null;
        for (const cb of dropListeners) cb();
        onExit?.(code);
      }
    });
  });
}
