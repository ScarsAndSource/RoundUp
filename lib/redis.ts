// lib/redis.ts
// FIX #4: Rate limiters are defined here AND wired into the routes that need them.
// In the original code they were defined but never called — dead code.
// App degrades gracefully when Redis is not configured (no rate limiting / dedup).

import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";

// ── Redis client ───────────────────────────────────────────────────────
let redis: Redis | null = null;

if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
}

export { redis };

// ── Rate limiters ──────────────────────────────────────────────────────

// Watch page: max 60 requests per IP per minute.
// Prevents connection-pool exhaustion when open watch link is shared in a 200-person group.
export let watcherRatelimit: Ratelimit | null = null;

// Session create: max 5 per user per 10 minutes.
export let sessionCreateRatelimit: Ratelimit | null = null;

if (redis) {
  watcherRatelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(60, "1 m"),
    prefix: "rl:watch",
    analytics: false,
  });

  sessionCreateRatelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(5, "10 m"),
    prefix: "rl:session",
    analytics: false,
  });
}

// ── Deduplication ──────────────────────────────────────────────────────

// FIX #23: Prevent double session creation from rapid double-tap or network retry.
// Key is scoped to userId + wakeAt-minute. TTL is 30 seconds.
// Returns true if this is a DUPLICATE (key already existed).
// Returns false if this is the FIRST call (key was newly set).
export async function isDuplicateSession(
  userId: string,
  wakeAtMinuteKey: string
): Promise<boolean> {
  if (!redis) return false;
  const key = `dedup:session:${userId}:${wakeAtMinuteKey}`;
  // SET ... NX returns "OK" on first call, null if key exists
  const result = await redis.set(key, "1", { nx: true, ex: 30 });
  return result === null; // null = key existed = this is a duplicate
}

// ── Escalation dedup ───────────────────────────────────────────────────

// FIX #1 (Critical): Prevent cron from firing the same escalation step twice
// if two cron instances race or a cold start causes a retry.
// Returns true if this is the FIRST call (we should proceed).
// Returns false if another process already fired this step (skip).
export async function claimEscalation(
  sessionId: string,
  step: string
): Promise<boolean> {
  if (!redis) return true; // no Redis = no dedup, always proceed (accept small risk)
  const key = `esc:${sessionId}:${step}`;
  const result = await redis.set(key, "1", { nx: true, ex: 3600 }); // 1hr TTL
  return result !== null; // "OK" = we claimed it first
}
