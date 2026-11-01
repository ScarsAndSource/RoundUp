// scripts/set-webhook.mjs
// Registers (or re-registers) the Telegram webhook for this app.
//
// Usage:   npm run telegram:webhook
// Re-run whenever your deployed URL (NEXT_PUBLIC_APP_URL) or TELEGRAM_WEBHOOK_SECRET changes.
// Telegram only calls https URLs, so for local dev you need a tunnel (e.g. ngrok) and
// NEXT_PUBLIC_APP_URL set to the tunnel's https URL.

import { readFileSync, existsSync } from "node:fs";

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (
      v.length >= 2 &&
      ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
    ) {
      v = v.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

loadEnv(".env.local");
loadEnv(".env");

function fail(msg) {
  console.error("✗ " + msg);
  process.exit(1);
}

const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/+$/, "");

if (!token) fail("TELEGRAM_BOT_TOKEN is not set (.env.local).");
if (!secret) fail("TELEGRAM_WEBHOOK_SECRET is not set (.env.local).");
if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
  fail("TELEGRAM_WEBHOOK_SECRET may only contain A-Z a-z 0-9 _ - (1-256 chars).");
}
if (!/^https:\/\//.test(appUrl)) {
  fail(
    `NEXT_PUBLIC_APP_URL must be your public https URL (got "${appUrl || "empty"}"). ` +
      "Telegram only delivers to https."
  );
}

const url = `${appUrl}/api/telegram/webhook`;
const api = (method) => `https://api.telegram.org/bot${token}/${method}`;

const setRes = await fetch(api("setWebhook"), {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url,
    secret_token: secret,
    allowed_updates: ["message", "edited_message"],
  }),
});
const setOut = await setRes.json();
if (!setOut.ok) fail(`setWebhook failed: ${setOut.description ?? JSON.stringify(setOut)}`);
console.log(`✓ Webhook set → ${url}`);

const infoRes = await fetch(api("getWebhookInfo"));
const info = (await infoRes.json()).result ?? {};
console.log(`  pending updates : ${info.pending_update_count ?? 0}`);
if (info.last_error_message) {
  console.log(`  last error      : ${info.last_error_message}`);
}
