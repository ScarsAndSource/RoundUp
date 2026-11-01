// app/api/sessions/[id]/status/route.ts
// Polled by ActiveSession every 5s (logged-in app) AND read by the Telegram deep-link page
// (/session/[id]?token=...), which has NO login cookie.
//   - With ?token=<confirmToken>: that token is the credential (same as the confirm routes).
//   - Without it: the signed-in user must own the session.
// Before, the deep-link page called this endpoint without a token, got 401 and showed
// "Could not load session" to anyone not already logged in on that browser.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getOrCreateUser } from "@/lib/supabase";
import type { SessionStatusResponse } from "@/types";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const token = new URL(req.url).searchParams.get("token");

    const where = token
      ? { id: params.id, confirmToken: token }
      : { id: params.id, userId: (await getOrCreateUser()).id };

    const session = await db.sleepSession.findFirst({
      where,
      include: {
        tokens: {
          include: { friend: { select: { id: true, name: true } } },
        },
      },
    });

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const body: SessionStatusResponse = {
      id: session.id,
      status: session.status,
      wakeAt: session.wakeAt.toISOString(),
      alarmFiredAt: session.alarmFiredAt?.toISOString() ?? null,
      confirmedAt: session.confirmedAt?.toISOString() ?? null,
      secondConfirmedAt: session.secondConfirmedAt?.toISOString() ?? null,
      roundsEscalated: session.roundsEscalated,
      watchers: session.tokens.map((wt) => ({
        friendId: wt.friendId,
        name: wt.friend.name,
        committed: wt.committed,
        markedAwake: wt.markedAwake,
      })),
    };

    return NextResponse.json(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("[GET /api/sessions/[id]/status]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
