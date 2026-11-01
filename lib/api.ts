// lib/api.ts
// Frontend API client. Every fetch call goes through apiFetch().
// FIX #12: NetworkError distinguishes connectivity loss from server errors.
//          Components can show a "retry" prompt instead of a generic error toast.

import type {
  CreateSessionRequest,
  CreateSessionResponse,
  CreateFriendRequest,
  FriendPublic,
  SessionStatusResponse,
  SessionHistoryItem,
  UserProfile,
  HealthStatus,
} from "@/types";

// ── Error types ────────────────────────────────────────────────────────

export class NetworkError extends Error {
  constructor(message = "No connection. Check your internet and try again.") {
    super(message);
    this.name = "NetworkError";
  }
}

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ── Core fetcher ───────────────────────────────────────────────────────

async function apiFetch<T = unknown>(
  url: string,
  options?: RequestInit
): Promise<T> {
  let res: Response;

  try {
    res = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
  } catch (err) {
    // TypeError: Failed to fetch = network unavailable
    if (err instanceof TypeError) throw new NetworkError();
    throw err;
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) message = String(body.error);
    } catch {}
    throw new ApiError(res.status, message);
  }

  return res.json() as Promise<T>;
}

// ── Session APIs ───────────────────────────────────────────────────────

export function createSession(
  data: CreateSessionRequest
): Promise<CreateSessionResponse> {
  return apiFetch("/api/sessions", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function cancelSession(sessionId: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/sessions/${sessionId}/cancel`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function getSessionStatus(
  sessionId: string
): Promise<SessionStatusResponse> {
  return apiFetch(`/api/sessions/${sessionId}/status`);
}

export function confirmAwake(
  sessionId: string,
  token: string
): Promise<{ ok: boolean; status: string; error?: string }> {
  return apiFetch(`/api/sessions/${sessionId}/confirm`, {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

export function confirmSecondAwake(
  sessionId: string,
  token: string
): Promise<{ ok: boolean; status: string; saverName: string | null; duration: string }> {
  return apiFetch(`/api/sessions/${sessionId}/confirm-second`, {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

export function getSessions(
  limit = 20,
  cursor?: string
): Promise<{ sessions: SessionHistoryItem[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  return apiFetch(`/api/sessions?${params}`);
}

// ── Friends APIs ───────────────────────────────────────────────────────

export function getFriends(): Promise<{ friends: FriendPublic[] }> {
  return apiFetch("/api/friends");
}

export function createFriend(
  data: CreateFriendRequest
): Promise<{ friend: FriendPublic; inviteLink: string }> {
  return apiFetch("/api/friends", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function deleteFriend(friendId: string): Promise<{ ok: boolean }> {
  return apiFetch("/api/friends", {
    method: "DELETE",
    body: JSON.stringify({ friendId }),
  });
}

// ── User APIs ──────────────────────────────────────────────────────────

export function getUserProfile(): Promise<UserProfile> {
  return apiFetch("/api/user");
}

// ── Health API ─────────────────────────────────────────────────────────

export function getHealth(): Promise<HealthStatus> {
  return apiFetch("/api/health");
}

// ── Timezone sync ──────────────────────────────────────────────────────
// Wake times are picked in the browser's timezone; this keeps the timezone used in Telegram
// messages in step with it (it used to be stuck on Asia/Kolkata for everyone).

export function updateTimezone(
  timezone: string
): Promise<{ timezone: string; privacyDefault: string }> {
  return apiFetch("/api/user", {
    method: "PATCH",
    body: JSON.stringify({ timezone }),
  });
}
