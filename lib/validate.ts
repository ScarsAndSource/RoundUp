// lib/validate.ts
// Small shared input validators for API routes.

/** True only for real IANA timezone names ("Asia/Kolkata", "America/New_York", "UTC"…). */
export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
