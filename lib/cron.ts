// lib/cron.ts
// Alarm lifecycle engine — called by a scheduler (Vercel Cron / cron-job.org) every 2 minutes.
//
// Rules every step follows:
//  1. DB write FIRST, Telegram after. If Telegram fails the session is already correct.
//  2. Every status change is a GUARDED updateMany ("only if the row is still in the state I
//     read"). If the sleeper confirmed / cancelled / a friend marked them awake in the
//     meantime, count is 0 and the cron does nothing — it can never overwrite a newer state
//     or send a stale "call them now". This also makes duplicate cron runs safe WITHOUT Redis.
//  3. Redis claims are only a cheap extra dedup. If the work throws, the claim is released
//     so the next run can retry (before: one DB blip locked a session out for an hour).
//  4. Telegram calls are parallel (Promise.allSettled), never a serial loop.
//
// Steps:
//   fireAlarms         SCHEDULED, wakeAt reached (but < 30 min ago)  → ALARM_FIRED
//   checkSecondConfirms FIRST_CONFIRMED, no 2nd proof after 3 min    → ROUND_TWO
//   checkFirstConfirms ALARM_FIRED, no confirm after 5 min           → ROUND_TWO
//   checkRoundTwo      ROUND_TWO for 8 min                           → FAILED
//   expireStaleScheduled SCHEDULED, wakeAt > 30 min ago (cron down)  → FAILED

import type { Prisma } from "@prisma/client";
import { db } from "./db";
import {
  sendMessage,
  escapeHtml,
  formatWakeTime,
  notifyWatcherRoundTwo,
} from "./telegram";
import { claimEscalation, releaseEscalation } from "./redis";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://roundup.vercel.app";

// Per step, per run. Everything inside a step runs in parallel, so 50 sessions is a few
// seconds of Telegram calls. Anything beyond 50 is picked up by the next run.
const MAX_PER_STEP = 50;

// A SCHEDULED session whose wake time is older than this is expired, not fired.
const STALE_MS = 30 * 60 * 1000;

type SessionWithCrew = Prisma.SleepSessionGetPayload<{
  include: { user: true; tokens: { include: { friend: true } } };
}>;

// ── helpers ────────────────────────────────────────────────────────────

async function withClaim(
  sessionId: string,
  step: string,
  work: () => Promise<void>
): Promise<void> {
  const claimed = await claimEscalation(sessionId, step);
  if (!claimed) return;
  try {
    await work();
  } catch (err) {
    await releaseEscalation(sessionId, step);
    throw err;
  }
}

async function logEvent(
  sessionId: string,
  type: "ALARM_FIRED" | "ROUND_TWO" | "FAILED"
): Promise<void> {
  try {
    await db.escalationEvent.create({ data: { sessionId, type, sentTo: [] } });
  } catch (err) {
    // The audit log must never block notifications
    console.error(`[cron] escalationEvent ${type} failed:`, err);
  }
}

function logFailures(step: string, results: PromiseSettledResult<unknown>[]): void {
  for (const r of results) {
    if (r.status === "rejected") console.error(`[cron] ${step} failed:`, r.reason);
  }
}

function displayName(session: SessionWithCrew): string {
  return session.privacyMode === "ANONYMOUS" ? "Someone" : session.user.name;
}

async function sendRoundTwoNotices(
  session: SessionWithCrew,
  sleeperText: string
): Promise<void> {
  const confirmUrl = `${APP_URL}/session/${session.id}?token=${session.confirmToken}`;
  const notifPromises: Promise<unknown>[] = [];

  if (session.user.telegramChatId) {
    notifPromises.push(
      sendMessage(session.user.telegramChatId, sleeperText, {
        reply_markup: {
          inline_keyboard: [[{ text: "✓ I'm Awake", url: confirmUrl }]],
        },
      })
    );
  }

  // Individually framed, not a group broadcast
  for (const wt of session.tokens) {
    if (!wt.friend.telegramChatId) continue;
    notifPromises.push(
      notifyWatcherRoundTwo({
        chatId: wt.friend.telegramChatId,
        sleeperName: displayName(session),
        totalFriends: session.tokens.length,
        watchToken: wt.token,
      })
    );
  }

  await Promise.allSettled(notifPromises);
}

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

  logFailures("cycle", [firedR, secondR, roundTwoR, failedR, expiredR]);

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
    where: {
      status: "SCHEDULED",
      // Only recent wake times: anything older than STALE_MS belongs to expireStaleScheduled,
      // otherwise both steps grab the same session after a cron outage.
      wakeAt: { lte: now, gt: new Date(now.getTime() - STALE_MS) },
    },
    include: { user: true, tokens: { include: { friend: true } } },
    take: MAX_PER_STEP,
    orderBy: { wakeAt: "asc" },
  });

  if (sessions.length === 0) return 0;

  const results = await Promise.allSettled(
    sessions.map((session) =>
      withClaim(session.id, "ALARM_FIRED", async () => {
        const delayMin = Math.round((now.getTime() - session.wakeAt.getTime()) / 60000);

        const { count } = await db.sleepSession.updateMany({
          where: { id: session.id, status: "SCHEDULED" },
          data: { status: "ALARM_FIRED", alarmFiredAt: now },
        });
        if (count === 0) return; // sleeper already confirmed on-device, or cancelled

        await logEvent(session.id, "ALARM_FIRED");

        const delayNote = delayMin >= 3 ? ` (${delayMin} min delayed)` : "";
        const confirmUrl = `${APP_URL}/session/${session.id}?token=${session.confirmToken}`;
        const notifPromises: Promise<unknown>[] = [];

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

        for (const wt of session.tokens) {
          if (!wt.friend.telegramChatId) continue;
          const watchUrl = `${APP_URL}/watch/${wt.token}`;
          const committedNote = wt.committed ? " You committed to watch." : "";
          notifPromises.push(
            sendMessage(
              wt.friend.telegramChatId,
              `🚨 <b>${escapeHtml(displayName(session))}'s alarm is ringing!</b>${committedNote}\n\n` +
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
    )
  );
  logFailures("fireAlarms", results);

  return sessions.length;
}

// ── Step 2: FIRST_CONFIRMED + 3 min with no second proof → Round 2 ─────
// The sleeper tapped "I'm Awake" but never finished the slider. The claim key includes
// confirmedAt, so a later re-confirm → timeout cycle is a NEW escalation. roundTwoStartedAt
// is preserved if already set, so tapping "I'm Awake" repeatedly never extends the
// original 8-minute Round 2 deadline.

async function checkSecondConfirms(): Promise<number> {
  const cutoff = new Date(Date.now() - 3 * 60 * 1000);

  const sessions = await db.sleepSession.findMany({
    where: { status: "FIRST_CONFIRMED", confirmedAt: { lte: cutoff } },
    include: { user: true, tokens: { include: { friend: true } } },
    take: MAX_PER_STEP,
    orderBy: { confirmedAt: "asc" },
  });

  if (sessions.length === 0) return 0;

  const results = await Promise.allSettled(
    sessions.map((session) => {
      if (!session.confirmedAt) return Promise.resolve();
      return withClaim(
        session.id,
        `SECOND_TIMEOUT:${session.confirmedAt.getTime()}`,
        async () => {
          const { count } = await db.sleepSession.updateMany({
            where: { id: session.id, status: "FIRST_CONFIRMED" },
            data: {
              status: "ROUND_TWO",
              roundsEscalated: { increment: 1 },
              roundTwoStartedAt: session.roundTwoStartedAt ?? new Date(),
            },
          });
          if (count === 0) return; // finished the second proof / cancelled in time

          await logEvent(session.id, "ROUND_TWO");
          await sendRoundTwoNotices(
            session,
            `🚨 <b>Round 2!</b> You tapped awake but never finished the second check. Your entire crew has been called.\n\nTap to confirm again:`
          );
        }
      );
    })
  );
  logFailures("checkSecondConfirms", results);

  return sessions.length;
}

// ── Step 3: ALARM_FIRED + 5 min → Round 2 ─────────────────────────────

async function checkFirstConfirms(): Promise<number> {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000);

  const sessions = await db.sleepSession.findMany({
    where: { status: "ALARM_FIRED", alarmFiredAt: { lte: cutoff } },
    include: { user: true, tokens: { include: { friend: true } } },
    take: MAX_PER_STEP,
  });

  if (sessions.length === 0) return 0;

  const results = await Promise.allSettled(
    sessions.map((session) =>
      withClaim(session.id, "ROUND_TWO", async () => {
        const { count } = await db.sleepSession.updateMany({
          where: { id: session.id, status: "ALARM_FIRED" },
          data: {
            status: "ROUND_TWO",
            roundsEscalated: { increment: 1 },
            roundTwoStartedAt: new Date(),
          },
        });
        if (count === 0) return; // sleeper tapped awake / cancelled / friend marked awake

        await logEvent(session.id, "ROUND_TWO");
        await sendRoundTwoNotices(
          session,
          `🚨 <b>Round 2!</b> You still haven't confirmed awake. Your entire crew has been called.\n\nTap to confirm now:`
        );
      })
    )
  );
  logFailures("checkFirstConfirms", results);

  return sessions.length;
}

// ── Step 4: ROUND_TWO + 8 min → FAILED ────────────────────────────────

async function checkRoundTwo(): Promise<number> {
  const cutoff = new Date(Date.now() - 8 * 60 * 1000);

  const sessions = await db.sleepSession.findMany({
    where: { status: "ROUND_TWO", roundTwoStartedAt: { lte: cutoff } },
    include: { user: true, tokens: { include: { friend: true } } },
    take: MAX_PER_STEP,
  });

  if (sessions.length === 0) return 0;

  const results = await Promise.allSettled(
    sessions.map((session) =>
      withClaim(session.id, "FAILED", async () => {
        const { count } = await db.sleepSession.updateMany({
          where: { id: session.id, status: "ROUND_TWO" },
          data: { status: "FAILED", sessionEndedAt: new Date() },
        });
        if (count === 0) return; // a friend / the sleeper got there first — never overwrite CONFIRMED

        await logEvent(session.id, "FAILED");

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
              `⏱ Session ended — <b>${escapeHtml(displayName(session))}</b> didn't confirm after Round 2. All clear.`
            )
          );
        }

        await Promise.allSettled(notifPromises);
      })
    )
  );
  logFailures("checkRoundTwo", results);

  return sessions.length;
}

// ── Step 5: Expire stale SCHEDULED sessions ────────────────────────────
// Wake time passed more than 30 minutes ago and nothing fired it (cron was down).
// Firing an alarm that late would be worse than useless, so tell the sleeper and close it.

async function expireStaleScheduled(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_MS);

  const sessions = await db.sleepSession.findMany({
    where: { status: "SCHEDULED", wakeAt: { lte: cutoff } },
    include: { user: true },
    take: MAX_PER_STEP,
  });

  if (sessions.length === 0) return 0;

  const results = await Promise.allSettled(
    sessions.map((session) =>
      withClaim(session.id, "EXPIRED", async () => {
        const { count } = await db.sleepSession.updateMany({
          where: { id: session.id, status: "SCHEDULED" },
          data: { status: "FAILED", sessionEndedAt: new Date() },
        });
        if (count === 0) return;

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
    )
  );
  logFailures("expireStaleScheduled", results);

  return sessions.length;
}
