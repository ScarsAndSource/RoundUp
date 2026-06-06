// lib/telegram.ts
// All Telegram API calls go through here.
// FIX #5:  escapeHtml() applied to all user-controlled strings — prevents HTML injection
//          that causes Telegram to reject messages with parse_mode HTML.
// FIX #8:  403 Forbidden → chatId is nulled in DB so watcher list stays accurate.
// FIX #21: formatDuration clamps to 0 — no more "-1h -1m" from clock skew.

import { db } from "./db";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE = "https://api.telegram.org/bot";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://roundup.vercel.app";

// ── HTML sanitization ──────────────────────────────────────────────────
// MUST be applied to every user-controlled string embedded in Telegram HTML messages.
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Core sender ────────────────────────────────────────────────────────
export async function sendMessage(
  chatId: string,
  text: string,
  extra: Record<string, unknown> = {}
): Promise<boolean> {
  if (!TOKEN) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN not configured — message skipped");
    return false;
  }

  try {
    const res = await fetch(`${BASE}${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        ...extra,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[telegram] sendMessage failed (${res.status}) chatId=${chatId}:`, body);

      // FIX #8: 403 = bot blocked by user — invalidate the dead chatId in both tables.
      // This keeps watcher lists accurate and prevents future send attempts.
      if (res.status === 403) {
        await handleForbidden(chatId);
      }

      return false;
    }

    return true;
  } catch (err) {
    console.error("[telegram] sendMessage network error:", err);
    return false;
  }
}

// When a Telegram 403 arrives, the link between this chatId and our DB records is dead.
// Null out the field in both User and Friend so callers stop trying to send.
async function handleForbidden(chatId: string): Promise<void> {
  try {
    await Promise.allSettled([
      db.user.updateMany({
        where: { telegramChatId: chatId },
        data: { telegramChatId: null },
      }),
      db.friend.updateMany({
        where: { telegramChatId: chatId },
        data: { telegramChatId: null },
      }),
    ]);
    console.log(`[telegram] Cleared dead chatId (403) from DB: ${chatId}`);
  } catch (err) {
    console.error("[telegram] handleForbidden DB update failed:", err);
  }
}

// ── Formatting helpers ─────────────────────────────────────────────────

export function formatWakeTime(date: Date, timezone: string): string {
  try {
    return date.toLocaleTimeString("en-IN", {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    // Invalid timezone fallback
    return date.toLocaleTimeString("en-IN", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  }
}

// FIX #21: Clamp to 0 — clock skew between server and DB can produce negative ms.
export function formatDuration(startMs: number, endMs: number): string {
  const totalMin = Math.max(0, Math.round((endMs - startMs) / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

// ── Notification templates ─────────────────────────────────────────────
// All user-controlled strings MUST be wrapped in escapeHtml().

export async function notifyFriendSessionCreated({
  chatId,
  sleeperName,
  wakeTime,
  reason,
  privacyMode,
  watchToken,
}: {
  chatId: string;
  sleeperName: string;
  wakeTime: string;
  reason: string | null;
  privacyMode: string;
  watchToken: string;
}): Promise<void> {
  const safeName = escapeHtml(sleeperName);
  const safeTime = escapeHtml(wakeTime);
  const reasonLine =
    privacyMode === "OPEN" && reason
      ? `\n📌 Reason: <i>${escapeHtml(reason)}</i>`
      : "";
  const watchUrl = `${APP_URL}/watch/${watchToken}`;

  await sendMessage(
    chatId,
    `🌙 <b>${safeName}</b> is going to sleep.\n` +
    `⏰ Wake time: <b>${safeTime}</b>${reasonLine}\n\n` +
    `Open the watch page to commit:`,
    {
      reply_markup: {
        inline_keyboard: [[{ text: "📱 Open watch page", url: watchUrl }]],
      },
    }
  );
}

export async function notifyWatcherFirstConfirmed({
  chatId,
  sleeperName,
  watchToken,
}: {
  chatId: string;
  sleeperName: string;
  watchToken: string;
}): Promise<void> {
  const safeName = escapeHtml(sleeperName);
  const watchUrl = `${APP_URL}/watch/${watchToken}`;

  await sendMessage(
    chatId,
    `🟡 <b>${safeName}</b> tapped "I'm awake" — waiting for second confirmation.\n\n` +
    `Stay alert for 3 more minutes. They need to confirm again.\n${watchUrl}`
  );
}

export async function notifyWatcherRoundTwo({
  chatId,
  sleeperName,
  totalFriends,
  watchToken,
}: {
  chatId: string;
  sleeperName: string;
  totalFriends: number;
  watchToken: string;
}): Promise<void> {
  const safeName = escapeHtml(sleeperName);
  const watchUrl = `${APP_URL}/watch/${watchToken}`;

  // Individual framing — not a group broadcast
  await sendMessage(
    chatId,
    `🔴 <b>ROUND 2 — ${safeName} hasn't confirmed awake.</b>\n\n` +
    `You're one of ${totalFriends} person${totalFriends !== 1 ? "s" : ""} who can help. ` +
    `Please call them now.\n\n${watchUrl}`
  );
}

export async function notifyWatcherConfirmed({
  chatId,
  sleeperName,
}: {
  chatId: string;
  sleeperName: string;
}): Promise<void> {
  const safeName = escapeHtml(sleeperName);
  await sendMessage(
    chatId,
    `✅ <b>${safeName}</b> is confirmed awake. Session complete. Thanks for watching! 🎉`
  );
}

export async function sendDebrief({
  chatId,
  saverName,
  rounds,
  duration,
  totalSessions,
  totalSuccesses,
}: {
  chatId: string;
  saverName: string | null;
  rounds: number;
  duration: string;
  totalSessions: number;
  totalSuccesses: number;
}): Promise<void> {
  const savedLine = saverName
    ? `\n🌟 Saved by: <b>${escapeHtml(saverName)}</b>`
    : "";
  const rate =
    totalSessions > 0
      ? Math.round((totalSuccesses / totalSessions) * 100)
      : 0;

  await sendMessage(
    chatId,
    `☀️ <b>Wake-up debrief</b>\n\n` +
    `⏱ Sleep duration: <b>${escapeHtml(duration)}</b>\n` +
    `🔔 Rounds: <b>${rounds}</b>${savedLine}\n\n` +
    `📊 All-time: ${totalSuccesses}/${totalSessions} sessions (${rate}% success)\n\n` +
    `Open Roundup: ${APP_URL}`
  );
}

export async function sendFriendConversionPrompt({
  chatId,
  sleeperName,
}: {
  chatId: string;
  sleeperName: string;
}): Promise<void> {
  const safeName = escapeHtml(sleeperName);
  await sendMessage(
    chatId,
    `💡 Want your own crew watching your back — like you just watched ${safeName}'s?\n\n` +
    `Roundup is free. Build your crew in 2 minutes:\n${APP_URL}`
  );
}
