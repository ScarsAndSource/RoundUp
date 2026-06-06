// lib/env.ts
// FIX #18: Validates required environment variables at startup.
// Throws a descriptive error at module import time — no more cryptic runtime crashes.
// Import at the top of lib/db.ts and lib/supabase.ts.

const REQUIRED: Record<string, string> = {
  DATABASE_URL: "PostgreSQL connection URL (Supabase → Settings → Database)",
  NEXT_PUBLIC_SUPABASE_URL: "Supabase project URL (Settings → API)",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "Supabase anon key (Settings → API)",
};

const OPTIONAL: Record<string, string> = {
  DIRECT_URL: "Prisma direct URL — required for migrations",
  TELEGRAM_BOT_TOKEN: "Telegram bot token — Telegram notifications disabled without it",
  TELEGRAM_WEBHOOK_SECRET: "Telegram webhook secret — webhook authentication disabled without it",
  UPSTASH_REDIS_REST_URL: "Upstash Redis URL — rate limiting and dedup disabled without it",
  UPSTASH_REDIS_REST_TOKEN: "Upstash Redis token",
  CRON_SECRET: "Cron endpoint auth secret — cron endpoint is unprotected without it",
  NEXT_PUBLIC_APP_URL: "App base URL — defaults to https://roundup.vercel.app",
};

let validated = false;

export function validateEnv(): void {
  if (validated) return;
  validated = true;

  const missing: string[] = [];
  for (const [key, desc] of Object.entries(REQUIRED)) {
    if (!process.env[key]) {
      missing.push(`  ${key} — ${desc}`);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `[Roundup] Missing required environment variables:\n${missing.join("\n")}\n\n` +
      `Copy .env.local.example to .env.local and fill in all required values.\n` +
      `See: https://github.com/your-repo/roundup#setup`
    );
  }

  // Warn about optional vars in dev
  if (process.env.NODE_ENV !== "production") {
    for (const [key, desc] of Object.entries(OPTIONAL)) {
      if (!process.env[key]) {
        console.warn(`[Roundup] Optional env var not set: ${key} — ${desc}`);
      }
    }
  }
}
