import "server-only";

// Rate limiting for the AI route.
//
// • When UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are set, counters live in Redis and are
//   shared by every serverless instance (fixed windows via INCR + EXPIRE NX).
// • Otherwise an in-memory limiter is used. On serverless platforms each warm instance has its own
//   memory, so this is best-effort only — it is NOT comprehensive protection. The hard ceiling on
//   cost is that the Gemini key belongs to a project without billing (free tier only).

export type LimitDecision = { allowed: true } | { allowed: false; scope: "minute" | "day" | "global"; retryAfterS: number };

export interface RateLimiter {
  readonly persistent: boolean;
  check(clientKey: string, now?: number): Promise<LimitDecision>;
  /** Returns false if this requestId was already seen recently (duplicate submission). */
  claim(requestId: string, now?: number): Promise<boolean>;
}

export function limits() {
  const n = (v: string | undefined, d: number) => {
    const x = Number(v);
    return Number.isInteger(x) && x > 0 ? x : d;
  };
  return {
    perMinute: n(process.env.AI_RATE_LIMIT_PER_MINUTE, 5),
    perDay: n(process.env.AI_RATE_LIMIT_PER_DAY, 40),
    globalPerDay: n(process.env.AI_GLOBAL_DAILY_LIMIT, 300),
  };
}

function windows(now: number) {
  const minute = Math.floor(now / 60000);
  const day = Math.floor(now / 86400000);
  return {
    minute,
    day,
    minuteRetry: Math.ceil(((minute + 1) * 60000 - now) / 1000),
    dayRetry: Math.ceil(((day + 1) * 86400000 - now) / 1000),
  };
}

export class MemoryRateLimiter implements RateLimiter {
  readonly persistent = false;
  private counts = new Map<string, { n: number; exp: number }>();
  private seen = new Map<string, number>();

  constructor(private cfg = limits()) {}

  private incr(key: string, ttlMs: number, now: number) {
    const cur = this.counts.get(key);
    if (!cur || cur.exp <= now) {
      this.counts.set(key, { n: 1, exp: now + ttlMs });
      return 1;
    }
    cur.n += 1;
    return cur.n;
  }

  private sweep(now: number) {
    if (this.counts.size < 5000 && this.seen.size < 5000) return;
    for (const [k, v] of this.counts) if (v.exp <= now) this.counts.delete(k);
    for (const [k, v] of this.seen) if (v <= now) this.seen.delete(k);
  }

  async check(clientKey: string, now = Date.now()): Promise<LimitDecision> {
    this.sweep(now);
    const w = windows(now);
    if (this.incr(`m:${clientKey}:${w.minute}`, 60000, now) > this.cfg.perMinute) return { allowed: false, scope: "minute", retryAfterS: w.minuteRetry };
    if (this.incr(`d:${clientKey}:${w.day}`, 86400000, now) > this.cfg.perDay) return { allowed: false, scope: "day", retryAfterS: w.dayRetry };
    if (this.incr(`g:${w.day}`, 86400000, now) > this.cfg.globalPerDay) return { allowed: false, scope: "global", retryAfterS: w.dayRetry };
    return { allowed: true };
  }

  async claim(requestId: string, now = Date.now()) {
    const exp = this.seen.get(requestId);
    if (exp && exp > now) return false;
    this.seen.set(requestId, now + 120000);
    return true;
  }
}

export class UpstashRateLimiter implements RateLimiter {
  readonly persistent = true;
  constructor(
    private url: string,
    private token: string,
    private fallback: RateLimiter,
    private cfg = limits(),
  ) {}

  private async pipeline(commands: (string | number)[][]): Promise<unknown[] | null> {
    try {
      const res = await fetch(`${this.url.replace(/\/$/, "")}/pipeline`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(commands),
        cache: "no-store",
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { result?: unknown }[];
      return data.map((d) => d.result);
    } catch {
      return null;
    }
  }

  async check(clientKey: string, now = Date.now()): Promise<LimitDecision> {
    const w = windows(now);
    const keys = [`autodyn:m:${clientKey}:${w.minute}`, `autodyn:d:${clientKey}:${w.day}`, `autodyn:g:${w.day}`];
    const r = await this.pipeline([
      ["INCR", keys[0]], ["EXPIRE", keys[0], 70, "NX"],
      ["INCR", keys[1]], ["EXPIRE", keys[1], 90000, "NX"],
      ["INCR", keys[2]], ["EXPIRE", keys[2], 90000, "NX"],
    ]);
    if (!r) return this.fallback.check(clientKey, now);
    const [m, , d, , g] = r.map(Number);
    if (m > this.cfg.perMinute) return { allowed: false, scope: "minute", retryAfterS: w.minuteRetry };
    if (d > this.cfg.perDay) return { allowed: false, scope: "day", retryAfterS: w.dayRetry };
    if (g > this.cfg.globalPerDay) return { allowed: false, scope: "global", retryAfterS: w.dayRetry };
    return { allowed: true };
  }

  async claim(requestId: string, now = Date.now()) {
    const r = await this.pipeline([["SET", `autodyn:req:${requestId}`, 1, "EX", 120, "NX"]]);
    if (!r) return this.fallback.claim(requestId, now);
    return r[0] === "OK";
  }
}

let shared: RateLimiter | null = null;

export function getRateLimiter(): RateLimiter {
  if (shared) return shared;
  const memory = new MemoryRateLimiter();
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  shared = url && token && /^https:\/\//.test(url) ? new UpstashRateLimiter(url, token, memory) : memory;
  return shared;
}

export type RateLimiterInfo = {
  /** upstash: counters shared by every serverless instance · memory: per warm instance only (best-effort). */
  backend: "upstash" | "memory";
  persistent: boolean;
  limits: { perMinute: number; perDay: number; globalPerDay: number };
};

/** Non-secret description of the limiter in use, so a deployment can be checked for global enforcement. */
export function rateLimiterInfo(): RateLimiterInfo {
  const limiter = getRateLimiter();
  return { backend: limiter.persistent ? "upstash" : "memory", persistent: limiter.persistent, limits: limits() };
}

/** Test hook: forget the shared limiter so environment changes are picked up. */
export function resetRateLimiter() {
  shared = null;
}

export async function clientKeyFrom(headers: Headers) {
  const ip = headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip") || "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`autodyn:${ip}`));
  return Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}
