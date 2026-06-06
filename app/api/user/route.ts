// app/api/user/route.ts
import { NextResponse } from "next/server";
import { getOrCreateUser, createSupabaseServerClient } from "@/lib/supabase";

export async function GET() {
  try {
    // Get supabaseId from auth session for Telegram deep link
    const supabase = createSupabaseServerClient();
    const { data: { user: authUser } } = await supabase.auth.getUser();
    const user = await getOrCreateUser();

    return NextResponse.json({
      id: user.id,
      supabaseId: authUser?.id ?? "",   // needed for Telegram /start link
      name: user.name,
      email: user.email,
      telegramChatId: user.telegramChatId,
      telegramUsername: user.telegramUsername,
      timezone: user.timezone,
      totalSessions: user.totalSessions,
      totalSuccesses: user.totalSuccesses,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    console.error("[GET /api/user]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const user = await getOrCreateUser();
    const { db } = await import("@/lib/db");
    const body = await req.json() as { timezone?: string; privacyDefault?: string };
    const updated = await db.user.update({
      where: { id: user.id },
      data: {
        ...(body.timezone ? { timezone: body.timezone } : {}),
        ...(body.privacyDefault ? { privacyDefault: body.privacyDefault as never } : {}),
      },
    });
    return NextResponse.json({ timezone: updated.timezone, privacyDefault: updated.privacyDefault });
  } catch (err) {
    console.error("[PATCH /api/user]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
