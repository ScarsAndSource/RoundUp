// app/api/telegram/webhook/route.ts
// FIX #19: Added /cancel command — user can cancel active session from Telegram
//          when the app is closed. Fixes ghost-session problem.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sendMessage } from "@/lib/telegram";

const APP = process.env.NEXT_PUBLIC_APP_URL ?? "https://roundup.vercel.app";

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-telegram-bot-api-secret-token");
  if (secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return new NextResponse(null, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  const msg = (body.message ?? body.edited_message) as {
    text?: string;
    chat?: { id: number };
    from?: { username?: string; first_name?: string };
  } | undefined;

  if (!msg?.text || !msg.chat) {
    return NextResponse.json({ ok: true });
  }

  const chatId = String(msg.chat.id);
  const text: string = msg.text;
  const username: string | undefined = msg.from?.username;
  const firstName: string | undefined = msg.from?.first_name;

  try {
    // ── /start {payload} ────────────────────────────────────────────
    if (text.startsWith("/start")) {
      const payload = text.split(" ")[1];

      if (!payload) {
        await sendMessage(
          chatId,
          `👋 Welcome to Roundup!\n\nOpen the app to sign in and link your account:\n${APP}`
        );
        return NextResponse.json({ ok: true });
      }

      // Sleeper linking: /start user_{supabaseId}
      if (payload.startsWith("user_")) {
        const supabaseId = payload.replace("user_", "");
        const user = await db.user.findUnique({ where: { supabaseId } });

        if (!user) {
          await sendMessage(
            chatId,
            "❌ Account not found. Make sure you're signed in to Roundup first."
          );
          return NextResponse.json({ ok: true });
        }

        await db.user.update({
          where: { supabaseId },
          data: { telegramChatId: chatId, telegramUsername: username ?? null },
        });

        await sendMessage(
          chatId,
          `✅ Linked! Hi ${user.name} 👋\n\nYou'll receive alarm alerts and wake confirmations here.\n\nCommands:\n/status — check your active session\n/cancel — cancel your active session`
        );
        return NextResponse.json({ ok: true });
      }

      // Friend linking: /start friend_{linkToken}
      if (payload.startsWith("friend_")) {
        const linkToken = payload.replace("friend_", "");
        const friend = await db.friend.findUnique({ where: { linkToken } });

        if (!friend) {
          await sendMessage(
            chatId,
            "❌ Invite link expired or invalid. Ask your friend to send a new one."
          );
          return NextResponse.json({ ok: true });
        }

        await db.friend.update({
          where: { linkToken },
          data: {
            telegramChatId: chatId,
            telegramUsername: username ?? null,
            linkedAt: new Date(),
          },
        });

        await sendMessage(
          chatId,
          `✅ You're on the crew, ${firstName ?? "friend"}!\n\nYou'll get a message when your friend is going to sleep and needs waking up.\n\nNo app install needed — everything works right here in Telegram.`
        );
        return NextResponse.json({ ok: true });
      }
    }

    // ── /status ──────────────────────────────────────────────────────
    if (text === "/status") {
      const user = await db.user.findUnique({ where: { telegramChatId: chatId } });

      if (!user) {
        await sendMessage(
          chatId,
          "You're set up as a watcher. You'll get a message when your friend needs waking up.\n\nWant your own crew? " + APP
        );
        return NextResponse.json({ ok: true });
      }

      const active = await db.sleepSession.findFirst({
        where: {
          userId: user.id,
          status: { notIn: ["CONFIRMED", "FAILED", "CANCELLED"] },
        },
        orderBy: { createdAt: "desc" },
      });

      if (!active) {
        await sendMessage(chatId, "No active session. Sleep well 😴");
      } else {
        const wakeStr = active.wakeAt.toLocaleTimeString("en-IN", {
          timeZone: user.timezone,
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });
        await sendMessage(
          chatId,
          `Active session:\nStatus: ${active.status}\nAlarm: ${wakeStr}\n\nUse /cancel to cancel this session.`
        );
      }
      return NextResponse.json({ ok: true });
    }

    // ── /cancel ─────────────────────────────────────────────────────
    // FIX #19: Ghost-session fix — user can cancel from Telegram if app is closed.
    if (text === "/cancel") {
      const user = await db.user.findUnique({ where: { telegramChatId: chatId } });

      if (!user) {
        await sendMessage(chatId, "You don't have an account linked. Open the app: " + APP);
        return NextResponse.json({ ok: true });
      }

      const active = await db.sleepSession.findFirst({
        where: {
          userId: user.id,
          status: { notIn: ["CONFIRMED", "FAILED", "CANCELLED"] },
        },
        orderBy: { createdAt: "desc" },
        include: { tokens: { include: { friend: true } } },
      });

      if (!active) {
        await sendMessage(chatId, "No active session to cancel. Sleep well 😴");
        return NextResponse.json({ ok: true });
      }

      await db.sleepSession.update({
        where: { id: active.id },
        data: { status: "CANCELLED", sessionEndedAt: new Date() },
      });

      // Notify watchers the session was cancelled
      await Promise.allSettled(
        active.tokens
          .filter((wt) => wt.friend.telegramChatId)
          .map((wt) =>
            sendMessage(
              wt.friend.telegramChatId!,
              `ℹ️ ${active.privacyMode === "ANONYMOUS" ? "Someone" : user.name} has cancelled their wake session. All clear!`
            )
          )
      );

      const wakeStr = active.wakeAt.toLocaleTimeString("en-IN", {
        timeZone: user.timezone,
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
      await sendMessage(
        chatId,
        `✅ Session cancelled (was set for ${wakeStr}). Your crew has been notified. Sleep well!`
      );
      return NextResponse.json({ ok: true });
    }

    // ── /help ──────────────────────────────────────────────────────
    if (text === "/help") {
      await sendMessage(
        chatId,
        `🌙 <b>Roundup Bot</b>\n\n` +
        `/status — check your active session\n` +
        `/cancel — cancel your active session\n` +
        `/help — show this message\n\n` +
        `Open the app: ${APP}`
      );
    }
  } catch (err) {
    console.error("[telegram/webhook]", err);
  }

  return NextResponse.json({ ok: true });
}
