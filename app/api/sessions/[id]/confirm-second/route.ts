// app/api/sessions/[id]/confirm-second/route.ts
// FIX #2 (Critical): Optimistic concurrency guard prevents double stat increments
//         when confirm-second and mark-awake race each other.
//         updateMany with `status: { not: "CONFIRMED" }` ensures only ONE writer wins.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  notifyWatcherConfirmed,
  sendDebrief,
  sendFriendConversionPrompt,
  formatDuration,
} from "@/lib/telegram";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { token } = await req.json();

    if (!token) {
      return NextResponse.json({ error: "token required" }, { status: 400 });
    }

    const session = await db.sleepSession.findFirst({
      where: {
        id: params.id,
        confirmToken: token,
        status: { in: ["FIRST_CONFIRMED", "ROUND_TWO", "ALARM_FIRED"] },
      },
      include: {
        user: true,
        tokens: { include: { friend: true } },
      },
    });

    if (!session) {
      // FIX #20: Distinct message for already-confirmed sessions
      const terminal = await db.sleepSession.findFirst({
        where: { id: params.id, confirmToken: token, status: "CONFIRMED" },
      });
      if (terminal) {
        return NextResponse.json(
          { ok: true, alreadyConfirmed: true, status: "CONFIRMED" },
          { status: 200 }
        );
      }
      return NextResponse.json(
        { error: "Invalid token or session state" },
        { status: 400 }
      );
    }

    const now = new Date();
    const duration = formatDuration(session.sleepAt.getTime(), now.getTime());

    // FIX #2 (Critical): Use updateMany with optimistic concurrency guard.
    // If confirm-second and mark-awake race, only the first one writes (count === 1).
    // The second finds count === 0 and returns a graceful no-op response.
    const { count } = await db.sleepSession.updateMany({
      where: {
        id: session.id,
        status: { not: "CONFIRMED" }, // guard — reject if already confirmed
      },
      data: {
        status: "CONFIRMED",
        secondConfirmedAt: now,
        sessionEndedAt: now,
      },
    });

    if (count === 0) {
      // Another concurrent request already confirmed — idempotent success
      return NextResponse.json({ ok: true, alreadyConfirmed: true, status: "CONFIRMED" });
    }

    // We won the race — safe to update stats and send notifications
    const saver =
      session.tokens.find((wt) => wt.markedAwake) ??
      session.tokens.find((wt) => wt.committed) ??
      null;

    await db.$transaction([
      db.user.update({
        where: { id: session.userId },
        data: { totalSuccesses: { increment: 1 } },
      }),
      db.escalationEvent.create({
        data: { sessionId: session.id, type: "CONFIRMED", sentTo: [] },
      }),
      ...(saver
        ? [
            db.friend.update({
              where: { id: saver.friendId },
              data: { totalSaves: { increment: 1 } },
            }),
          ]
        : []),
    ]);

    // Notify watchers
    const watcherPromises = session.tokens.map(async (wt) => {
      if (!wt.friend.telegramChatId) return;
      await notifyWatcherConfirmed({
        chatId: wt.friend.telegramChatId,
        sleeperName:
          session.privacyMode === "ANONYMOUS" ? "Someone" : session.user.name,
      });
      await sendFriendConversionPrompt({
        chatId: wt.friend.telegramChatId,
        sleeperName:
          session.privacyMode === "ANONYMOUS" ? "Someone" : session.user.name,
      });
    });

    await Promise.allSettled(watcherPromises);

    if (session.user.telegramChatId) {
      await sendDebrief({
        chatId: session.user.telegramChatId,
        saverName: saver?.friend.name ?? null,
        rounds: session.roundsEscalated + 1,
        duration,
        totalSessions: session.user.totalSessions,
        totalSuccesses: session.user.totalSuccesses + 1,
      });
    }

    return NextResponse.json({
      ok: true,
      status: "CONFIRMED",
      saverName: saver?.friend.name ?? null,
      duration,
    });
  } catch (err) {
    console.error("[POST /api/sessions/[id]/confirm-second]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
