// app/api/sessions/[id]/cancel/route.ts
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getOrCreateUser } from "@/lib/supabase";
import { sendMessage } from "@/lib/telegram";

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

    await db.sleepSession.update({
      where: { id: session.id },
      data: { status: "CANCELLED", sessionEndedAt: new Date() },
    });

    // Notify watchers it's cancelled
    const notifPromises = session.tokens.map(async (wt) => {
      if (wt.friend.telegramChatId) {
        await sendMessage(
          wt.friend.telegramChatId,
          `ℹ️ ${session.privacyMode === "ANONYMOUS" ? "Someone" : user.name} has cancelled their wake session. All clear!`
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
