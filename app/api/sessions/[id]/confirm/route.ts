// app/api/sessions/[id]/confirm/route.ts
// FIX #20: Returns ALREADY_CONFIRMED error code instead of generic "Link invalid"
//          when session is already in a terminal state. UI shows helpful message.
//
// FIX #26: Accepts more starting states so the app can't dead-end:
//   - FIRST_CONFIRMED: Round 2 screen shows up on the device a moment before the
//     cron flips the server to ROUND_TWO. Tapping "I'm Awake" in that gap used to
//     fail silently with "Invalid token". It now simply restarts the 3-minute
//     second-proof window.
//   - SCHEDULED (only once wakeAt has arrived): the device now rings locally at
//     wake time instead of waiting for cron (up to ~2 min late). A 2-minute
//     tolerance covers clock drift between phone and server.
//   The status flip is a guarded updateMany, so it can't clobber a concurrent
//   cancel / confirm / cron write.

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

    const now = new Date();

    const session = await db.sleepSession.findFirst({
      where: {
        id: params.id,
        confirmToken: token,
        OR: [
          { status: { in: ["ALARM_FIRED", "FIRST_CONFIRMED", "ROUND_TWO"] } },
          {
            status: "SCHEDULED",
            wakeAt: { lte: new Date(now.getTime() + 2 * 60 * 1000) },
          },
        ],
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

    const { count } = await db.sleepSession.updateMany({
      where: {
        id: session.id,
        status: { in: ["SCHEDULED", "ALARM_FIRED", "FIRST_CONFIRMED", "ROUND_TWO"] },
      },
      data: {
        status: "FIRST_CONFIRMED",
        confirmedAt: now,
        alarmFiredAt: session.alarmFiredAt ?? now,
      },
    });

    if (count === 0) {
      // Session ended (cancelled / failed / confirmed) between our read and write
      return NextResponse.json(
        { error: "ALREADY_CONFIRMED", status: "CANCELLED" },
        { status: 400 }
      );
    }

    await db.escalationEvent.create({
      data: { sessionId: session.id, type: "FIRST_CONFIRMED", sentTo: [] },
    });

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
