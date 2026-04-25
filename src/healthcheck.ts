/**
 * healthcheck.ts
 *
 * Edge healthcheck for the public tunnel URL.
 *
 * Polls GET {publicUrl}/health every intervalMs. Counts consecutive
 * failures; resets on any 2xx success. After failThreshold consecutive
 * failures, fires onFail() once per cluster and resets the counter.
 *
 * Does NOT distinguish quick vs named mode internally — the caller
 * chooses what onFail does (warn-only in named mode; reconnect in quick).
 *
 * Design ref: §4 — src/healthcheck.ts (NEW)
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HealthcheckOptions {
  /** The public URL whose /health endpoint we ping. */
  publicUrl: string;
  /** Poll interval after the grace period. Default 30_000ms. */
  intervalMs?: number;
  /** Consecutive-failure count before firing onFail. Default 3. */
  failThreshold?: number;
  /** Wait this long before the first ping. Default 5_000ms. */
  graceMs?: number;
  /** Called once consecutive failures reach failThreshold. */
  onFail: () => void;
  /** Test seam — defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seams for fake timers. */
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
}

export interface HealthcheckHandle {
  /** Stop polling. Idempotent. Aborts in-flight fetch via AbortSignal. */
  stop(): void;
  /** For tests/diagnostics — current consecutive failure count. */
  readonly failCount: number;
  /** For tests — has stop() been called? */
  readonly stopped: boolean;
}

// ── Implementation ────────────────────────────────────────────────────────────

export function startHealthcheck(opts: HealthcheckOptions): HealthcheckHandle {
  const {
    publicUrl,
    intervalMs = 30_000,
    failThreshold = 3,
    graceMs = 5_000,
    onFail,
    fetchImpl = fetch,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  } = opts;

  // Mutable closure state
  let _stopped = false;
  let _failCount = 0;
  let graceHandle: ReturnType<typeof setTimeout> | null = null;
  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  let currentAbortCtrl: AbortController | null = null;

  // ── Per-ping logic ──────────────────────────────────────────────────────────

  const ping = (): void => {
    if (_stopped) return;

    const abortCtrl = new AbortController();
    currentAbortCtrl = abortCtrl;

    // Per-ping timeout: 5 seconds
    const pingTimeout = setTimeoutImpl(() => {
      abortCtrl.abort();
    }, 5_000);

    const url = `${publicUrl}/health`;

    fetchImpl(url, { signal: abortCtrl.signal })
      .then((res) => {
        clearTimeoutImpl(pingTimeout);
        if (_stopped) return;
        currentAbortCtrl = null;

        if (res.ok) {
          // 2xx: reset counter
          _failCount = 0;
        } else {
          _failCount++;
          checkThreshold();
        }
      })
      .catch(() => {
        clearTimeoutImpl(pingTimeout);
        if (_stopped) return;
        currentAbortCtrl = null;

        _failCount++;
        checkThreshold();
      });
  };

  const checkThreshold = (): void => {
    if (_failCount >= failThreshold) {
      // Reset BEFORE firing — onFail handler may take a while
      _failCount = 0;
      onFail();
    }
  };

  // ── Start: schedule grace then fixed interval ───────────────────────────────

  graceHandle = setTimeoutImpl(() => {
    if (_stopped) return;
    graceHandle = null;

    // First ping immediately after grace
    ping();

    // Then fixed interval
    intervalHandle = setIntervalImpl(() => {
      ping();
    }, intervalMs);
  }, graceMs);

  // ── Handle ──────────────────────────────────────────────────────────────────

  const stop = (): void => {
    if (_stopped) return;
    _stopped = true;

    if (graceHandle !== null) {
      clearTimeoutImpl(graceHandle);
      graceHandle = null;
    }

    if (intervalHandle !== null) {
      clearIntervalImpl(intervalHandle);
      intervalHandle = null;
    }

    // Abort any in-flight fetch
    currentAbortCtrl?.abort();
    currentAbortCtrl = null;
  };

  return {
    stop,
    get failCount() { return _failCount; },
    get stopped() { return _stopped; },
  };
}
