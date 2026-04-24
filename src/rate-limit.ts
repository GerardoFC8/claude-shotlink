export interface RateLimitOptions {
  limit: number;
  windowMs: number;
  /** Hard cap on number of distinct keys tracked. Defaults to 10_000. */
  maxKeys?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

const DEFAULT_MAX_KEYS = 10_000;

export class RateLimiter {
  private readonly buckets = new Map<string, number[]>();
  private readonly options: RateLimitOptions;

  constructor(options: RateLimitOptions) {
    this.options = options;
  }

  check(key: string): RateLimitResult {
    const now = Date.now();
    const cutoff = now - this.options.windowMs;
    const existing = this.buckets.get(key) ?? [];
    const recent = existing.filter((ts) => ts > cutoff);

    // Clean up empty buckets immediately — prevents unbounded growth
    if (recent.length === 0 && this.buckets.has(key)) {
      this.buckets.delete(key);
    }

    if (recent.length >= this.options.limit) {
      const oldest = recent[0] ?? now;
      return {
        allowed: false,
        remaining: 0,
        resetAt: oldest + this.options.windowMs,
      };
    }

    // Enforce hard cap: evict the oldest-inserted key before adding a new one
    const maxKeys = this.options.maxKeys ?? DEFAULT_MAX_KEYS;
    if (!this.buckets.has(key) && this.buckets.size >= maxKeys) {
      // Evict first (oldest-inserted) key
      const firstKey = this.buckets.keys().next().value;
      if (firstKey !== undefined) {
        this.buckets.delete(firstKey);
      }
    }

    recent.push(now);
    this.buckets.set(key, recent);
    return {
      allowed: true,
      remaining: this.options.limit - recent.length,
      resetAt: now + this.options.windowMs,
    };
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  resetAll(): void {
    this.buckets.clear();
  }

  /** @internal For testing only */
  get _bucketCount(): number {
    return this.buckets.size;
  }
}
