// middleware.ts
// FIX #3: Added /session (Telegram confirm deep-link) and /api/sessions
//         to PUBLIC_ROUTES so unauthenticated users can land on the confirm
//         page from a Telegram "I'm Awake" button without hitting a login wall.
//         Individual API routes still enforce their own token/auth checks.

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Routes that skip Supabase auth middleware.
// Each route still handles its own authentication:
//   /session      — confirmToken in URL params
//   /watch        — watcherToken in URL params
//   /api/sessions — confirm routes use confirmToken; create/list use getOrCreateUser()
//   /api/watch    — watcherToken authenticated
//   /api/telegram — secret header authenticated
//   /api/cron     — Bearer token authenticated
//   /api/health   — public
const PUBLIC_ROUTES = [
  "/login",
  "/signup",
  "/session",         // FIX #3: Telegram deep-link confirm page — token authenticated
  "/watch",           // Watcher page — token authenticated
  "/api/sessions",    // FIX #3: Confirm endpoints use confirmToken, not Supabase session
  "/api/watch",       // Watcher API — token authenticated
  "/api/telegram",    // Telegram webhook — X-Telegram-Bot-Api-Secret-Token authenticated
  "/api/cron",        // Cron — Bearer CRON_SECRET authenticated
  "/api/health",      // Health check — public
];

function isPublic(pathname: string): boolean {
  return PUBLIC_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(route + "/")
  );
}

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({
    request: { headers: request.headers },
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return request.cookies.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          request.cookies.set({ name, value, ...options });
          response = NextResponse.next({ request: { headers: request.headers } });
          response.cookies.set({ name, value, ...options });
        },
        remove(name: string, options: CookieOptions) {
          request.cookies.set({ name, value: "", ...options });
          response = NextResponse.next({ request: { headers: request.headers } });
          response.cookies.set({ name, value: "", ...options });
        },
      },
    }
  );

  // Refresh session token on every request (extends TTL automatically)
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  if (!user && !isPublic(pathname)) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (user && (pathname === "/login" || pathname === "/signup")) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sounds/|sw.js|icons/).*)",
  ],
};
