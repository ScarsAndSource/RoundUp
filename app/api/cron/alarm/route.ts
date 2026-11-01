// app/api/cron/alarm/route.ts
// Called by the scheduler every 2 minutes (Vercel Cron sends the Bearer header itself when
// CRON_SECRET is set; external schedulers such as cron-job.org must send it manually).
// Runs all escalation steps in parallel.

import { NextRequest, NextResponse } from "next/server";
import { runAlarmCycle } from "@/lib/cron";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // If CRON_SECRET is not configured the endpoint stays LOCKED. (Before, an unset secret made
  // the expected header the literal string "Bearer undefined", which anyone could send.)
  const secret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return new NextResponse(null, { status: 401 });
  }

  try {
    const result = await runAlarmCycle();
    console.log("[cron] cycle complete:", result);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[cron] cycle failed:", err);
    return NextResponse.json(
      { error: "Cron cycle failed", ts: new Date().toISOString() },
      { status: 500 }
    );
  }
}
