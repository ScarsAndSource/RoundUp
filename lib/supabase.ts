// lib/supabase.ts
// Supabase client factories for server and browser contexts.
// FIX #17: ServiceUnavailableError distinguishes infra outage from auth failure.
// FIX #18: validateEnv() called at module load — fails fast with clear message.

import { createServerClient, createBrowserClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { validateEnv } from "./env";
import { db } from "./db";

validateEnv();

// ── Custom error types ─────────────────────────────────────────────────

export class ServiceUnavailableError extends Error {
  constructor(message = "Auth service temporarily unavailable — please retry") {
    super(message);
    this.name = "ServiceUnavailableError";
  }
}

// ── Browser client (for client components) ────────────────────────────

export function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

// ── Server client (for API routes and Server Components) ─────────────

export function createSupabaseServerClient() {
  const cookieStore = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value, ...options });
          } catch {
            // Route handler or Server Component — read-only context, safe to ignore
          }
        },
        remove(name: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value: "", ...options });
          } catch {}
        },
      },
    }
  );
}

// ── Auth helper — get or create DB user from session ─────────────────

export async function getOrCreateUser() {
  const supabase = createSupabaseServerClient();

  let authUser: Awaited<ReturnType<typeof supabase.auth.getUser>>["data"]["user"];
  try {
    const { data, error } = await supabase.auth.getUser();

    if (error) {
      const msg = error.message ?? "";
      // FIX #17: Network-level Supabase failures → 503, not 500
      if (
        msg.includes("ECONNREFUSED") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("fetch failed") ||
        msg.includes("network") ||
        msg.includes("connect")
      ) {
        throw new ServiceUnavailableError();
      }
      throw new Error("Unauthorized");
    }

    authUser = data.user;
  } catch (err) {
    if (err instanceof ServiceUnavailableError) throw err;
    throw new Error("Unauthorized");
  }

  if (!authUser) throw new Error("Unauthorized");

  // Find existing user or create on first sign-in
  let user = await db.user.findUnique({ where: { supabaseId: authUser.id } });

  if (!user) {
    const email = authUser.email ?? "";
    const name: string =
      (authUser.user_metadata?.full_name as string | undefined) ??
      (authUser.user_metadata?.name as string | undefined) ??
      email.split("@")[0] ??
      "Roundup User";

    user = await db.user.create({
      data: {
        supabaseId: authUser.id,
        email,
        name,
      },
    });
  }

  return user;
}
