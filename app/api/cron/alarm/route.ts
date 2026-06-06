// app/api/cron/alarm/route.ts
// Called by Vercel Cron every 2 minutes.
// Runs all four escalation steps in parallel.

import { NextRequest, NextResponse } from "next/server";
import { runAlarmCycle } from "@/lib/cron";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // Verify the cron secret (set in Vercel dashboard)
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
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
