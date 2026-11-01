// app/api/user/route.ts
// GET  — current user's profile (+ supabaseId for the Telegram deep link).
// PATCH — update timezone / default privacy. Both are validated: an invalid timezone used to be
//         saved as-is and then silently break every wake-time message.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  getOrCreateUser,
  createSupabaseServerClient,
  ServiceUnavailableError,
} from "@/lib/supabase";
import { isValidTimezone } from "@/lib/validate";

const PRIVACY = ["OPEN", "MINIMAL", "ANONYMOUS"] as const;
type Privacy = (typeof PRIVACY)[number];

function errorResponse(err: unknown, label: string) {
  if (err instanceof ServiceUnavailableError) {
    return NextResponse.json({ error: "Service temporarily unavailable" }, {
      status: 503,
      headers: { "Retry-After": "10" },
    });
  }
  const msg = err instanceof Error ? err.message : "";
  if (msg === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  console.error(label, err);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

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
    return errorResponse(err, "[GET /api/user]");
  }
}

export async function PATCH(req: Request) {
  try {
    const user = await getOrCreateUser();

    let body: { timezone?: unknown; privacyDefault?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
    }
    if (typeof body !== "object" || body === null) {
      return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
    }

    const data: { timezone?: string; privacyDefault?: Privacy } = {};

    if (body.timezone !== undefined) {
      if (!isValidTimezone(body.timezone)) {
        return NextResponse.json({ error: "Invalid timezone" }, { status: 400 });
      }
      data.timezone = body.timezone;
    }
    if (body.privacyDefault !== undefined) {
      if (typeof body.privacyDefault !== "string" || !(PRIVACY as readonly string[]).includes(body.privacyDefault)) {
        return NextResponse.json({ error: "Invalid privacyDefault" }, { status: 400 });
      }
      data.privacyDefault = body.privacyDefault as Privacy;
    }
    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
    }

    const updated = await db.user.update({ where: { id: user.id }, data });
    return NextResponse.json({ timezone: updated.timezone, privacyDefault: updated.privacyDefault });
  } catch (err) {
    return errorResponse(err, "[PATCH /api/user]");
  }
}
