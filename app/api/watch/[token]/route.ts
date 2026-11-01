// app/api/watch/[token]/route.ts
// FIX #4: Rate limiter is now ACTUALLY CALLED here — was defined in lib/redis.ts
//         but never wired into any route. Now applied before every DB read.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { watcherRatelimit } from "@/lib/redis";
import { formatWakeTime } from "@/lib/telegram";
import type { WatcherPageData } from "@/types";

export async function GET(
  req: NextRequest,
  { params }: { params: { token: string } }
) {
  // FIX #4: Wire the rate limiter — 60 req/min per IP
  if (watcherRatelimit) {
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const { success } = await watcherRatelimit.limit(ip);
    if (!success) {
      return new NextResponse(null, {
        status: 429,
        headers: { "Retry-After": "10" },
      });
    }
  }

  try {
    // Try friend-specific watcher token first
    const wt = await db.watcherToken.findUnique({
      where: { token: params.token },
      include: { session: { include: { user: true } }, friend: true },
    });

    if (wt) {
      const s = wt.session;
      const now = Date.now();
      const wakeMs = s.wakeAt.getTime();
      const windowValid =
        now >= wakeMs - 30 * 60 * 1000 && now <= wakeMs + 30 * 60 * 1000;
      const effectiveStatus =
        !windowValid && s.status === "ALARM_FIRED" ? "SCHEDULED" : s.status;

      const response: WatcherPageData = {
        sleeperName: s.privacyMode === "ANONYMOUS" ? "Someone" : s.user.name,
        wakeTime: formatWakeTime(s.wakeAt, s.user.timezone),
        reason: s.privacyMode === "OPEN" ? s.reason : null,
        status: effectiveStatus,
        committed: wt.committed,
        markedAwake: wt.markedAwake,
        friendName: wt.friend.name,
        alarmFiredAt: s.alarmFiredAt?.toISOString() ?? null,
        roundsEscalated: s.roundsEscalated,
      };

      return NextResponse.json(response, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    // Fall back to open watch link on session
    const session = await db.sleepSession.findUnique({
      where: { openWatchToken: params.token },
      include: { user: true },
    });

    if (session) {
      const now = Date.now();
      const wakeMs = session.wakeAt.getTime();
      const windowValid =
        now >= wakeMs - 30 * 60 * 1000 && now <= wakeMs + 30 * 60 * 1000;
      const effectiveStatus =
        !windowValid && session.status === "ALARM_FIRED" ? "SCHEDULED" : session.status;

      const response: WatcherPageData = {
        sleeperName:
          session.privacyMode === "ANONYMOUS" ? "Someone" : session.user.name,
        wakeTime: formatWakeTime(session.wakeAt, session.user.timezone),
        reason: session.privacyMode === "OPEN" ? session.reason : null,
        status: effectiveStatus,
        committed: false,
        markedAwake: false,
        friendName: "Anonymous watcher",
        viewOnly: true,
        alarmFiredAt: session.alarmFiredAt?.toISOString() ?? null,
        roundsEscalated: session.roundsEscalated,
      };

      return NextResponse.json(response, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    return NextResponse.json({ error: "Watch link not found" }, { status: 404 });
  } catch (err) {
    console.error("[GET /api/watch/[token]]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
