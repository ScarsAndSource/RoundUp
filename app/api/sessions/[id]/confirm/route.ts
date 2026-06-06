// app/api/sessions/[id]/confirm/route.ts
// FIX #20: Returns ALREADY_CONFIRMED error code instead of generic "Link invalid"
//          when session is already in a terminal state. UI shows helpful message.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { notifyWatcherFirstConfirmed } from "@/lib/telegram";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { token } = await req.json();

    if (!token) {
      return NextResponse.json({ error: "token required" }, { status: 400 });
    }

    // FIX #20: Check terminal states first so we can return a clear error
    const terminalSession = await db.sleepSession.findFirst({
      where: {
        id: params.id,
        confirmToken: token,
        status: { in: ["CONFIRMED", "FAILED", "CANCELLED"] },
      },
    });

    if (terminalSession) {
      // Return distinct error code so the UI shows "You're already awake" not "Link invalid"
      return NextResponse.json(
        { error: "ALREADY_CONFIRMED", status: terminalSession.status },
        { status: 400 }
      );
    }

    const session = await db.sleepSession.findFirst({
      where: {
        id: params.id,
        confirmToken: token,
        status: { in: ["ALARM_FIRED", "ROUND_TWO"] },
      },
      include: {
        user: true,
        tokens: { include: { friend: true } },
      },
    });

    if (!session) {
      return NextResponse.json(
        { error: "Invalid token or session not in an alarm state" },
        { status: 400 }
      );
    }

    const now = new Date();

    await db.$transaction([
      db.sleepSession.update({
        where: { id: session.id },
        data: { status: "FIRST_CONFIRMED", confirmedAt: now },
      }),
      db.escalationEvent.create({
        data: { sessionId: session.id, type: "FIRST_CONFIRMED", sentTo: [] },
      }),
    ]);

    // Tell committed watchers to stay alert for 3 more minutes
    const notifPromises = session.tokens
      .filter((wt) => wt.committed)
      .map(async (wt) => {
        if (wt.friend.telegramChatId) {
          await notifyWatcherFirstConfirmed({
            chatId: wt.friend.telegramChatId,
            sleeperName:
              session.privacyMode === "ANONYMOUS" ? "Someone" : session.user.name,
            watchToken: wt.token,
          });
        }
      });

    await Promise.allSettled(notifPromises);

    return NextResponse.json({ ok: true, status: "FIRST_CONFIRMED" });
  } catch (err) {
    console.error("[POST /api/sessions/[id]/confirm]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
