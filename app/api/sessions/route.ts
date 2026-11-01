// app/api/sessions/route.ts
// POST — create a sleep session.   GET — paginated session history.
//
// Hardening in this version:
//  - every input is validated and answers 400 (bad JSON, bad enum values, friendIds not an
//    array, wake time more than 48h away) instead of crashing into a 500;
//  - double-tap / network-retry dedupe now works WITHOUT Redis (database check), and Redis
//    only closes the tiny race where both requests arrive at the same instant;
//  - the dedupe response reports the real watcherCount;
//  - the response says how many watchers can actually be alerted (reachableWatchers);
//  - GET maps auth/outage errors to 401/503 and survives limit=abc / 0 / -3.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getOrCreateUser, ServiceUnavailableError } from "@/lib/supabase";
import { isDuplicateSession, sessionCreateRatelimit } from "@/lib/redis";
import { notifyFriendSessionCreated, formatWakeTime } from "@/lib/telegram";
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  PrivacyMode,
  WakeReason,
} from "@/types";

const PRIVACY_MODES = ["OPEN", "MINIMAL", "ANONYMOUS"];
const REASONS = ["EXAM", "FLIGHT", "MEETING", "WORKOUT", "OTHER"];
const MIN_LEAD_MS = 10 * 60 * 1000;       // min 10 min: cron runs every 2 min
const MAX_LEAD_MS = 48 * 60 * 60 * 1000;  // the UI only ever picks the next 24h
const MAX_FRIENDS_PER_SESSION = 20;       // same cap as the friends list itself

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(req: NextRequest) {
  try {
    const user = await getOrCreateUser();

    // ── input validation ───────────────────────────────────────────────
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return bad("Request body must be valid JSON");
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return bad("Request body must be a JSON object");
    }
    const body = raw as Partial<Record<keyof CreateSessionRequest, unknown>>;

    if (typeof body.wakeAt !== "string" || body.wakeAt.length === 0) {
      return bad("wakeAt is required");
    }
    const wakeDate = new Date(body.wakeAt);
    if (isNaN(wakeDate.getTime())) return bad("wakeAt must be a valid ISO date");

    const now = new Date();
    if (wakeDate.getTime() <= now.getTime() + MIN_LEAD_MS) {
      return bad("Wake time must be at least 10 minutes from now");
    }
    if (wakeDate.getTime() > now.getTime() + MAX_LEAD_MS) {
      return bad("Wake time can be at most 48 hours from now");
    }

    const privacyRaw = body.privacyMode ?? "MINIMAL";
    if (typeof privacyRaw !== "string" || !PRIVACY_MODES.includes(privacyRaw)) {
      return bad("Invalid privacyMode");
    }
    const privacyMode = privacyRaw as PrivacyMode;

    const reasonRaw = body.reason ?? null;
    if (reasonRaw !== null && (typeof reasonRaw !== "string" || !REASONS.includes(reasonRaw))) {
      return bad("Invalid reason");
    }
    const reason = reasonRaw as WakeReason | null;

    let friendIds: string[] = [];
    if (body.friendIds !== undefined && body.friendIds !== null) {
      if (
        !Array.isArray(body.friendIds) ||
        body.friendIds.length > MAX_FRIENDS_PER_SESSION ||
        body.friendIds.some((x) => typeof x !== "string")
      ) {
        return bad("friendIds must be an array of friend ids");
      }
      friendIds = Array.from(new Set(body.friendIds as string[]));
    }

    const openWatchLink = body.openWatchLink === true;

    // ── double-tap / retry dedupe ──────────────────────────────────────
    // Same user + same wake minute within 30 s → hand back the session we already made.
    // The DB check works with or without Redis; Redis only catches the case where both
    // requests arrive at the same instant (the first hasn't committed yet).
    const findExisting = () =>
      db.sleepSession.findFirst({
        where: {
          userId: user.id,
          status: "SCHEDULED",
          wakeAt: {
            gte: new Date(wakeDate.getTime() - 60_000),
            lte: new Date(wakeDate.getTime() + 60_000),
          },
          createdAt: { gte: new Date(now.getTime() - 30_000) },
        },
        orderBy: { createdAt: "desc" },
        include: { tokens: { include: { friend: true } } },
      });

    const wakeMinuteKey = [
      wakeDate.getUTCFullYear(),
      wakeDate.getUTCMonth(),
      wakeDate.getUTCDate(),
      wakeDate.getUTCHours(),
      wakeDate.getUTCMinutes(),
    ].join("-");

    const redisSaysDuplicate = await isDuplicateSession(user.id, wakeMinuteKey);
    let existing = await findExisting();
    if (!existing && redisSaysDuplicate) {
      await sleep(400); // let the first request finish committing
      existing = await findExisting();
    }

    if (existing) {
      return NextResponse.json(
        {
          sessionId: existing.id,
          confirmToken: existing.confirmToken,
          openWatchToken: existing.openWatchLink
            ? existing.openWatchToken ?? undefined
            : undefined,
          watcherCount: existing.tokens.length,
          reachableWatchers: existing.tokens.filter((t) => t.friend.telegramChatId).length,
        } satisfies CreateSessionResponse,
        { status: 200 }
      );
    }

    // Per-user create limit (5 per 10 min). Duplicate double-taps already returned above,
    // so only genuinely new sessions are counted.
    if (sessionCreateRatelimit) {
      const { success } = await sessionCreateRatelimit.limit(user.id);
      if (!success) {
        return NextResponse.json(
          { error: "Too many sessions created. Try again in a few minutes." },
          { status: 429, headers: { "Retry-After": "60" } }
        );
      }
    }

    // Only friends that belong to THIS user are accepted
    let friends: { id: string }[] = [];
    if (friendIds.length > 0) {
      friends = await db.friend.findMany({
        where: { id: { in: friendIds }, ownerId: user.id },
        select: { id: true },
      });
    }

    const [session] = await db.$transaction([
      db.sleepSession.create({
        data: {
          userId: user.id,
          wakeAt: wakeDate,
          reason,
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
      reachableWatchers: session.tokens.filter((wt) => wt.friend.telegramChatId).length,
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

    // limit=abc / 0 / -3 fall back to 20; anything above 50 is capped at 50
    const parsed = parseInt(searchParams.get("limit") ?? "20", 10);
    const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 50) : 20;
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
    if (err instanceof ServiceUnavailableError) {
      return NextResponse.json({ error: "Service temporarily unavailable" }, {
        status: 503,
        headers: { "Retry-After": "10" },
      });
    }
    const msg = err instanceof Error ? err.message : "";
    if (msg === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("[GET /api/sessions]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
