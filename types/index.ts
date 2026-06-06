// types/index.ts
// Shared types across the entire app.

export type SessionStatus =
  | "SCHEDULED"
  | "ALARM_FIRED"
  | "FIRST_CONFIRMED"
  | "ROUND_TWO"
  | "CONFIRMED"
  | "FAILED"
  | "CANCELLED";

export type PrivacyMode = "OPEN" | "MINIMAL" | "ANONYMOUS";
export type NotifyChannel = "TELEGRAM" | "WHATSAPP" | "SMS" | "PUSH";
export type WakeReason = "EXAM" | "FLIGHT" | "MEETING" | "WORKOUT" | "OTHER";
export type EscalationType =
  | "SESSION_CREATED"
  | "ALARM_FIRED"
  | "FIRST_CONFIRMED"
  | "ROUND_TWO"
  | "CONFIRMED"
  | "FAILED";

// ─── API Requests ──────────────────────────────────────────────────

export interface CreateSessionRequest {
  wakeAt: string;         // ISO string
  friendIds: string[];
  reason?: WakeReason;
  privacyMode?: PrivacyMode;
  openWatchLink?: boolean;
}

export interface CreateSessionResponse {
  sessionId: string;
  confirmToken: string;
  openWatchToken?: string;
  watcherCount: number;
}

export interface CreateFriendRequest {
  name: string;
  phone?: string;
  channel?: NotifyChannel;
  timezone?: string;
}

// ─── API Responses ─────────────────────────────────────────────────

export interface FriendPublic {
  id: string;
  name: string;
  channel: NotifyChannel;
  telegramLinked: boolean;
  timezone: string;
  totalWatches: number;
  totalSaves: number;
  linkToken: string;
  linkedAt: string | null;
}

export interface WatcherInfo {
  friendId: string;
  name: string;
  committed: boolean;
  markedAwake: boolean;
}

export interface SessionStatusResponse {
  id: string;
  status: SessionStatus;
  wakeAt: string;
  alarmFiredAt: string | null;
  confirmedAt: string | null;
  secondConfirmedAt: string | null;
  roundsEscalated: number;
  watchers: WatcherInfo[];
}

export interface WatcherPageData {
  sleeperName: string;
  wakeTime: string;
  reason: WakeReason | null;
  status: SessionStatus;
  committed: boolean;
  markedAwake: boolean;
  friendName: string;
  alarmFiredAt: string | null;
  roundsEscalated: number;
}

export interface SessionHistoryItem {
  id: string;
  wakeAt: string;
  sleepAt: string;
  status: SessionStatus;
  reason: WakeReason | null;
  roundsEscalated: number;
  confirmedAt: string | null;
  secondConfirmedAt: string | null;
  primaryWatcher: { id: string; name: string } | null;
  events: { type: EscalationType; triggeredAt: string }[];
}

export interface DebriefData {
  sessionId: string;
  saverName: string | null;
  rounds: number;
  sleepDuration: string;
  wakeTime: string;
  success: boolean;
  totalSessions: number;
  totalSuccesses: number;
}

export interface HealthStatus {
  ok: boolean;
  db: "ok" | "error";
  redis: "ok" | "error" | "unconfigured";
  telegram: "ok" | "error";
  ts: string;
}

// ─── Client-side session config (passed between screens) ───────────

export interface SessionConfig {
  sessionId: string;
  confirmToken: string;
  wakeTimeStr: string;
  wakeAt: string;           // ISO string
  selectedFriends: string[];
  friendNames: string[];
  reason?: WakeReason;
  privacyMode?: PrivacyMode;
  openWatchToken?: string;
}

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  telegramChatId: string | null;
  telegramUsername: string | null;
  timezone: string;
  totalSessions: number;
  totalSuccesses: number;
}
