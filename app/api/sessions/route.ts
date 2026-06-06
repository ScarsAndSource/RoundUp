// app/api/sessions/route.ts
// FIX #23: Redis deduplication prevents double session creation on rapid double-tap / network retry.
// FIX #11: Minimum 10-minute wake time enforced — prevents 1-min sessions that race with cron.
// FIX #14: totalSessions increment moved inside the same $transaction as session creation.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getOrCreateUser, ServiceUnavailableError } from "@/lib/supabase";
import { isDuplicateSession } from "@/lib/redis";
import { notifyFriendSessionCreated, formatWakeTime } from "@/lib/telegram";
import type { CreateSessionRequest, CreateSessionResponse } from "@/types";

export async function POST(req: NextRequest) {
  try {
    const user = await getOrCreateUser();
    const body: CreateSessionRequest = await req.json();
    const { wakeAt, friendIds, reason, privacyMode = "MINIMAL", openWatchLink = false } = body;

    if (!wakeAt) {
      return NextResponse.json({ error: "wakeAt is required" }, { status: 400 });
    }

    const wakeDate = new Date(wakeAt);
    if (isNaN(wakeDate.getTime())) {
      return NextResponse.json({ error: "wakeAt must be a valid ISO date" }, { status: 400 });
    }

    const now = new Date();

    // FIX #11: Minimum 10 minutes from now prevents sessions that race with the 2-min cron
    const minWakeAt = new Date(now.getTime() + 10 * 60 * 1000);
    if (wakeDate <= minWakeAt) {
      return NextResponse.json(
        { error: "Wake time must be at least 10 minutes from now" },
        { status: 400 }
      );
    }

    // FIX #23: Dedup — check for double-tap / network retry within 30 seconds
    // Key is userId + wakeAt rounded to the minute
    const wakeMinuteKey = [
      wakeDate.getUTCFullYear(),
      wakeDate.getUTCMonth(),
      wakeDate.getUTCDate(),
      wakeDate.getUTCHours(),
      wakeDate.getUTCMinutes(),
    ].join("-");

    const isDupe = await isDuplicateSession(user.id, wakeMinuteKey);
    if (isDupe) {
      // Return the existing session instead of creating a duplicate
      const existing = await db.sleepSession.findFirst({
        where: {
          userId: user.id,
          status: "SCHEDULED",
          wakeAt: {
            gte: new Date(wakeDate.getTime() - 60_000),
            lte: new Date(wakeDate.getTime() + 60_000),
          },
        },
        orderBy: { createdAt: "desc" },
      });

      if (existing) {
        return NextResponse.json(
          {
            sessionId: existing.id,
            confirmToken: existing.confirmToken,
            openWatchToken: existing.openWatchToken ?? undefined,
            watcherCount: 0,
          } satisfies CreateSessionResponse,
          { status: 200 }
        );
      }
      // If no existing session found (very unusual), fall through to create
    }

    let friends: { id: string }[] = [];
    if (friendIds && friendIds.length > 0) {
      friends = await db.friend.findMany({
        where: { id: { in: friendIds }, ownerId: user.id },
        select: { id: true },
      });
    }

    // FIX #14: totalSessions increment is inside the same $transaction as session creation.
    // Previously it was a separate update that could succeed even if the session rolled back.
    const [session] = await db.$transaction([
      db.sleepSession.create({
        data: {
          userId: user.id,
          wakeAt: wakeDate,
          reason: reason ?? null,
          privacyMode,
          openWatchLink,
          tokens:
            friends.length > 0
              ? { create: friends.map((f) => ({ friendId: f.id })) }
              : undefined,
        },
        include: { tokens: { include: { friend: true } } },
      }),
      db.user.update({
        where: { id: user.id },
        data: { totalSessions: { increment: 1 } },
      }),
    ]);

    const wakeStr = formatWakeTime(wakeDate, user.timezone);
    const sleeperName = privacyMode === "ANONYMOUS" ? "Someone" : user.name;

    // Fire-and-forget Telegram notifications to friends
    const notifPromises = session.tokens.map(async (wt) => {
      await db.friend.update({
        where: { id: wt.friend.id },
        data: { totalWatches: { increment: 1 } },
      });

      if (wt.friend.telegramChatId) {
        await notifyFriendSessionCreated({
          chatId: wt.friend.telegramChatId,
          sleeperName,
          wakeTime: wakeStr,
          reason: reason ?? null,
          privacyMode,
          watchToken: wt.token,
        });
      }
    });

    await Promise.allSettled(notifPromises);

    await db.escalationEvent.create({
      data: {
        sessionId: session.id,
        type: "SESSION_CREATED",
        sentTo: session.tokens
          .map((wt) => wt.friend.telegramChatId)
          .filter(Boolean) as string[],
      },
    });

    const response: CreateSessionResponse = {
      sessionId: session.id,
      confirmToken: session.confirmToken,
      openWatchToken: openWatchLink ? (session.openWatchToken ?? undefined) : undefined,
      watcherCount: session.tokens.length,
    };

    return NextResponse.json(response, { status: 201 });
  } catch (err) {
    if (err instanceof ServiceUnavailableError) {
      return NextResponse.json({ error: "Service temporarily unavailable" }, {
        status: 503,
        headers: { "Retry-After": "10" },
      });
    }
    const msg = err instanceof Error ? err.message : "Unknown";
    if (msg === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("[POST /api/sessions]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const user = await getOrCreateUser();
    const { searchParams } = new URL(req.url);
    const limit = Math.min(parseInt(searchParams.get("limit") ?? "20"), 50);
    const cursor = searchParams.get("cursor");

    const sessions = await db.sleepSession.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        tokens: {
          where: { OR: [{ committed: true }, { markedAwake: true }] },
          include: { friend: { select: { id: true, name: true } } },
          take: 1,
          orderBy: { committedAt: "asc" },
        },
        events: {
          select: { type: true, triggeredAt: true },
          orderBy: { triggeredAt: "asc" },
        },
      },
    });

    const hasMore = sessions.length > limit;
    const items = hasMore ? sessions.slice(0, limit) : sessions;

    return NextResponse.json({
      sessions: items.map((s) => ({
        id: s.id,
        wakeAt: s.wakeAt.toISOString(),
        sleepAt: s.sleepAt.toISOString(),
        status: s.status,
        reason: s.reason,
        roundsEscalated: s.roundsEscalated,
        confirmedAt: s.confirmedAt?.toISOString() ?? null,
        secondConfirmedAt: s.secondConfirmedAt?.toISOString() ?? null,
        primaryWatcher: s.tokens[0]?.friend ?? null,
        events: s.events.map((e) => ({
          type: e.type,
          triggeredAt: e.triggeredAt.toISOString(),
        })),
      })),
      nextCursor: hasMore ? items[items.length - 1].id : null,
    });
  } catch (err) {
    console.error("[GET /api/sessions]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
