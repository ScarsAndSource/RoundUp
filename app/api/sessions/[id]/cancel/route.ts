// app/api/sessions/[id]/cancel/route.ts
// The status flip is guarded: it only cancels a session that is STILL in progress, so a
// cancel can never overwrite CONFIRMED / FAILED, and the cron can't resurrect it afterwards.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getOrCreateUser } from "@/lib/supabase";
import { sendMessage, escapeHtml } from "@/lib/telegram";

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const user = await getOrCreateUser();

    const session = await db.sleepSession.findFirst({
      where: {
        id: params.id,
        userId: user.id,
        status: { in: ["SCHEDULED", "ALARM_FIRED", "FIRST_CONFIRMED", "ROUND_TWO"] },
      },
      include: { tokens: { include: { friend: true } } },
    });

    if (!session) {
      return NextResponse.json({ error: "Session not found or not cancellable" }, { status: 404 });
    }

    const { count } = await db.sleepSession.updateMany({
      where: {
        id: session.id,
        status: { in: ["SCHEDULED", "ALARM_FIRED", "FIRST_CONFIRMED", "ROUND_TWO"] },
      },
      data: { status: "CANCELLED", sessionEndedAt: new Date() },
    });

    if (count === 0) {
      // finished (or failed) between our read and write
      return NextResponse.json({ error: "Session not found or not cancellable" }, { status: 404 });
    }

    const shownName = session.privacyMode === "ANONYMOUS" ? "Someone" : user.name;
    const notifPromises = session.tokens.map(async (wt) => {
      if (wt.friend.telegramChatId) {
        await sendMessage(
          wt.friend.telegramChatId,
          `ℹ️ ${escapeHtml(shownName)} has cancelled their wake session. All clear!`
        );
      }
    });

    await Promise.allSettled(notifPromises);

    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("[POST /api/sessions/[id]/cancel]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
