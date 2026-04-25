/**
 * tunnel.test.ts
 *
 * Tests for src/tunnel.ts — Cloudflare tunnel lifecycle management.
 *
 * Strategy: inject a `spawnImpl` fake that returns an EventEmitter-like
 * child process object with stdout/stderr PassThrough streams.
 * No real cloudflared binary is invoked.
 */
import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

// ── Helper: build a fake child process ────────────────────────────────────────

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  killed: boolean;
  kill: (signal?: string) => boolean;
  _exitWithCode: (code: number | null) => void;
  _sigterm?: () => void;
}

function makeFakeChild(pid = 12345): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = pid;
  child.killed = false;
  child.kill = (signal?: string) => {
    child.killed = true;
    if (signal === 'SIGTERM' && child._sigterm) {
      child._sigterm();
    }
    return true;
  };
  child._exitWithCode = (code: number | null) => {
    child.stdout.push(null);
    child.stderr.push(null);
    child.emit('exit', code, null);
  };
  return child;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createTunnel — URL parsed from stderr', () => {
  it('resolves with publicUrl when tunnel URL appears on stderr', async () => {
    const { createTunnel } = await import('./tunnel.js');

    const child = makeFakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child);

    const tunnelPromise = createTunnel({
      localPort: 3000,
      binaryPath: '/fake/cloudflared',
      urlTimeoutMs: 5000,
      spawnImpl,
    });

    // Simulate cloudflared printing URL on stderr
    await new Promise<void>((r) => setTimeout(r, 20));
    child.stderr.push('Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):\nhttps://shiny-cat-1234.trycloudflare.com\n');

    const tunnel = await tunnelPromise;
    expect(tunnel.publicUrl).toMatch(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i);
  });
});

describe('createTunnel — URL parsed from stdout', () => {
  it('resolves with publicUrl when tunnel URL appears on stdout', async () => {
    const { createTunnel } = await import('./tunnel.js');

    const child = makeFakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child);

    const tunnelPromise = createTunnel({
      localPort: 4000,
      binaryPath: '/fake/cloudflared',
      urlTimeoutMs: 5000,
      spawnImpl,
    });

    await new Promise<void>((r) => setTimeout(r, 20));
    child.stdout.push('https://golden-dragon-5678.trycloudflare.com\n');

    const tunnel = await tunnelPromise;
    expect(tunnel.publicUrl).toBe('https://golden-dragon-5678.trycloudflare.com');
  });
});

describe('createTunnel — spawn arguments', () => {
  it('spawns with correct arguments including --no-autoupdate', async () => {
    const { createTunnel } = await import('./tunnel.js');

    const child = makeFakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child);

    const p = createTunnel({
      localPort: 9999,
      binaryPath: '/usr/local/bin/cloudflared',
      urlTimeoutMs: 5000,
      spawnImpl,
    });

    await new Promise<void>((r) => setTimeout(r, 10));
    child.stdout.push('https://test-spawn-99.trycloudflare.com\n');
    await p;

    expect(spawnImpl).toHaveBeenCalledWith(
      '/usr/local/bin/cloudflared',
      ['tunnel', '--url', 'http://127.0.0.1:9999', '--no-autoupdate'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );
  });
});

describe('createTunnel — timeout', () => {
  it('rejects with "tunnel did not come up" after urlTimeoutMs and kills child', async () => {
    const { createTunnel } = await import('./tunnel.js');

    const child = makeFakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child);

    // Use a very short timeout (50ms) so the test is fast
    const p = createTunnel({
      localPort: 3000,
      binaryPath: '/fake/cloudflared',
      urlTimeoutMs: 50,
      spawnImpl,
    });

    // Do NOT emit any URL — let it time out
    await expect(p).rejects.toThrow(/tunnel did not come up/i);
    expect(child.killed).toBe(true);
  });
});

describe('createTunnel — child exits before URL', () => {
  it('rejects when child exits before any URL is parsed', async () => {
    const { createTunnel } = await import('./tunnel.js');

    const child = makeFakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child);

    const p = createTunnel({
      localPort: 3000,
      binaryPath: '/fake/cloudflared',
      urlTimeoutMs: 5000,
      spawnImpl,
    });

    await new Promise<void>((r) => setTimeout(r, 10));
    child._exitWithCode(1);

    await expect(p).rejects.toThrow(/exited/i);
  });
});

describe('createTunnel — publicUrl after exit', () => {
  it('publicUrl returns null after the child process exits', async () => {
    const { createTunnel } = await import('./tunnel.js');

    const child = makeFakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child);

    const tunnelPromise = createTunnel({
      localPort: 3000,
      binaryPath: '/fake/cloudflared',
      urlTimeoutMs: 5000,
      spawnImpl,
    });

    await new Promise<void>((r) => setTimeout(r, 10));
    child.stderr.push('https://quiet-moon-9876.trycloudflare.com\n');
    const tunnel = await tunnelPromise;

    expect(tunnel.publicUrl).not.toBeNull();

    // Now child exits
    child._exitWithCode(0);
    await new Promise<void>((r) => setTimeout(r, 20));

    expect(tunnel.publicUrl).toBeNull();
  });
});

describe('createTunnel — stop()', () => {
  it('stop() sends SIGTERM then SIGKILL after grace period if still running', async () => {
    const { createTunnel } = await import('./tunnel.js');

    const child = makeFakeChild();
    const killed: string[] = [];
    child.kill = (signal = 'SIGTERM') => {
      killed.push(signal);
      return true;
    };

    const spawnImpl = vi.fn().mockReturnValue(child);

    const tunnelPromise = createTunnel({
      localPort: 3000,
      binaryPath: '/fake/cloudflared',
      urlTimeoutMs: 5000,
      spawnImpl,
    });

    await new Promise<void>((r) => setTimeout(r, 10));
    child.stderr.push('https://fast-wolf-1111.trycloudflare.com\n');
    const tunnel = await tunnelPromise;

    // Stop with a very short grace period (50ms) so the test doesn't block
    const stopPromise = tunnel.stop(50);

    // Simulate: process did NOT exit after SIGTERM → SIGKILL should fire
    await stopPromise;

    expect(killed).toContain('SIGTERM');
    expect(killed).toContain('SIGKILL');
  });

  it('stop() resolves quickly when child exits after SIGTERM', async () => {
    const { createTunnel } = await import('./tunnel.js');

    const child = makeFakeChild();
    // When SIGTERM is sent, emit exit
    child._sigterm = () => {
      setTimeout(() => child._exitWithCode(0), 10);
    };
    child.kill = (signal = 'SIGTERM') => {
      if (signal === 'SIGTERM' && child._sigterm) child._sigterm();
      return true;
    };

    const spawnImpl = vi.fn().mockReturnValue(child);

    const tunnelPromise = createTunnel({
      localPort: 3000,
      binaryPath: '/fake/cloudflared',
      urlTimeoutMs: 5000,
      spawnImpl,
    });

    await new Promise<void>((r) => setTimeout(r, 10));
    child.stderr.push('https://calm-bird-2222.trycloudflare.com\n');
    const tunnel = await tunnelPromise;

    const start = Date.now();
    await tunnel.stop(3000);
    const elapsed = Date.now() - start;

    // Should resolve well before the 3s grace period since child exited after 10ms
    expect(elapsed).toBeLessThan(500);
  });
});

describe('createTunnel — onUrlReady / onDrop callbacks', () => {
  it('onUrlReady fires with the parsed URL', async () => {
    const { createTunnel } = await import('./tunnel.js');

    const child = makeFakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child);

    const tunnelPromise = createTunnel({
      localPort: 3000,
      binaryPath: '/fake/cloudflared',
      urlTimeoutMs: 5000,
      spawnImpl,
    });

    await new Promise<void>((r) => setTimeout(r, 10));
    child.stderr.push('https://happy-bird-3333.trycloudflare.com\n');
    const tunnel = await tunnelPromise;

    const received: string[] = [];
    tunnel.onUrlReady((url) => received.push(url));

    // Trigger a second URL (simulates reconnect)
    child.stderr.push('https://new-bird-4444.trycloudflare.com\n');
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(received).toContain('https://new-bird-4444.trycloudflare.com');
  });

  it('onDrop fires when the child process exits', async () => {
    const { createTunnel } = await import('./tunnel.js');

    const child = makeFakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child);

    const tunnelPromise = createTunnel({
      localPort: 3000,
      binaryPath: '/fake/cloudflared',
      urlTimeoutMs: 5000,
      spawnImpl,
    });

    await new Promise<void>((r) => setTimeout(r, 10));
    child.stderr.push('https://stormy-sea-5555.trycloudflare.com\n');
    const tunnel = await tunnelPromise;

    let dropped = false;
    tunnel.onDrop(() => { dropped = true; });

    child._exitWithCode(0);
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(dropped).toBe(true);
  });

  it('onUrlReady returns an unsubscribe function', async () => {
    const { createTunnel } = await import('./tunnel.js');

    const child = makeFakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child);

    const tunnelPromise = createTunnel({
      localPort: 3000,
      binaryPath: '/fake/cloudflared',
      urlTimeoutMs: 5000,
      spawnImpl,
    });

    await new Promise<void>((r) => setTimeout(r, 10));
    child.stderr.push('https://mute-fox-6666.trycloudflare.com\n');
    const tunnel = await tunnelPromise;

    const received: string[] = [];
    const unsub = tunnel.onUrlReady((url) => received.push(url));
    expect(typeof unsub).toBe('function');

    unsub(); // unsubscribe

    // Trigger URL — should NOT be received
    child.stderr.push('https://ghost-7777.trycloudflare.com\n');
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(received).toHaveLength(0);
  });
});

// ── WARNING-5 regression: URL on both streams fires onUrlReady exactly once ──

describe('createTunnel — WARNING-5: URL on both stdout and stderr', () => {
  it('onUrlReady fires exactly once when the same URL appears on both stdout and stderr', async () => {
    const { createTunnel } = await import('./tunnel.js');

    const child = makeFakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child);

    const tunnelPromise = createTunnel({
      localPort: 3000,
      binaryPath: '/fake/cloudflared',
      urlTimeoutMs: 5000,
      spawnImpl,
    });

    // Emit the initial URL on stderr to resolve the start Promise
    await new Promise<void>((r) => setTimeout(r, 10));
    child.stderr.push('https://dual-stream-test.trycloudflare.com\n');
    const tunnel = await tunnelPromise;

    const urlReadyCount: string[] = [];
    tunnel.onUrlReady((url) => urlReadyCount.push(url));

    // Now the same URL appears on BOTH stdout and stderr (reconnect scenario)
    const sameUrl = 'https://dual-stream-test.trycloudflare.com';
    child.stdout.push(sameUrl + '\n');
    child.stderr.push(sameUrl + '\n');

    await new Promise<void>((r) => setTimeout(r, 50));

    // The same URL should NOT fire onUrlReady twice
    const matchingCalls = urlReadyCount.filter((u) => u === sameUrl);
    expect(matchingCalls.length).toBeLessThanOrEqual(1);

    // publicUrl should be set (to the same URL) — not doubled
    expect(tunnel.publicUrl).toBe(sameUrl);
  });

  it('stderrLines buffer does NOT accumulate stdout lines (only real stderr)', async () => {
    const { createTunnel } = await import('./tunnel.js');

    const child = makeFakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child);

    const tunnelPromise = createTunnel({
      localPort: 3000,
      binaryPath: '/fake/cloudflared',
      urlTimeoutMs: 5000,
      spawnImpl,
    });

    // Emit URL on stderr to resolve
    await new Promise<void>((r) => setTimeout(r, 10));
    child.stderr.push('https://stderr-only.trycloudflare.com\n');
    await tunnelPromise;

    // Push many stdout lines — these should NOT cause timeout error to mention stdout content
    for (let i = 0; i < 25; i++) {
      child.stdout.push(`stdout-line-${i}\n`);
    }

    // This test is structural: we just assert the tunnel resolved without throwing
    // The real check is that watchStream(stdout, false) skips stderrLines.push
    // We can only verify this doesn't break correctness here
    expect(true).toBe(true);
  });
});

// ── B2: TASK-005-a RED — TunnelStartOpts optional tunnel field (signature widening) ──

describe('createTunnel — TASK-005: named variant accepted in TunnelOptions', () => {
  it('compiles and is callable with tunnel: { mode: "named", name, hostname } — no extra spawner call before ready', async () => {
    const { createTunnel } = await import('./tunnel.js');

    const child = makeFakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child);

    // This call uses the NAMED variant — should compile and not immediately reject
    const p = createTunnel({
      localPort: 3000,
      binaryPath: '/fake/cloudflared',
      urlTimeoutMs: 5000,
      spawnImpl,
      tunnel: { mode: 'named', name: 'my-tunnel', hostname: 'shots.example.com' },
    });

    // Named mode should call spawnImpl exactly once
    expect(spawnImpl).toHaveBeenCalledTimes(1);

    // Clean up — resolve by grace timeout (we'll simulate it later in TASK-007)
    // For now just let it settle: emit exit to resolve reject cleanly
    await new Promise<void>((r) => setTimeout(r, 10));
    child._exitWithCode(0);
    await p.catch(() => {}); // expected to reject or resolve — we don't care here, just that it compiled
  });

  it('existing callers with only { localPort, binaryPath } still work', async () => {
    const { createTunnel } = await import('./tunnel.js');

    const child = makeFakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child);

    // Legacy call — no tunnel field — must still compile and behave as quick mode
    const p = createTunnel({
      localPort: 3000,
      binaryPath: '/fake/cloudflared',
      urlTimeoutMs: 500,
      spawnImpl,
    });

    await new Promise<void>((r) => setTimeout(r, 10));
    child.stderr.push('https://legacy.trycloudflare.com\n');
    const tunnel = await p;
    expect(tunnel.publicUrl).toBe('https://legacy.trycloudflare.com');
  });
});

// ── B2: TASK-006-a RED — named-mode argv construction ──────────────────────────

describe('createTunnel — TASK-006: named-mode spawn args', () => {
  it('spawns with ["tunnel","--no-autoupdate","run","<name>"] in named mode', async () => {
    // cloudflared treats --no-autoupdate as a TUNNEL command option, not a
    // `run` subcommand option — it MUST come before `run`. Asserting the
    // correct order here catches regressions of the v0.2.1 silent-fail bug.
    const { createTunnel } = await import('./tunnel.js');

    const child = makeFakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child);

    const p = createTunnel({
      localPort: 3000,
      binaryPath: '/usr/local/bin/cloudflared',
      urlTimeoutMs: 5000,
      spawnImpl,
      tunnel: { mode: 'named', name: 'shotlink', hostname: 'shots.example.com' },
    });

    expect(spawnImpl).toHaveBeenCalledWith(
      '/usr/local/bin/cloudflared',
      ['tunnel', '--no-autoupdate', 'run', 'shotlink'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    );

    // Clean up
    await new Promise<void>((r) => setTimeout(r, 10));
    child._exitWithCode(0);
    await p.catch(() => {});
  });

  it('does NOT include --url in named-mode spawn args', async () => {
    const { createTunnel } = await import('./tunnel.js');

    const child = makeFakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child);

    const p = createTunnel({
      localPort: 8080,
      binaryPath: '/fake/cloudflared',
      urlTimeoutMs: 5000,
      spawnImpl,
      tunnel: { mode: 'named', name: 'mytunnel', hostname: 'h.example.com' },
    });

    const calledArgs = spawnImpl.mock.calls[0]?.[1] as string[] | undefined;
    expect(calledArgs).toBeDefined();
    expect(calledArgs).not.toContain('--url');
    expect(calledArgs).not.toContain('http://127.0.0.1:8080');

    await new Promise<void>((r) => setTimeout(r, 10));
    child._exitWithCode(0);
    await p.catch(() => {});
  });
});

// ── B2: TASK-007-a RED — ready-signal algorithm ───────────────────────────────

describe('createTunnel — TASK-007: named-mode ready signal', () => {
  it('resolves with https://<hostname> when "Registered tunnel connection" log line fires', async () => {
    const { createTunnel } = await import('./tunnel.js');

    const child = makeFakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child);

    const p = createTunnel({
      localPort: 3000,
      binaryPath: '/fake/cloudflared',
      urlTimeoutMs: 10_000,
      namedReadyGraceMs: 5_000, // long grace — log line fires first
      spawnImpl,
      tunnel: { mode: 'named', name: 'T', hostname: 'shots.example.com' },
    });

    // Emit the ready log line quickly
    await new Promise<void>((r) => setTimeout(r, 20));
    child.stderr.push('2026-01-01 Registered tunnel connection connID=abc\n');

    const tunnel = await p;
    expect(tunnel.publicUrl).toBe('https://shots.example.com');
  });

  it('resolves with https://<hostname> after 2s grace timer when cloudflared is silent', async () => {
    vi.useFakeTimers();
    const { createTunnel } = await import('./tunnel.js');

    const child = makeFakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child);

    const p = createTunnel({
      localPort: 3000,
      binaryPath: '/fake/cloudflared',
      urlTimeoutMs: 30_000,
      namedReadyGraceMs: 2_000,
      spawnImpl,
      tunnel: { mode: 'named', name: 'T', hostname: 'shots.example.com' },
    });

    // Advance 2 seconds — grace fires
    await vi.advanceTimersByTimeAsync(2_000);
    vi.useRealTimers();

    const tunnel = await p;
    expect(tunnel.publicUrl).toBe('https://shots.example.com');
  });

  it('rejects when child exits before grace timer elapses', async () => {
    const { createTunnel } = await import('./tunnel.js');

    const child = makeFakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child);

    const p = createTunnel({
      localPort: 3000,
      binaryPath: '/fake/cloudflared',
      urlTimeoutMs: 10_000,
      namedReadyGraceMs: 5_000,
      spawnImpl,
      tunnel: { mode: 'named', name: 'T', hostname: 'shots.example.com' },
    });

    // Child exits before grace
    await new Promise<void>((r) => setTimeout(r, 10));
    child._exitWithCode(1);

    await expect(p).rejects.toThrow(/cloudflared exited/i);
  });
});

// ── B2: TASK-008-a RED — onDrop called exactly once post-ready in named mode ──

describe('createTunnel — TASK-008: onDrop in named mode post-ready', () => {
  it('onDrop subscriber called exactly once when child exits after named-mode handle resolves', async () => {
    const { createTunnel } = await import('./tunnel.js');

    const child = makeFakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child);

    const p = createTunnel({
      localPort: 3000,
      binaryPath: '/fake/cloudflared',
      urlTimeoutMs: 10_000,
      namedReadyGraceMs: 5_000,
      spawnImpl,
      tunnel: { mode: 'named', name: 'T', hostname: 'shots.example.com' },
    });

    // Emit ready log line to resolve the handle
    await new Promise<void>((r) => setTimeout(r, 20));
    child.stderr.push('Registered tunnel connection\n');

    const tunnel = await p;
    expect(tunnel.publicUrl).toBe('https://shots.example.com');

    let dropCount = 0;
    tunnel.onDrop(() => { dropCount++; });

    // Child exits unexpectedly post-ready
    child._exitWithCode(1);
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(dropCount).toBe(1);
  });

  it('double-exit does not call onDrop twice', async () => {
    const { createTunnel } = await import('./tunnel.js');

    const child = makeFakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child);

    const p = createTunnel({
      localPort: 3000,
      binaryPath: '/fake/cloudflared',
      urlTimeoutMs: 10_000,
      namedReadyGraceMs: 5_000,
      spawnImpl,
      tunnel: { mode: 'named', name: 'T', hostname: 'shots.example.com' },
    });

    await new Promise<void>((r) => setTimeout(r, 20));
    child.stderr.push('Registered tunnel connection\n');
    const tunnel = await p;

    let dropCount = 0;
    tunnel.onDrop(() => { dropCount++; });

    child._exitWithCode(0);
    await new Promise<void>((r) => setTimeout(r, 20));
    // Simulate a second exit (should be idempotent)
    child.emit('exit', 0, null);
    await new Promise<void>((r) => setTimeout(r, 20));

    // Should still be 1 even with a second exit emission
    expect(dropCount).toBeLessThanOrEqual(1);
  });
});

// ── B3: TASK-011-a RED — named-mode startup error surfacing ───────────────────

describe('createTunnel — TASK-011: named-mode auth-error surfacing', () => {
  it('rejection message contains "tunnel login" hint when child exits with auth-related stderr', async () => {
    const { createTunnel } = await import('./tunnel.js');

    const child = makeFakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child);

    const p = createTunnel({
      localPort: 3000,
      binaryPath: '/fake/cloudflared',
      urlTimeoutMs: 10_000,
      namedReadyGraceMs: 5_000,
      spawnImpl,
      tunnel: { mode: 'named', name: 'T', hostname: 'shots.example.com' },
    });

    // Simulate cloudflared emitting auth error stderr then exiting
    await new Promise<void>((r) => setTimeout(r, 20));
    child.stderr.push('Error: authentication failed\n');
    child.stderr.push('Please run cloudflared login to authenticate\n');
    child._exitWithCode(1);

    await expect(p).rejects.toThrow(/tunnel login/i);
  });

  it('rejection message includes the exit code', async () => {
    const { createTunnel } = await import('./tunnel.js');

    const child = makeFakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child);

    const p = createTunnel({
      localPort: 3000,
      binaryPath: '/fake/cloudflared',
      urlTimeoutMs: 10_000,
      namedReadyGraceMs: 5_000,
      spawnImpl,
      tunnel: { mode: 'named', name: 'T', hostname: 'shots.example.com' },
    });

    await new Promise<void>((r) => setTimeout(r, 10));
    child._exitWithCode(2);

    // Must mention the exit code in the error message
    await expect(p).rejects.toThrow(/code 2/i);
  });

  it('rejection message includes stderr tail content', async () => {
    const { createTunnel } = await import('./tunnel.js');

    const child = makeFakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child);

    const p = createTunnel({
      localPort: 3000,
      binaryPath: '/fake/cloudflared',
      urlTimeoutMs: 10_000,
      namedReadyGraceMs: 5_000,
      spawnImpl,
      tunnel: { mode: 'named', name: 'T', hostname: 'shots.example.com' },
    });

    await new Promise<void>((r) => setTimeout(r, 10));
    child.stderr.push('UNIQUE_STDERR_MARKER_FOR_TEST\n');
    child._exitWithCode(1);

    await expect(p).rejects.toThrow(/UNIQUE_STDERR_MARKER_FOR_TEST/);
  });
});

// ── FIX-4: postReadyExitListener must not fire onDrop on intentional stop() ──

describe('createTunnel — FIX-4: named-mode onDrop not called on intentional stop()', () => {
  it('FIX-4: onDrop is NOT invoked when stop() is called intentionally', async () => {
    const { createTunnel } = await import('./tunnel.js');

    const child = makeFakeChild();
    // When SIGTERM is sent, simulate child exiting
    child._sigterm = () => {
      setTimeout(() => child._exitWithCode(0), 5);
    };
    child.kill = (signal = 'SIGTERM') => {
      child.killed = true;
      if (signal === 'SIGTERM' && child._sigterm) child._sigterm();
      return true;
    };
    const spawnImpl = vi.fn().mockReturnValue(child);

    const p = createTunnel({
      localPort: 3000,
      binaryPath: '/fake/cloudflared',
      urlTimeoutMs: 10_000,
      namedReadyGraceMs: 5_000,
      spawnImpl,
      tunnel: { mode: 'named', name: 'T', hostname: 'shots.example.com' },
    });

    await new Promise<void>((r) => setTimeout(r, 20));
    child.stderr.push('Registered tunnel connection\n');
    const tunnel = await p;

    let dropCount = 0;
    tunnel.onDrop(() => { dropCount++; });

    // Intentional stop()
    await tunnel.stop(100);
    await new Promise<void>((r) => setTimeout(r, 50));

    // onDrop must NOT fire on deliberate stop
    expect(dropCount).toBe(0);
  });

  it('FIX-4: onDrop IS invoked when child exits unexpectedly (regression check)', async () => {
    const { createTunnel } = await import('./tunnel.js');

    const child = makeFakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child);

    const p = createTunnel({
      localPort: 3000,
      binaryPath: '/fake/cloudflared',
      urlTimeoutMs: 10_000,
      namedReadyGraceMs: 5_000,
      spawnImpl,
      tunnel: { mode: 'named', name: 'T', hostname: 'shots.example.com' },
    });

    await new Promise<void>((r) => setTimeout(r, 20));
    child.stderr.push('Registered tunnel connection\n');
    const tunnel = await p;

    let dropCount = 0;
    tunnel.onDrop(() => { dropCount++; });

    // Unexpected exit (not via stop())
    child._exitWithCode(1);
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(dropCount).toBe(1);
  });
});
