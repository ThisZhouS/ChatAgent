export interface RateLimitRule {
  /** Maximum number of events inside the window. */
  limit: number;
  windowMs: number;
}

export interface RateLimitDecision {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * In-process sliding-window limiter. Deliberately dependency-free: a single
 * node deployment needs brute-force protection, not a distributed quota.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly rules: Record<string, RateLimitRule>) {}

  check(bucket: string, key: string, now: number = Date.now()): RateLimitDecision {
    const rule = this.rules[bucket];
    if (!rule) return { ok: true, remaining: Number.MAX_SAFE_INTEGER, retryAfterSeconds: 0 };

    const mapKey = `${bucket}:${key}`;
    const cutoff = now - rule.windowMs;
    const existing = (this.hits.get(mapKey) ?? []).filter((timestamp) => timestamp > cutoff);

    if (existing.length >= rule.limit) {
      const oldest = existing[0] ?? now;
      this.hits.set(mapKey, existing);
      return {
        ok: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + rule.windowMs - now) / 1000)),
      };
    }

    existing.push(now);
    this.hits.set(mapKey, existing);
    this.prune(now);
    return { ok: true, remaining: rule.limit - existing.length, retryAfterSeconds: 0 };
  }

  /** Drops buckets whose window has fully expired. */
  private prune(now: number): void {
    if (this.hits.size < 5000) return;
    const longest = Math.max(...Object.values(this.rules).map((rule) => rule.windowMs), 60_000);
    for (const [key, timestamps] of this.hits.entries()) {
      const last = timestamps[timestamps.length - 1] ?? 0;
      if (now - last > longest) this.hits.delete(key);
    }
  }
}

export const DEFAULT_RATE_LIMITS: Record<string, RateLimitRule> = {
  login: { limit: 10, windowMs: 60_000 },
  loginIp: { limit: 60, windowMs: 60_000 },
  webhook: { limit: 300, windowMs: 60_000 },
  write: { limit: 240, windowMs: 60_000 },
  upload: { limit: 30, windowMs: 60_000 },
};
