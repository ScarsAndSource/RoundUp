// app/api/friends/route.ts
// FIX #8:  GET now exposes telegramDisconnected flag when chatId was nulled by a 403.
// FIX #9:  DELETE blocks removal of a friend who has an active committed WatcherToken.
//          Prevents silent loss of a watcher mid-session.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getOrCreateUser, ServiceUnavailableError } from "@/lib/supabase";
import type { CreateFriendRequest, FriendPublic } from "@/types";

// GET — list user's friends, sorted by most helpful
export async function GET() {
  try {
    const user = await getOrCreateUser();

    const friends = await db.friend.findMany({
      where: { ownerId: user.id },
      orderBy: [{ totalSaves: "desc" }, { createdAt: "asc" }],
    });

    // FIX #8: Expose telegramDisconnected = true when a friend's chatId was cleared by a 403
    // (i.e. they blocked the bot). UI can show "Telegram disconnected" state.
    const result: (FriendPublic & { telegramDisconnected?: boolean })[] =
      friends.map((f) => ({
        id: f.id,
        name: f.name,
        channel: f.channel,
        telegramLinked: !!f.telegramChatId,
        // A friend is "disconnected" if they had linkedAt (previously connected) but no chatId now
        telegramDisconnected: !!f.linkedAt && !f.telegramChatId,
        timezone: f.timezone,
        totalWatches: f.totalWatches,
        totalSaves: f.totalSaves,
        linkToken: f.linkToken,
        linkedAt: f.linkedAt?.toISOString() ?? null,
      }));

    return NextResponse.json({ friends: result });
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
    console.error("[GET /api/friends]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST — add a new friend
export async function POST(req: NextRequest) {
  try {
    const user = await getOrCreateUser();
    const body: CreateFriendRequest = await req.json();
    const { name, phone, channel = "TELEGRAM", timezone = "Asia/Kolkata" } = body;

    if (!name || name.trim().length < 1) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }
    if (name.trim().length > 50) {
      return NextResponse.json({ error: "Name too long" }, { status: 400 });
    }

    const existingCount = await db.friend.count({ where: { ownerId: user.id } });
    if (existingCount >= 20) {
      return NextResponse.json(
        { error: "Maximum 20 friends per account" },
        { status: 400 }
      );
    }

    const friend = await db.friend.create({
      data: {
        ownerId: user.id,
        name: name.trim(),
        phone: phone?.trim() ?? null,
        channel,
        timezone,
      },
    });

    const inviteLink = `https://t.me/${
      process.env.TELEGRAM_BOT_USERNAME ??
      process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME ??
      "roundupbot"
    }?start=friend_${friend.linkToken}`;

    const result: FriendPublic = {
      id: friend.id,
      name: friend.name,
      channel: friend.channel,
      telegramLinked: false,
      timezone: friend.timezone,
      totalWatches: 0,
      totalSaves: 0,
      linkToken: friend.linkToken,
      linkedAt: null,
    };

    return NextResponse.json({ friend: result, inviteLink }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("[POST /api/friends]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE — remove a friend by ID (body: { friendId })
export async function DELETE(req: NextRequest) {
  try {
    const user = await getOrCreateUser();
    const { friendId } = await req.json();

    if (!friendId) {
      return NextResponse.json({ error: "friendId required" }, { status: 400 });
    }

    const friend = await db.friend.findFirst({
      where: { id: friendId, ownerId: user.id },
    });

    if (!friend) {
      return NextResponse.json({ error: "Friend not found" }, { status: 404 });
    }

    // FIX #9: Block deletion if friend is an active committed watcher on a live session.
    // Silently removing them would leave the session with no watcher and no notification.
    const activeToken = await db.watcherToken.findFirst({
      where: {
        friendId,
        committed: true,
        session: {
          status: {
            in: ["SCHEDULED", "ALARM_FIRED", "FIRST_CONFIRMED", "ROUND_TWO"],
          },
        },
      },
    });

    if (activeToken) {
      return NextResponse.json(
        {
          error:
            "Cannot remove a committed watcher during an active session. Wait until the session ends.",
        },
        { status: 409 }
      );
    }

    await db.friend.delete({ where: { id: friendId } });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /api/friends]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
