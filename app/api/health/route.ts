// app/api/health/route.ts
// System health check — called before every sleep session creation.
// Checks DB, Redis, and Telegram connectivity.
// Response is used to show the green/yellow/red dot in the UI.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import type { HealthStatus } from "@/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const ts = new Date().toISOString();

  // Check DB
  let dbStatus: HealthStatus["db"] = "ok";
  try {
    await db.$queryRaw`SELECT 1`;
  } catch {
    dbStatus = "error";
  }

  // Check Redis
  let redisStatus: HealthStatus["redis"] = "unconfigured";
  if (redis) {
    try {
      await redis.ping();
      redisStatus = "ok";
    } catch {
      redisStatus = "error";
    }
  }

  // Check Telegram token is configured (not a live ping — just existence check)
  const telegramStatus: HealthStatus["telegram"] = process.env.TELEGRAM_BOT_TOKEN
    ? "ok"
    : "error";

  const ok = dbStatus === "ok" && telegramStatus === "ok";

  const body: HealthStatus = { ok, db: dbStatus, redis: redisStatus, telegram: telegramStatus, ts };

  return NextResponse.json(body, {
    status: ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
