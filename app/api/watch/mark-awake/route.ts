// app/api/watch/mark-awake/route.ts
// FIX #2 (Critical): Same optimistic concurrency guard as confirm-second.
//         updateMany with `status: { not: "CONFIRMED" }` means only one writer wins
//         if mark-awake and confirm-second race simultaneously.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sendMessage, sendDebrief, sendFriendConversionPrompt, formatDuration } from "@/lib/telegram";

export async function POST(req: NextRequest) {
  try {
    const { token } = await req.json();

    if (!token) {
      return NextResponse.json({ error: "token required" }, { status: 400 });
    }

    const wt = await db.watcherToken.findUnique({
      where: { token },
      include: {
        session: { include: { user: true } },
        friend: true,
      },
    });

    if (!wt) {
      return NextResponse.json({ error: "Watch token not found" }, { status: 404 });
    }

    // Idempotent — already marked is fine
    if (wt.markedAwake) {
      return NextResponse.json({ ok: true, alreadyMarked: true });
    }

    const activeStatuses = ["ALARM_FIRED", "FIRST_CONFIRMED", "ROUND_TWO"];
    if (!activeStatuses.includes(wt.session.status)) {
      return NextResponse.json(
        { error: "Session is not in an active alarm state" },
        { status: 400 }
      );
    }

    const now = new Date();
    const duration = formatDuration(wt.session.sleepAt.getTime(), now.getTime());

    // Mark the watcher token first (this is fine to do eagerly)
    await db.watcherToken.update({
      where: { id: wt.id },
      data: { markedAwake: true, markedAt: now },
    });

    // FIX #2 (Critical): Optimistic concurrency — only confirm if not already confirmed
    const { count } = await db.sleepSession.updateMany({
      where: {
        id: wt.sessionId,
        status: { not: "CONFIRMED" }, // guard
      },
      data: {
        status: "CONFIRMED",
        secondConfirmedAt: now,
        sessionEndedAt: now,
      },
    });

    if (count === 0) {
      // confirm-second already won the race — still return success
      return NextResponse.json({ ok: true, alreadyConfirmed: true, saverName: wt.friend.name, duration });
    }

    // We confirmed first — write stats and send notifications
    await db.$transaction([
      db.friend.update({
        where: { id: wt.friendId },
        data: { totalSaves: { increment: 1 } },
      }),
      db.user.update({
        where: { id: wt.session.userId },
        data: { totalSuccesses: { increment: 1 } },
      }),
      db.escalationEvent.create({
        data: {
          sessionId: wt.sessionId,
          type: "CONFIRMED",
          sentTo: [wt.friend.telegramChatId ?? ""].filter(Boolean),
        },
      }),
    ]);

    if (wt.session.user.telegramChatId) {
      await sendMessage(
        wt.session.user.telegramChatId,
        `☀️ ${wt.friend.name} confirmed you're awake. Session complete. Good morning!`
      );
      await sendDebrief({
        chatId: wt.session.user.telegramChatId,
        saverName: wt.friend.name,
        rounds: wt.session.roundsEscalated + 1,
        duration,
        totalSessions: wt.session.user.totalSessions,
        totalSuccesses: wt.session.user.totalSuccesses + 1,
      });
    }

    if (wt.friend.telegramChatId) {
      await sendFriendConversionPrompt({
        chatId: wt.friend.telegramChatId,
        sleeperName: wt.session.user.name,
      });
    }

    return NextResponse.json({ ok: true, saverName: wt.friend.name, duration });
  } catch (err) {
    console.error("[POST /api/watch/mark-awake]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
