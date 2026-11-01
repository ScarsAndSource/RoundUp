// lib/cron.ts
// Alarm lifecycle engine — called by Vercel Cron every 2 minutes.
//
// CRITICAL FIX #1 (was: "Telegram sent before DB write — double notifications"):
//   DB write happens FIRST. Telegram sends after.
//   If Telegram fails, the session is already correctly marked — no re-fire on retry.
//
// FIX #10 (was: "Cron timeout — sequential Telegram calls in for loop"):
//   Telegram calls are parallelised with Promise.allSettled — never serial.
//
// FIX #19 (was: "SCHEDULED sessions never expire"):
//   expireStaleScheduled() marks sessions FAILED if wakeAt + 30min has passed.
//
// FIX #13 (was: "Missing index on roundTwoStartedAt / alarmFiredAt"):
//   Queries use indexed columns — schema.prisma has been updated accordingly.
//
// FIX #24 (was: "FIRST_CONFIRMED had no server-side timeout"):
//   checkSecondConfirms() escalates FIRST_CONFIRMED sessions to ROUND_TWO when the
//   second confirmation doesn't arrive within 3 minutes. Before this, a sleeper who
//   tapped "I'm Awake" once and fell back asleep was never escalated.
//
// FIX #25: fireAlarms() now only flips a session that is STILL "SCHEDULED". If the
//   sleeper already confirmed from their device (local ring) or cancelled between the
//   read and the write, the cron leaves it alone.

import type { Prisma } from "@prisma/client";
import { db } from "./db";
import {
  sendMessage,
  escapeHtml,
  formatWakeTime,
  notifyWatcherRoundTwo,
} from "./telegram";
import { claimEscalation } from "./redis";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://roundup.vercel.app";

// Cap per-step work to avoid Vercel's 10s timeout on cold starts
const MAX_PER_STEP = 10;

type SessionWithCrew = Prisma.SleepSessionGetPayload<{
  include: { user: true; tokens: { include: { friend: true } } };
}>;

// ── Main entry point ───────────────────────────────────────────────────

export async function runAlarmCycle(): Promise<{
  fired: number;
  secondTimeout: number;
  roundTwo: number;
  failed: number;
  expired: number;
  ts: string;
}> {
  const [firedR, secondR, roundTwoR, failedR, expiredR] = await Promise.allSettled([
    fireAlarms(),
    checkSecondConfirms(),
    checkFirstConfirms(),
    checkRoundTwo(),
    expireStaleScheduled(),
  ]);

  return {
    fired:         firedR.status    === "fulfilled" ? firedR.value    : 0,
    secondTimeout: secondR.status   === "fulfilled" ? secondR.value   : 0,
    roundTwo:      roundTwoR.status === "fulfilled" ? roundTwoR.value : 0,
    failed:        failedR.status   === "fulfilled" ? failedR.value   : 0,
    expired:       expiredR.status  === "fulfilled" ? expiredR.value  : 0,
    ts: new Date().toISOString(),
  };
}

// ── Step 1: Fire SCHEDULED alarms ─────────────────────────────────────

async function fireAlarms(): Promise<number> {
  const now = new Date();

  const sessions = await db.sleepSession.findMany({
    where: { status: "SCHEDULED", wakeAt: { lte: now } },
    include: { user: true, tokens: { include: { friend: true } } },
    take: MAX_PER_STEP,
    orderBy: { wakeAt: "asc" },
  });

  if (sessions.length === 0) return 0;

  // FIX #10: Process sessions in parallel — not sequential
  await Promise.allSettled(
    sessions.map(async (session) => {
      // Dedup guard: if two cron instances race, only one should fire
      const claimed = await claimEscalation(session.id, "ALARM_FIRED");
      if (!claimed) return;

      const delayMs = now.getTime() - session.wakeAt.getTime();
      const delayMin = Math.round(delayMs / 60000);

      // CRITICAL FIX #1: Write DB status FIRST.
      // FIX #25: guarded — only flips the row if it is still SCHEDULED.
      const { count } = await db.sleepSession.updateMany({
        where: { id: session.id, status: "SCHEDULED" },
        data: { status: "ALARM_FIRED", alarmFiredAt: now },
      });
      if (count === 0) return; // already confirmed / cancelled — nothing to fire

      try {
        await db.escalationEvent.create({
          data: { sessionId: session.id, type: "ALARM_FIRED", sentTo: [] },
        });
      } catch (err) {
        // Audit-log failure must never block the notifications below
        console.error("[cron] escalationEvent ALARM_FIRED failed:", err);
      }

      // THEN send Telegram — if this fails, DB is already correct, no re-fire
      const delayNote = delayMin >= 3 ? ` (${delayMin} min delayed)` : "";
      const confirmUrl = `${APP_URL}/session/${session.id}?token=${session.confirmToken}`;
      const sleeperName =
        session.privacyMode === "ANONYMOUS" ? "Someone" : session.user.name;

      const notifPromises: Promise<unknown>[] = [];

      // Notify the sleeper via Telegram
      if (session.user.telegramChatId) {
        const wakeStr = formatWakeTime(session.wakeAt, session.user.timezone);
        notifPromises.push(
          sendMessage(
            session.user.telegramChatId,
            `⏰ <b>Wake up!</b> It's ${escapeHtml(wakeStr)}${delayNote}\n\nTap to confirm you're awake:`,
            {
              reply_markup: {
                inline_keyboard: [[{ text: "✓ I'm Awake", url: confirmUrl }]],
              },
            }
          )
        );
      }

      // FIX #10: Notify all friends in parallel
      for (const wt of session.tokens) {
        if (!wt.friend.telegramChatId) continue;
        const watchUrl = `${APP_URL}/watch/${wt.token}`;
        const committedNote = wt.committed ? " You committed to watch." : "";
        notifPromises.push(
          sendMessage(
            wt.friend.telegramChatId,
            `🚨 <b>${escapeHtml(sleeperName)}'s alarm is ringing!</b>${committedNote}\n\n` +
            `Open their watch page:\n${watchUrl}`,
            {
              reply_markup: {
                inline_keyboard: [[{ text: "📱 Watch page", url: watchUrl }]],
              },
            }
          )
        );
      }

      await Promise.allSettled(notifPromises);
    })
  );

  return sessions.length;
}

// ── Step 2: FIRST_CONFIRMED + 3min with no second proof → Round 2 ─────
// FIX #24. The sleeper tapped "I'm Awake" but never completed the slider.
// The claim key includes confirmedAt so a later re-confirm → timeout cycle
// (user taps awake again from Round 2) is a NEW escalation, not a deduped one.
// roundTwoStartedAt is preserved if already set, so the original 8-minute
// Round 2 deadline is never extended by tapping "I'm Awake" repeatedly.

async function checkSecondConfirms(): Promise<number> {
  const cutoff = new Date(Date.now() - 3 * 60 * 1000);

  const sessions = await db.sleepSession.findMany({
    where: { status: "FIRST_CONFIRMED", confirmedAt: { lte: cutoff } },
    include: { user: true, tokens: { include: { friend: true } } },
    take: MAX_PER_STEP,
    orderBy: { confirmedAt: "asc" },
  });

  if (sessions.length === 0) return 0;

  await Promise.allSettled(
    sessions.map(async (session: SessionWithCrew) => {
      if (!session.confirmedAt) return;

      const claimed = await claimEscalation(
        session.id,
        `SECOND_TIMEOUT:${session.confirmedAt.getTime()}`
      );
      if (!claimed) return;

      // DB first, guarded — if the sleeper completed the second proof (CONFIRMED)
      // or cancelled in the meantime, count is 0 and we do nothing.
      const { count } = await db.sleepSession.updateMany({
        where: { id: session.id, status: "FIRST_CONFIRMED" },
        data: {
          status: "ROUND_TWO",
          roundsEscalated: { increment: 1 },
          roundTwoStartedAt: session.roundTwoStartedAt ?? new Date(),
        },
      });
      if (count === 0) return;

      try {
        await db.escalationEvent.create({
          data: { sessionId: session.id, type: "ROUND_TWO", sentTo: [] },
        });
      } catch (err) {
        console.error("[cron] escalationEvent ROUND_TWO (second timeout) failed:", err);
      }

      const sleeperName =
        session.privacyMode === "ANONYMOUS" ? "Someone" : session.user.name;
      const totalFriends = session.tokens.length;
      const confirmUrl = `${APP_URL}/session/${session.id}?token=${session.confirmToken}`;
      const notifPromises: Promise<unknown>[] = [];

      if (session.user.telegramChatId) {
        notifPromises.push(
          sendMessage(
            session.user.telegramChatId,
            `🚨 <b>Round 2!</b> You tapped awake but never finished the second check. Your entire crew has been called.\n\nTap to confirm again:`,
            {
              reply_markup: {
                inline_keyboard: [[{ text: "✓ I'm Awake", url: confirmUrl }]],
              },
            }
          )
        );
      }

      for (const wt of session.tokens) {
        if (!wt.friend.telegramChatId) continue;
        notifPromises.push(
          notifyWatcherRoundTwo({
            chatId: wt.friend.telegramChatId,
            sleeperName,
            totalFriends,
            watchToken: wt.token,
          })
        );
      }

      await Promise.allSettled(notifPromises);
    })
  );

  return sessions.length;
}

// ── Step 3: ALARM_FIRED + 5min → Round 2 ─────────────────────────────

async function checkFirstConfirms(): Promise<number> {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000);

  // FIX #13: alarmFiredAt is now indexed — query is efficient
  const sessions = await db.sleepSession.findMany({
    where: { status: "ALARM_FIRED", alarmFiredAt: { lte: cutoff } },
    include: { user: true, tokens: { include: { friend: true } } },
    take: MAX_PER_STEP,
  });

  if (sessions.length === 0) return 0;

  await Promise.allSettled(
    sessions.map(async (session) => {
      const claimed = await claimEscalation(session.id, "ROUND_TWO");
      if (!claimed) return;

      // DB first
      await db.$transaction([
        db.sleepSession.update({
          where: { id: session.id },
          data: {
            status: "ROUND_TWO",
            roundsEscalated: { increment: 1 },
            roundTwoStartedAt: new Date(),
          },
        }),
        db.escalationEvent.create({
          data: { sessionId: session.id, type: "ROUND_TWO", sentTo: [] },
        }),
      ]);

      const sleeperName =
        session.privacyMode === "ANONYMOUS" ? "Someone" : session.user.name;
      const totalFriends = session.tokens.length;
      const confirmUrl = `${APP_URL}/session/${session.id}?token=${session.confirmToken}`;
      const notifPromises: Promise<unknown>[] = [];

      // Notify sleeper
      if (session.user.telegramChatId) {
        notifPromises.push(
          sendMessage(
            session.user.telegramChatId,
            `🚨 <b>Round 2!</b> You still haven't confirmed awake. Your entire crew has been called.\n\nTap to confirm now:`,
            {
              reply_markup: {
                inline_keyboard: [[{ text: "✓ I'm Awake", url: confirmUrl }]],
              },
            }
          )
        );
      }

      // Notify all friends — individually framed, not broadcast
      for (const wt of session.tokens) {
        if (!wt.friend.telegramChatId) continue;
        notifPromises.push(
          notifyWatcherRoundTwo({
            chatId: wt.friend.telegramChatId,
            sleeperName,
            totalFriends,
            watchToken: wt.token,
          })
        );
      }

      await Promise.allSettled(notifPromises);
    })
  );

  return sessions.length;
}

// ── Step 4: ROUND_TWO + 8min → FAILED ────────────────────────────────

async function checkRoundTwo(): Promise<number> {
  const cutoff = new Date(Date.now() - 8 * 60 * 1000);

  // FIX #13: roundTwoStartedAt is now indexed
  const sessions = await db.sleepSession.findMany({
    where: { status: "ROUND_TWO", roundTwoStartedAt: { lte: cutoff } },
    include: { user: true, tokens: { include: { friend: true } } },
    take: MAX_PER_STEP,
  });

  if (sessions.length === 0) return 0;

  await Promise.allSettled(
    sessions.map(async (session) => {
      const claimed = await claimEscalation(session.id, "FAILED");
      if (!claimed) return;

      // DB first
      await db.$transaction([
        db.sleepSession.update({
          where: { id: session.id },
          data: { status: "FAILED", sessionEndedAt: new Date() },
        }),
        db.escalationEvent.create({
          data: { sessionId: session.id, type: "FAILED", sentTo: [] },
        }),
      ]);

      const sleeperName =
        session.privacyMode === "ANONYMOUS" ? "Someone" : session.user.name;
      const notifPromises: Promise<unknown>[] = [];

      if (session.user.telegramChatId) {
        notifPromises.push(
          sendMessage(
            session.user.telegramChatId,
            `❌ Session ended — Roundup tried everything.\n\n` +
            `Your crew was notified but you didn't confirm awake. Session closed.\n\n` +
            `Open the app: ${APP_URL}`
          )
        );
      }

      for (const wt of session.tokens) {
        if (!wt.friend.telegramChatId) continue;
        notifPromises.push(
          sendMessage(
            wt.friend.telegramChatId,
            `⏱ Session ended — <b>${escapeHtml(sleeperName)}</b> didn't confirm after Round 2. All clear.`
          )
        );
      }

      await Promise.allSettled(notifPromises);
    })
  );

  return sessions.length;
}

// ── Step 5: Expire stale SCHEDULED sessions ────────────────────────────
// FIX #19: Sessions whose wakeAt + 30min has passed but cron never fired them
// (e.g. cron was down for a while) are marked FAILED with a note to the sleeper.

async function expireStaleScheduled(): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000);

  const sessions = await db.sleepSession.findMany({
    where: { status: "SCHEDULED", wakeAt: { lte: cutoff } },
    include: { user: true },
    take: MAX_PER_STEP,
  });

  if (sessions.length === 0) return 0;

  await Promise.allSettled(
    sessions.map(async (session) => {
      const claimed = await claimEscalation(session.id, "EXPIRED");
      if (!claimed) return;

      await db.sleepSession.update({
        where: { id: session.id },
        data: { status: "FAILED", sessionEndedAt: new Date() },
      });

      if (session.user.telegramChatId) {
        const wakeStr = formatWakeTime(session.wakeAt, session.user.timezone);
        await sendMessage(
          session.user.telegramChatId,
          `⚠️ Roundup missed your alarm at <b>${escapeHtml(wakeStr)}</b>.\n\n` +
          `This can happen during heavy server load. We're sorry. ` +
          `The session has been closed.\n\nOpen the app to start a new one: ${APP_URL}`
        );
      }
    })
  );

  return sessions.length;
}
