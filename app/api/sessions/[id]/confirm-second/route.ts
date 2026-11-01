// app/api/sessions/[id]/confirm-second/route.ts
//
// The SECOND proof of being awake. Rules (all enforced here, not just in the UI):
//   - only valid after a real first tap (status FIRST_CONFIRMED) — no skipping it;
//   - only valid at least 2 minutes after that first tap (otherwise "prove you're still
//     awake" is just two quick half-asleep taps);
//   - the status flip is a guarded updateMany: if a friend marked you awake, or the cron
//     escalated / failed the session, in the meantime, exactly one writer wins and stats
//     are counted once.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  notifyWatcherConfirmed,
  sendDebrief,
  sendFriendConversionPrompt,
  formatDuration,
} from "@/lib/telegram";

const MIN_GAP_MS = 2 * 60 * 1000;

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
      where: { id: params.id, confirmToken: token, status: "FIRST_CONFIRMED" },
      include: {
        user: true,
        tokens: { include: { friend: true } },
      },
    });

    if (!session) {
      const other = await db.sleepSession.findFirst({
        where: { id: params.id, confirmToken: token },
      });
      if (other?.status === "CONFIRMED") {
        return NextResponse.json({ ok: true, alreadyConfirmed: true, status: "CONFIRMED" });
      }
      if (other && (other.status === "FAILED" || other.status === "CANCELLED")) {
        return NextResponse.json(
          { error: "SESSION_ENDED", status: other.status },
          { status: 400 }
        );
      }
      return NextResponse.json(
        { error: "Invalid token or session state" },
        { status: 400 }
      );
    }

    const now = new Date();
    const sinceFirstMs = session.confirmedAt
      ? now.getTime() - session.confirmedAt.getTime()
      : 0;
    if (sinceFirstMs < MIN_GAP_MS) {
      return NextResponse.json(
        { error: "TOO_EARLY", retryInSec: Math.ceil((MIN_GAP_MS - sinceFirstMs) / 1000) },
        { status: 400 }
      );
    }

    const duration = formatDuration(session.sleepAt.getTime(), now.getTime());

    const { count } = await db.sleepSession.updateMany({
      where: { id: session.id, status: "FIRST_CONFIRMED" },
      data: {
        status: "CONFIRMED",
        secondConfirmedAt: now,
        sessionEndedAt: now,
      },
    });

    if (count === 0) {
      const after = await db.sleepSession.findUnique({ where: { id: session.id } });
      if (after?.status === "CONFIRMED") {
        // A friend's "I woke them" (or a double tap) won the race — idempotent success
        return NextResponse.json({ ok: true, alreadyConfirmed: true, status: "CONFIRMED" });
      }
      return NextResponse.json(
        { error: "STATE_CHANGED", status: after?.status ?? null },
        { status: 409 }
      );
    }

    // We won — safe to update stats and send notifications
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

    const watcherPromises = session.tokens.map(async (wt) => {
      if (!wt.friend.telegramChatId) return;
      const shownName =
        session.privacyMode === "ANONYMOUS" ? "Someone" : session.user.name;
      await notifyWatcherConfirmed({
        chatId: wt.friend.telegramChatId,
        sleeperName: shownName,
      });
      await sendFriendConversionPrompt({
        chatId: wt.friend.telegramChatId,
        sleeperName: shownName,
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
