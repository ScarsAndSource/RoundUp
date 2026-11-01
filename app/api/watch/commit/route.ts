// app/api/watch/commit/route.ts
// Friend commits to watch. Idempotent.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sendMessage, formatWakeTime } from "@/lib/telegram";

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
      const openSession = await db.sleepSession.findUnique({
      where: { openWatchToken: token },
      select: { id: true },
    });
    if (openSession) {
      return NextResponse.json({ error: "This is a view-only link" }, { status: 403 });
    }
    return NextResponse.json({ error: "Watch token not found" }, { status: 404 });
    }

    // Idempotent — already committed is fine
    if (wt.committed) {
      return NextResponse.json({ ok: true, alreadyCommitted: true });
    }

    await db.watcherToken.update({
      where: { id: wt.id },
      data: { committed: true, committedAt: new Date() },
    });

    // Confirm back to the watcher via Telegram
    if (wt.friend.telegramChatId) {
      const wakeStr = formatWakeTime(
        wt.session.wakeAt,
        wt.session.user.timezone
      );
      await sendMessage(
        wt.friend.telegramChatId,
        `✅ Commitment logged! You'll get an alert if ${wt.session.privacyMode === "ANONYMOUS" ? "Someone" : wt.session.user.name} doesn't wake up by ${wakeStr}.`
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[POST /api/watch/commit]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
