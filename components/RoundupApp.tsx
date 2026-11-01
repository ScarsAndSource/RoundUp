"use client";
// components/RoundupApp.tsx
// Fixed version — all bugs resolved:
// 1. _iv on number primitive crash → proper closure with separate iv ref
// 2. All useEffect missing deps fixed
// 3. All callbacks passed as props stabilized with useCallback
// 4. Telegram link flow: refetches profile after linking
// 5. Session restore on hard refresh fixed
// 6. Duplicate poll intervals prevented
// 7. Memory leaks: all timers/intervals cleaned up
// 8. onConfirmed inline arrow stabilized
// 9. handleCancel, handleDeleteFriend, handleSleep all stable useCallback

import { useState, useEffect, useCallback, useRef } from "react";
import { useSupabase } from "@/components/providers/SupabaseProvider";
import * as api from "@/lib/api";
import type {
  FriendPublic,
  SessionHistoryItem,
  SessionConfig,
  SessionStatusResponse,
  WakeReason,
  PrivacyMode,
} from "@/types";

/* ─── DESIGN TOKENS ─────────────────────────────────────────────── */
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,300&family=Syne:wght@400;500;600;700;800&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --ink: #0a0b0f; --ink-2: #10121a; --ink-3: #181c28;
    --surface: #1e2235; --surface-2: #252a3d; --surface-3: #2d3350;
    --border: rgba(255,255,255,0.07); --border-2: rgba(255,255,255,0.13);
    --amber: #f5a623; --amber-dim: #b87a18; --amber-glow: rgba(245,166,35,0.18); --amber-glow-2: rgba(245,166,35,0.08);
    --red: #ff4545; --red-dim: #c02020; --red-glow: rgba(255,69,69,0.22);
    --green: #2ecc71; --green-glow: rgba(46,204,113,0.18);
    --blue: #4a90e2;
    --text: #e8eaf0; --text-2: #9099b5; --text-3: #5a6280;
    --font-display: 'Syne', sans-serif; --font-body: 'DM Sans', sans-serif;
    --r-sm: 8px; --r-md: 14px; --r-lg: 20px; --r-xl: 28px;
    --shadow-sm: 0 2px 12px rgba(0,0,0,0.4); --shadow-md: 0 8px 32px rgba(0,0,0,0.5);
    --transition: all 0.25s cubic-bezier(0.4,0,0.2,1);
  }
  html, body, #root { height: 100%; }
  body { font-family: var(--font-body); background: var(--ink); color: var(--text); -webkit-font-smoothing: antialiased; overflow-x: hidden; }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--surface-3); border-radius: 2px; }
  input, select { font-family: var(--font-body); background: var(--surface); border: 1px solid var(--border-2); border-radius: var(--r-md); color: var(--text); font-size: 15px; padding: 12px 14px; outline: none; transition: border-color 0.2s; width: 100%; }
  input:focus, select:focus { border-color: var(--amber); }
  input::placeholder { color: var(--text-3); }
  @keyframes fadeUp { from{opacity:0;transform:translateY(16px);} to{opacity:1;transform:translateY(0);} }
  @keyframes fadeIn { from{opacity:0;} to{opacity:1;} }
  @keyframes slideIn { from{transform:translateX(40px);opacity:0;} to{transform:translateX(0);opacity:1;} }
  @keyframes slideUp { from{transform:translateY(40px);opacity:0;} to{transform:translateY(0);opacity:1;} }
  @keyframes sheetUp { from{transform:translateY(100%);} to{transform:translateY(0);} }
  @keyframes notifSlide { from{transform:translateY(-20px) translateX(-50%);opacity:0;} to{transform:translateY(0) translateX(-50%);opacity:1;} }
  @keyframes pulse-ring { 0%,100%{transform:scale(1);opacity:0.7;} 50%{transform:scale(1.08);opacity:0.4;} }
  @keyframes ping { 0%{transform:scale(1);opacity:1;} 75%,100%{transform:scale(2);opacity:0;} }
  @keyframes ticker { 0%,100%{opacity:1;transform:scale(1);} 50%{opacity:0.5;transform:scale(0.95);} }
  @keyframes shake { 0%,100%{transform:translateX(0);} 20%{transform:translateX(-6px);} 40%{transform:translateX(6px);} 60%{transform:translateX(-4px);} 80%{transform:translateX(4px);} }
  @keyframes alarmFlash { 0%,100%{background:var(--ink-2);} 50%{background:rgba(255,69,69,0.12);} }
  @keyframes waveform { 0%,100%{transform:scaleY(0.3);} 50%{transform:scaleY(1);} }
  @keyframes celebrationPop { 0%{transform:scale(0.3);opacity:0;} 60%{transform:scale(1.15);opacity:1;} 100%{transform:scale(1);opacity:1;} }
  @keyframes sleepFloat { 0%,100%{transform:translateY(0) rotate(-2deg);} 50%{transform:translateY(-10px) rotate(2deg);} }
  @keyframes bubbleIn { from{opacity:0;transform:scale(0.9) translateY(8px);} to{opacity:1;transform:scale(1) translateY(0);} }
`;

/* ─── UTILS ─────────────────────────────────────────────────────── */
const fmt2 = (n: number) => String(n).padStart(2, "0");

/* ─── AUDIO ──────────────────────────────────────────────────────── */
// Pre-unlock on any user gesture (e.g. "Sleep now" click).
// Web Audio API requires a prior user interaction before playing.
let _audioCtx: AudioContext | null = null;

function unlockAudio() {
  try {
    const AC =
      window.AudioContext ||
      (window as unknown as Record<string, typeof AudioContext>).webkitAudioContext;
    if (!_audioCtx) _audioCtx = new AC();
    if (_audioCtx.state === "suspended") _audioCtx.resume().catch(() => {});
  } catch { /* not supported */ }
}

/** Returns true if the beep actually played. */
function playAlarmBeep(): boolean {
  if (!_audioCtx || _audioCtx.state !== "running") return false;
  try {
    const ctx = _audioCtx;
    const t = ctx.currentTime;
    // 3 sharp double-tone beeps spaced 350ms apart
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "square";
      osc.frequency.setValueAtTime(880, t + i * 0.35);
      osc.frequency.setValueAtTime(660, t + i * 0.35 + 0.12);
      gain.gain.setValueAtTime(0.5, t + i * 0.35);
      gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.35 + 0.32);
      osc.start(t + i * 0.35);
      osc.stop(t + i * 0.35 + 0.32);
    }
    return true;
  } catch { return false; }
}

/** Vibrate pattern for mobile browsers (no-op on desktop). */
function vibrateAlarm() {
  try { navigator.vibrate?.([400, 150, 400, 150, 600]); } catch { }
}

function useTimer(targetMs: number, active: boolean) {
  const [remaining, setRemaining] = useState(targetMs);
  useEffect(() => {
    if (!active) { setRemaining(targetMs); return; }
    setRemaining(targetMs);
    const iv = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1000) { clearInterval(iv); return 0; }
        return r - 1000;
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [active, targetMs]);
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  return { remaining, mins, secs, done: remaining === 0 };
}

function friendInitials(name: string): string {
  return name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
}

const FRIEND_COLORS = ["#a78bfa","#34d399","#f87171","#fbbf24","#60a5fa","#f472b6","#4ade80","#fb923c"];
function friendColor(id: string): string {
  let hash = 0;
  for (const c of id) hash = (hash * 31 + c.charCodeAt(0)) & 0xFFFFFF;
  return FRIEND_COLORS[Math.abs(hash) % FRIEND_COLORS.length];
}

/* ─── PRIMITIVES ─────────────────────────────────────────────────── */
function Avatar({ name, id, size = 40, online = false }: { name: string; id: string; size?: number; online?: boolean }) {
  const color = friendColor(id);
  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <div style={{ width: size, height: size, borderRadius: "50%", background: color + "22", border: `1.5px solid ${color}55`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.33, fontWeight: 600, color, fontFamily: "var(--font-display)" }}>{friendInitials(name)}</div>
      {online && <div style={{ position: "absolute", bottom: 1, right: 1, width: 9, height: 9, borderRadius: "50%", background: "var(--green)", border: "2px solid var(--ink)" }} />}
    </div>
  );
}

function Badge({ children, type = "neutral" }: { children: React.ReactNode; type?: string }) {
  const C: Record<string, { bg: string; c: string }> = {
    neutral: { bg: "var(--surface-2)", c: "var(--text-2)" },
    amber: { bg: "var(--amber-glow)", c: "var(--amber)" },
    red: { bg: "var(--red-glow)", c: "var(--red)" },
    green: { bg: "var(--green-glow)", c: "var(--green)" },
    blue: { bg: "rgba(74,144,226,0.15)", c: "var(--blue)" },
    tg: { bg: "rgba(41,182,246,0.15)", c: "#29b6f6" },
  };
  const s = C[type] ?? C.neutral;
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 20, background: s.bg, color: s.c, fontSize: 11, fontWeight: 500, letterSpacing: "0.03em" }}>{children}</span>;
}

function Toggle({ val, onChange }: { val: boolean; onChange: (v: boolean) => void }) {
  return (
    <div onClick={() => onChange(!val)} style={{ width: 42, height: 24, borderRadius: 12, cursor: "pointer", background: val ? "var(--amber)" : "var(--surface-3)", position: "relative", transition: "background 0.2s", flexShrink: 0 }}>
      <div style={{ position: "absolute", top: 3, left: val ? 20 : 3, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 0.2s", boxShadow: "0 1px 4px rgba(0,0,0,0.3)" }} />
    </div>
  );
}

function Toast({ message, type = "info", onDone }: { message: string; type?: string; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 3000); return () => clearTimeout(t); }, [onDone]);
  const border = type === "success" ? "var(--green)" : type === "error" ? "var(--red)" : "var(--amber)";
  return (
    <div style={{ position: "fixed", top: 20, left: "50%", transform: "translateX(-50%)", background: "var(--surface)", border: `1px solid ${border}44`, borderRadius: 14, padding: "10px 18px", fontSize: 13, color: "var(--text)", zIndex: 9999, animation: "notifSlide 0.3s ease", boxShadow: "var(--shadow-md)", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ width: 6, height: 6, borderRadius: "50%", background: border, flexShrink: 0 }} />{message}
    </div>
  );
}

function BottomNav({ screen, onNav }: { screen: string; onNav: (s: string) => void }) {
  const tabs = [{ id: "home", label: "Home", icon: "🌙" }, { id: "history", label: "History", icon: "📊" }, { id: "friends", label: "Friends", icon: "👥" }, { id: "settings", label: "Settings", icon: "⚙️" }];
  const homeSet = new Set(["home", "sleep_entry", "session_active", "first_confirm", "second_confirm", "round_two", "debrief"]);
  const settSet = new Set(["settings", "telegram_setup"]);
  const active = homeSet.has(screen) ? "home" : settSet.has(screen) ? "settings" : screen;
  return (
    <nav style={{ position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 430, background: "var(--ink-2)", borderTop: "1px solid var(--border)", display: "flex", zIndex: 100, paddingBottom: "env(safe-area-inset-bottom,0px)" }}>
      {tabs.map((t) => (
        <button key={t.id} onClick={() => onNav(t.id)} style={{ flex: 1, padding: "10px 0 8px", background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, opacity: active === t.id ? 1 : 0.45, transition: "opacity 0.2s" }}>
          <span style={{ fontSize: 20 }}>{t.icon}</span>
          <span style={{ fontSize: 10, fontFamily: "var(--font-body)", color: "var(--text)", fontWeight: active === t.id ? 500 : 400 }}>{t.label}</span>
          {active === t.id && <div style={{ width: 20, height: 2, borderRadius: 1, background: "var(--amber)", marginTop: 1 }} />}
        </button>
      ))}
    </nav>
  );
}

const pBtn: React.CSSProperties = { width: "100%", padding: "16px 24px", background: "var(--amber)", borderRadius: "var(--r-lg)", border: "none", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 700, color: "#0a0b0f", letterSpacing: "-0.01em", transition: "var(--transition)" };
const gBtn: React.CSSProperties = { padding: "16px 20px", borderRadius: "var(--r-lg)", background: "transparent", border: "1px solid var(--border-2)", color: "var(--text-2)", fontSize: 14, cursor: "pointer", fontFamily: "var(--font-body)", transition: "var(--transition)" };

/* ─── HOME ───────────────────────────────────────────────────────── */
function HomeScreen({ onStart, userProfile, friends, sessions, healthOk, onLinkTelegram }: {
  onStart: () => void;
  userProfile: { name: string; totalSessions: number; totalSuccesses: number; telegramChatId: string | null } | null;
  friends: FriendPublic[];
  sessions: SessionHistoryItem[];
  healthOk: boolean | null;
  onLinkTelegram: () => void;
}) {
  const telegramLinked = !!userProfile?.telegramChatId;
  const last = sessions[0];
  const successRate = userProfile && userProfile.totalSessions > 0
    ? Math.round((userProfile.totalSuccesses / userProfile.totalSessions) * 100)
    : 0;
  const bestWatcher = [...friends].sort((a, b) => b.totalSaves - a.totalSaves)[0];

  return (
    <div style={{ padding: "24px 20px 100px", animation: "fadeUp 0.4s ease" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: 28, fontWeight: 800, letterSpacing: "-0.02em" }}>Round<span style={{ color: "var(--amber)" }}>up</span></h1>
        <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 10px", background: healthOk === false ? "var(--red-glow)" : "var(--green-glow)", borderRadius: 20 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: healthOk === false ? "var(--red)" : "var(--green)", animation: "pulse-ring 2s infinite" }} />
          <span style={{ fontSize: 11, color: healthOk === false ? "var(--red)" : "var(--green)", fontWeight: 500 }}>
            {healthOk === null ? "Checking…" : healthOk ? "Systems live" : "Degraded"}
          </span>
        </div>
      </div>
      <p style={{ fontSize: 14, color: "var(--text-2)", marginBottom: 20 }}>
        {userProfile ? `Hey ${userProfile.name.split(" ")[0]}. Your crew has your back.` : "Your crew has your back."}
      </p>

      {!telegramLinked && (
        <div onClick={onLinkTelegram} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 16px", background: "rgba(41,182,246,0.08)", border: "1px solid rgba(41,182,246,0.25)", borderRadius: "var(--r-md)", marginBottom: 20, cursor: "pointer" }}>
          <span style={{ fontSize: 22 }}>✈️</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: "#29b6f6" }}>Link Telegram for wake alerts</div>
            <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 1 }}>Required for real-time notifications</div>
          </div>
          <span style={{ fontSize: 12, color: "#29b6f6", flexShrink: 0 }}>Set up →</span>
        </div>
      )}

      {telegramLinked && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: "rgba(41,182,246,0.08)", border: "1px solid rgba(41,182,246,0.25)", borderRadius: "var(--r-md)", marginBottom: 20 }}>
          <span style={{ fontSize: 18 }}>✈️</span>
          <span style={{ fontSize: 12, color: "#29b6f6", flex: 1 }}>Telegram linked</span>
          <Badge type="tg">✓ Active</Badge>
        </div>
      )}

      <button onClick={onStart} style={{ width: "100%", padding: "22px 24px", background: "var(--amber)", borderRadius: "var(--r-xl)", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24, boxShadow: "0 8px 32px rgba(245,166,35,0.35)" }}>
        <div><div style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 700, color: "#0a0b0f", marginBottom: 2 }}>Go to sleep</div><div style={{ fontSize: 13, color: "rgba(0,0,0,0.55)" }}>Set your wake time + watchers</div></div>
        <div style={{ width: 48, height: 48, borderRadius: "50%", background: "rgba(0,0,0,0.12)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>🌙</div>
      </button>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 28 }}>
        {[
          { label: "Sessions", val: String(userProfile?.totalSessions ?? 0), sub: "all time" },
          { label: "Success rate", val: `${successRate}%`, sub: "wake ups" },
          { label: "Best watcher", val: bestWatcher?.name.split(" ")[0] ?? "–", sub: `${bestWatcher?.totalSaves ?? 0} saves` },
        ].map((s, i) => (
          <div key={i} style={{ background: "var(--surface)", borderRadius: "var(--r-md)", border: "1px solid var(--border)", padding: "14px 12px" }}>
            <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "var(--font-display)", color: "var(--amber)", letterSpacing: "-0.02em" }}>{s.val}</div>
            <div style={{ fontSize: 11, color: "var(--text-2)", marginTop: 2 }}>{s.label}</div>
            <div style={{ fontSize: 10, color: "var(--text-3)" }}>{s.sub}</div>
          </div>
        ))}
      </div>

      {last && (
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 11, fontWeight: 500, color: "var(--text-3)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 12 }}>Last session</div>
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: "16px", display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 44, height: 44, borderRadius: "50%", background: last.status === "CONFIRMED" ? "var(--green-glow)" : "var(--red-glow)", border: `1.5px solid ${last.status === "CONFIRMED" ? "var(--green)" : "var(--red)"}44`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>
              {last.status === "CONFIRMED" ? "✓" : "✗"}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 2 }}>
                {last.primaryWatcher ? `Woken by ${last.primaryWatcher.name.split(" ")[0]}` : "No watcher"}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-2)" }}>
                {new Date(last.wakeAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true })}
                {last.reason && <span style={{ color: "var(--amber)" }}> · {last.reason.toLowerCase()}</span>}
              </div>
            </div>
            <Badge type={last.status === "CONFIRMED" ? "green" : "red"}>
              {last.status === "CONFIRMED" ? "Success" : "Failed"}
            </Badge>
          </div>
        </div>
      )}

      {friends.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 500, color: "var(--text-3)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 12 }}>Your crew</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {friends.slice(0, 3).map((f) => (
              <div key={f.id} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", padding: "12px 14px", display: "flex", alignItems: "center", gap: 12 }}>
                <Avatar name={f.name} id={f.id} size={36} online={f.telegramLinked} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{f.name}</div>
                  <div style={{ fontSize: 11, color: "var(--text-2)" }}>✈️ {f.channel.toLowerCase()} · {f.totalSaves} saves</div>
                </div>
                <span style={{ fontSize: 11, color: "var(--text-3)" }}>{f.timezone.split("/")[1]?.replace("_", " ") ?? f.timezone}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {friends.length === 0 && (
        <div style={{ padding: "20px", background: "var(--surface)", border: "1px dashed var(--border-2)", borderRadius: "var(--r-lg)", textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>👥</div>
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>No crew yet</div>
          <div style={{ fontSize: 12, color: "var(--text-3)" }}>Add friends in the Friends tab to get started</div>
        </div>
      )}
    </div>
  );
}

/* ─── SLEEP ENTRY ─────────────────────────────────────────────────── */
function SleepEntry({ onConfirm, onBack, friends }: {
  onConfirm: (cfg: { hour: number; minute: number; ampm: string; selectedFriendIds: string[]; reason: WakeReason | null; privacy: PrivacyMode; openWatch: boolean }) => void;
  onBack: () => void;
  friends: FriendPublic[];
}) {
  const [hour, setHour] = useState(7);
  const [minute, setMinute] = useState(0);
  const [ampm, setAmpm] = useState<"AM" | "PM">("AM");
  const [selectedFriendIds, setSelectedFriendIds] = useState<string[]>([]);
  const [privacy, setPrivacy] = useState<PrivacyMode>("MINIMAL");
  const [openWatch, setOpenWatch] = useState(false);
  const [reason, setReason] = useState<WakeReason | null>(null);
  const [step, setStep] = useState(1);

  const toggle = (id: string) => setSelectedFriendIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  const hours = Array.from({ length: 12 }, (_, i) => i + 1);
  const minutes = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
  const reasons: { id: WakeReason; label: string; icon: string }[] = [
    { id: "EXAM", label: "Exam", icon: "📝" },
    { id: "FLIGHT", label: "Flight", icon: "✈️" },
    { id: "MEETING", label: "Meeting", icon: "💼" },
    { id: "WORKOUT", label: "Workout", icon: "🏋️" },
    { id: "OTHER", label: "Other", icon: "⏰" },
  ];
  const wakeTimeStr = `${hour}:${fmt2(minute)} ${ampm}`;

  return (
    <div style={{ padding: "0 0 100px", animation: "fadeIn 0.3s ease" }}>
      <div style={{ padding: "20px 20px 0", display: "flex", alignItems: "center", gap: 14, marginBottom: 28 }}>
        <button onClick={onBack} style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--surface)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 16, color: "var(--text-2)" }}>←</button>
        <div>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 700 }}>Set your alarm</h2>
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            {[1, 2, 3].map((s) => (<div key={s} style={{ height: 3, borderRadius: 2, width: s === step ? 20 : 12, background: s <= step ? "var(--amber)" : "var(--surface-3)", transition: "all 0.3s ease" }} />))}
          </div>
        </div>
      </div>

      {step === 1 && (
        <div style={{ padding: "0 20px", animation: "slideIn 0.3s ease" }}>
          <div style={{ textAlign: "center", marginBottom: 32 }}>
            <p style={{ fontSize: 13, color: "var(--text-2)", marginBottom: 20 }}>What time should your crew wake you up?</p>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "16px 32px", background: "var(--surface)", border: "1px solid var(--border-2)", borderRadius: "var(--r-xl)", marginBottom: 28 }}>
              <span style={{ fontFamily: "var(--font-display)", fontSize: 56, fontWeight: 700, color: "var(--amber)", letterSpacing: "-0.04em", lineHeight: 1 }}>{hour}:{fmt2(minute)}</span>
              <span style={{ fontFamily: "var(--font-display)", fontSize: 24, fontWeight: 600, color: "var(--text-2)", marginLeft: 6, alignSelf: "flex-end", paddingBottom: 6 }}>{ampm}</span>
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Hour</div>
              <div style={{ display: "flex", gap: 6, justifyContent: "center", flexWrap: "wrap" }}>
                {hours.map((h) => (<button key={h} onClick={() => setHour(h)} style={{ width: 44, height: 38, background: hour === h ? "var(--amber)" : "var(--surface)", border: `1px solid ${hour === h ? "transparent" : "var(--border)"}`, borderRadius: "var(--r-sm)", color: hour === h ? "#0a0b0f" : "var(--text)", fontSize: 14, fontWeight: hour === h ? 700 : 400, cursor: "pointer", fontFamily: "var(--font-display)" }}>{h}</button>))}
              </div>
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Minute</div>
              <div style={{ display: "flex", gap: 6, justifyContent: "center", flexWrap: "wrap" }}>
                {minutes.map((m) => (<button key={m} onClick={() => setMinute(m)} style={{ width: 50, height: 38, background: minute === m ? "var(--amber)" : "var(--surface)", border: `1px solid ${minute === m ? "transparent" : "var(--border)"}`, borderRadius: "var(--r-sm)", color: minute === m ? "#0a0b0f" : "var(--text)", fontSize: 14, fontWeight: minute === m ? 700 : 400, cursor: "pointer", fontFamily: "var(--font-display)" }}>{fmt2(m)}</button>))}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 24 }}>
              {(["AM", "PM"] as const).map((ap) => (<button key={ap} onClick={() => setAmpm(ap)} style={{ width: 80, height: 40, background: ampm === ap ? "var(--amber)" : "var(--surface)", border: `1px solid ${ampm === ap ? "transparent" : "var(--border)"}`, borderRadius: "var(--r-md)", color: ampm === ap ? "#0a0b0f" : "var(--text)", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-display)" }}>{ap}</button>))}
            </div>
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Why? (optional)</div>
              <div style={{ display: "flex", gap: 6, justifyContent: "center", flexWrap: "wrap" }}>
                {reasons.map((r) => (<button key={r.id} onClick={() => setReason(reason === r.id ? null : r.id)} style={{ padding: "6px 12px", borderRadius: 20, background: reason === r.id ? "var(--amber-glow)" : "var(--surface)", border: `1px solid ${reason === r.id ? "var(--amber)" : "var(--border)"}`, color: reason === r.id ? "var(--amber)" : "var(--text-2)", fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}><span>{r.icon}</span>{r.label}</button>))}
              </div>
            </div>
          </div>
          <button onClick={() => setStep(2)} style={pBtn}>Choose watchers →</button>
        </div>
      )}

      {step === 2 && (
        <div style={{ padding: "0 20px", animation: "slideIn 0.3s ease" }}>
          <p style={{ fontSize: 13, color: "var(--text-2)", marginBottom: 6 }}>Who's watching your back tonight?</p>
          <p style={{ fontSize: 12, color: "var(--text-3)", marginBottom: 20 }}>They'll be asked to commit — not just notified.</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
            {friends.map((f, i) => {
              const sel = selectedFriendIds.includes(f.id);
              const color = friendColor(f.id);
              return (
                <button key={f.id} onClick={() => toggle(f.id)} style={{ background: sel ? "var(--surface-2)" : "var(--surface)", border: `1.5px solid ${sel ? color + "66" : "var(--border)"}`, borderRadius: "var(--r-md)", padding: "14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 12, textAlign: "left", animation: `fadeUp 0.3s ease ${i * 0.05}s both` }}>
                  <Avatar name={f.name} id={f.id} size={40} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text)", marginBottom: 2, display: "flex", alignItems: "center", gap: 6 }}>{f.name}{f.telegramLinked && <Badge type="tg">✈️</Badge>}</div>
                    <div style={{ fontSize: 11, color: "var(--text-2)", display: "flex", alignItems: "center", gap: 6 }}>
                      ✈️ {f.channel.toLowerCase()} · <span style={{ color: "var(--green)" }}>⚡ {f.totalSaves} saves</span>
                    </div>
                  </div>
                  <div style={{ width: 22, height: 22, borderRadius: "50%", background: sel ? color : "transparent", border: `1.5px solid ${sel ? color : "var(--border-2)"}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: sel ? "#fff" : "transparent", flexShrink: 0 }}>{sel ? "✓" : ""}</div>
                </button>
              );
            })}
            {friends.length === 0 && (
              <div style={{ padding: "16px", background: "var(--surface)", border: "1px dashed var(--border-2)", borderRadius: "var(--r-md)", textAlign: "center", color: "var(--text-3)", fontSize: 13 }}>
                No friends added yet. Go to Friends tab to add your crew.
              </div>
            )}
          </div>
          {selectedFriendIds.length === 0 && (
            <div style={{ padding: "12px 16px", borderRadius: "var(--r-md)", background: "rgba(255,69,69,0.08)", border: "1px solid rgba(255,69,69,0.33)", marginBottom: 16, fontSize: 12, color: "var(--red)" }}>
              ⚠️ No watchers selected — your phone alarm will still fire, but nobody's watching.
            </div>
          )}
          <div style={{ padding: "12px 14px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", marginBottom: 16, display: "flex", alignItems: "center", gap: 12, justifyContent: "space-between" }}>
            <div><div style={{ fontSize: 13, fontWeight: 500, marginBottom: 2 }}>🔗 Open watch link</div><div style={{ fontSize: 11, color: "var(--text-3)" }}>Anyone with link can join as watcher</div></div>
            <Toggle val={openWatch} onChange={setOpenWatch} />
          </div>
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Privacy mode</div>
            <div style={{ display: "flex", gap: 8 }}>
              {([{ id: "OPEN" as PrivacyMode, label: "Open", icon: "🌐" }, { id: "MINIMAL" as PrivacyMode, label: "Minimal", icon: "👤" }, { id: "ANONYMOUS" as PrivacyMode, label: "Hidden", icon: "🕵️" }]).map((p) => (
                <button key={p.id} onClick={() => setPrivacy(p.id)} style={{ flex: 1, padding: "10px 8px", borderRadius: "var(--r-md)", background: privacy === p.id ? "var(--amber-glow)" : "var(--surface)", border: `1.5px solid ${privacy === p.id ? "var(--amber)" : "var(--border)"}`, color: privacy === p.id ? "var(--amber)" : "var(--text-2)", cursor: "pointer", textAlign: "center" }}>
                  <div style={{ fontSize: 16, marginBottom: 3 }}>{p.icon}</div>
                  <div style={{ fontSize: 11, fontWeight: 500 }}>{p.label}</div>
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={() => setStep(1)} style={gBtn}>← Back</button>
            <button onClick={() => setStep(3)} style={{ ...pBtn, flex: 1 }}>Review →</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div style={{ padding: "0 20px", animation: "slideIn 0.3s ease" }}>
          <div style={{ background: "var(--surface)", border: "1px solid var(--border-2)", borderRadius: "var(--r-xl)", padding: "24px", marginBottom: 20 }}>
            <div style={{ textAlign: "center", marginBottom: 24, paddingBottom: 24, borderBottom: "1px solid var(--border)" }}>
              <div style={{ fontSize: 12, color: "var(--text-3)", marginBottom: 6 }}>Wake me at</div>
              <div style={{ fontFamily: "var(--font-display)", fontSize: 48, fontWeight: 800, color: "var(--amber)", letterSpacing: "-0.04em" }}>{wakeTimeStr}</div>
              {reason && <div style={{ marginTop: 8 }}><Badge type="amber">{reasons.find((r) => r.id === reason)?.icon} {reason.toLowerCase()}</Badge></div>}
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Watchers ({selectedFriendIds.length})</div>
              {selectedFriendIds.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--text-3)", fontStyle: "italic" }}>None — device alarm only</div>
              ) : (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {friends.filter((f) => selectedFriendIds.includes(f.id)).map((f) => (
                    <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", background: "var(--surface-2)", borderRadius: 20 }}>
                      <Avatar name={f.name} id={f.id} size={20} />
                      <span style={{ fontSize: 12 }}>{f.name.split(" ")[0]}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 12, color: "var(--text-3)" }}>Privacy</span>
              <Badge type="amber">{privacy}</Badge>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", background: "var(--green-glow)", border: "1px solid rgba(46,204,113,0.44)", borderRadius: "var(--r-md)", marginBottom: 20, fontSize: 12, color: "var(--green)" }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--green)", animation: "pulse-ring 2s infinite", flexShrink: 0 }} />
            All systems operational
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={() => setStep(2)} style={gBtn}>← Back</button>
            <button onClick={() => onConfirm({ hour, minute, ampm, selectedFriendIds, reason, privacy, openWatch })} style={{ ...pBtn, flex: 1 }}>Sleep now 🌙</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── ACTIVE SESSION ─────────────────────────────────────────────── */
// FIX 1: proper closure iv ref — no more _iv on number primitive crash
// FIX 2: onAlarmFired added to deps
function ActiveSession({ config, onAlarmFired, onCancel, friends }: {
  config: SessionConfig;
  onAlarmFired: () => void;
  onCancel: () => void;
  friends: FriendPublic[];
}) {
  const [watcherStatus, setWatcherStatus] = useState<Record<string, "committed" | "pending">>({});
  const onAlarmFiredRef = useRef(onAlarmFired);
  useEffect(() => { onAlarmFiredRef.current = onAlarmFired; }, [onAlarmFired]);

  // Ring on this device at wake time — don't wait for cron + the 5s poll (cron can be ~2 min late).
  useEffect(() => {
    const ms = Math.max(0, new Date(config.wakeAt).getTime() - Date.now());
    const t = setTimeout(() => onAlarmFiredRef.current(), ms);
    return () => clearTimeout(t);
  }, [config.wakeAt]);

  // Keep the screen awake while waiting so the phone doesn't sleep through the alarm.
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        if (!("wakeLock" in navigator) || lock) return;
        const l = await navigator.wakeLock.request("screen");
        if (cancelled) { l.release().catch(() => {}); return; }
        lock = l;
        l.addEventListener("release", () => { if (lock === l) lock = null; });
      } catch { /* denied or unsupported — Telegram is still the backstop */ }
    };
    const onVisible = () => { if (document.visibilityState === "visible") acquire(); };
    acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      lock?.release().catch(() => {});
    };
  }, []);

  useEffect(() => {
    let iv: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      try {
        const status = await api.getSessionStatus(config.sessionId);
        if (cancelled) return;
        const newStatus: Record<string, "committed" | "pending"> = {};
        for (const w of status.watchers) {
          newStatus[w.friendId] = w.committed ? "committed" : "pending";
        }
        setWatcherStatus(newStatus);
        if (status.status !== "SCHEDULED") {
          onAlarmFiredRef.current();
        }
      } catch (err) {
        if (err instanceof api.ApiError && err.statusCode === 401) {
          window.location.href = `/login?redirect=${encodeURIComponent(window.location.pathname)}`;
        }
      }
    };

    // FIX: grace is just a timeout id (number). iv stored separately in closure.
    // Never attach properties to a primitive.
    const grace = setTimeout(() => {
      if (cancelled) return;
      poll();
      iv = setInterval(poll, 5000);
    }, 30000);

    return () => {
      cancelled = true;
      clearTimeout(grace);
      if (iv) clearInterval(iv);
    };
  }, [config.sessionId]);

  const wakeDate = new Date(config.wakeAt);
  const msUntilAlarm = Math.max(0, wakeDate.getTime() - Date.now());
  const { remaining, mins, secs } = useTimer(msUntilAlarm, msUntilAlarm > 0);
  const progress = msUntilAlarm > 0 ? 1 - (remaining / msUntilAlarm) : 1;
  const circumference = 2 * Math.PI * 110;
  const strokeDash = circumference * (1 - progress);
  const selectedFriends = friends.filter((f) => config.selectedFriends.includes(f.id));

  return (
    <div style={{ padding: "24px 20px 100px", animation: "fadeUp 0.4s ease" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 32 }}>
        <div>
          <div style={{ fontSize: 11, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Session active</div>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 700, marginTop: 2 }}>Alarm at {config.wakeTimeStr}</div>
        </div>
        <button onClick={onCancel} style={{ padding: "6px 14px", borderRadius: 20, background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text-2)", fontSize: 12, cursor: "pointer" }}>Cancel</button>
      </div>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 32 }}>
        <div style={{ position: "relative", width: 260, height: 260 }}>
          <svg width="260" height="260" style={{ position: "absolute", top: 0, left: 0 }}>
            <circle cx="130" cy="130" r="110" fill="none" stroke="var(--surface-3)" strokeWidth="3" />
            <circle cx="130" cy="130" r="110" fill="none" stroke="var(--amber)" strokeWidth="3" strokeDasharray={circumference} strokeDashoffset={strokeDash} strokeLinecap="round" transform="rotate(-90 130 130)" style={{ transition: "stroke-dashoffset 1s linear" }} />
          </svg>
          <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", textAlign: "center" }}>
            <div style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 4 }}>alarm in</div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 52, fontWeight: 800, color: "var(--text)", letterSpacing: "-0.04em", lineHeight: 1 }}>{fmt2(mins)}:{fmt2(secs)}</div>
            <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 4 }}>{config.wakeTimeStr}</div>
          </div>
        </div>
      </div>
      {selectedFriends.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>Watchers</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {selectedFriends.map((f) => {
              const status = watcherStatus[f.id] ?? "pending";
              return (
                <div key={f.id} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", padding: "12px 14px", display: "flex", alignItems: "center", gap: 12 }}>
                  <Avatar name={f.name} id={f.id} size={36} online={status === "committed"} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{f.name}</div>
                    <div style={{ fontSize: 11, color: "var(--text-2)" }}>✈️ {f.channel.toLowerCase()}</div>
                  </div>
                  {status === "committed" ? <Badge type="green">✓ Watching</Badge> : <Badge type="neutral">Notified</Badge>}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div style={{ padding: "12px 14px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", fontSize: 12, color: "var(--text-3)", textAlign: "center" }}>
        Friends are being notified via Telegram. Your alarm fires automatically.
      </div>
    </div>
  );
}

/* ─── ALARM FIRING ─────────────────────────────────────────────────── */
// FIX 3: onRoundTwo stabilized via ref to avoid stale closure in useEffect
function AlarmFiring({ config, onConfirm, onRoundTwo }: {
  config: SessionConfig;
  onConfirm: () => void;
  onRoundTwo: () => void;
}) {
  const { remaining, mins, secs, done } = useTimer(5 * 60 * 1000, true);
  const [confirming, setConfirming] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState<boolean | null>(null);
  const onRoundTwoRef = useRef(onRoundTwo);
  useEffect(() => { onRoundTwoRef.current = onRoundTwo; }, [onRoundTwo]);

  useEffect(() => {
    if (done) onRoundTwoRef.current();
  }, [done]);

  // ── Sound: attempt on mount, start loop if successful ──────────
  useEffect(() => {
    vibrateAlarm();
    unlockAudio();
    const played = playAlarmBeep();
    setSoundEnabled(played);
  }, []);

  useEffect(() => {
    if (!soundEnabled) return;
    const iv = setInterval(() => {
      vibrateAlarm();
      playAlarmBeep();
    }, 2500);
    return () => clearInterval(iv);
  }, [soundEnabled]);

  const handleConfirm = async () => {
    setConfirming(true);
    try {
      await api.confirmAwake(config.sessionId, config.confirmToken);
      onConfirm();
    } catch {
      setConfirming(false);
    }
  };

  return (
    <div style={{ padding: "24px 20px 100px", animation: "alarmFlash 2s ease-in-out infinite", minHeight: "100vh" }}>
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 16px", background: "var(--red-glow)", border: "1px solid rgba(255,69,69,0.44)", borderRadius: 20, marginBottom: 20 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--red)", animation: "ping 1s ease-in-out infinite" }} />
          <span style={{ fontSize: 12, color: "var(--red)", fontWeight: 500 }}>ALARM RINGING</span>
        </div>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 64, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--amber)", animation: "shake 0.5s ease-in-out infinite", lineHeight: 1, marginBottom: 8 }}>⏰</div>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 36, fontWeight: 800, letterSpacing: "-0.03em", marginBottom: 4 }}>Wake Up!</div>
        <div style={{ fontSize: 14, color: "var(--text-2)" }}>{config.wakeTimeStr} · Confirm you're awake</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 3, height: 40, marginBottom: 28 }}>
        {Array.from({ length: 20 }).map((_, i) => (<div key={i} style={{ width: 3, height: 20 + Math.sin(i * 0.8) * 14, background: "var(--amber)", borderRadius: 2, opacity: 0.8, animation: `waveform 0.${3 + (i % 5)}s ease-in-out infinite`, animationDelay: `${i * 0.04}s` }} />))}
      </div>
      <div style={{ textAlign: "center", marginBottom: 24, padding: "10px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--r-md)" }}>
        <span style={{ fontSize: 12, color: "var(--text-2)" }}>Friends alerted in </span>
        <span style={{ fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 700, color: "var(--red)" }}>{fmt2(mins)}:{fmt2(secs)}</span>
        <span style={{ fontSize: 12, color: "var(--text-2)" }}> if not confirmed</span>
      </div>
      {soundEnabled === false && (
        <button
          onClick={() => { unlockAudio(); setSoundEnabled(true); }}
          style={{ width: "100%", padding: "14px", borderRadius: "var(--r-md)", background: "rgba(255,69,69,0.12)", border: "1px solid rgba(255,69,69,0.45)", color: "var(--red)", fontSize: 14, cursor: "pointer", fontFamily: "var(--font-body)", marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
        >
          🔊 Tap to enable alarm sound
        </button>
      )}
      <button onClick={handleConfirm} disabled={confirming} style={{ width: "100%", padding: "22px", background: "var(--amber)", borderRadius: "var(--r-xl)", border: "none", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 700, color: "#0a0b0f", boxShadow: "0 8px 32px rgba(245,166,35,0.45)", animation: "pulse-ring 2s ease-in-out infinite", marginBottom: 12 }}>
        {confirming ? "Confirming…" : "✓ I'm Awake"}
      </button>
      <p style={{ textAlign: "center", fontSize: 11, color: "var(--text-3)" }}>You'll need to confirm again in 3 minutes to prove consciousness</p>
    </div>
  );
}

/* ─── SECOND CONFIRM ─────────────────────────────────────────────── */
// FIX 4: onFailed stabilized via ref
function SecondConfirm({ config, onConfirmed, onFailed }: {
  config: SessionConfig;
  onConfirmed: (saverName: string | null) => void;
  onFailed: () => void;
}) {
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [solved, setSolved] = useState(false);
  const [error, setError] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { remaining, mins, secs, done } = useTimer(3 * 60 * 1000, !solved);
  // The server enforces a 2-minute gap after the first tap, so the slider stays locked until then.
  const unlockInMs = Math.max(0, 2 * 60 * 1000 - (3 * 60 * 1000 - remaining));
  const locked = unlockInMs > 0;
  const onFailedRef = useRef(onFailed);
  useEffect(() => { onFailedRef.current = onFailed; }, [onFailed]);

  useEffect(() => {
    if (done && !solved) onFailedRef.current();
  }, [done, solved]);

  const handleDragEnd = async () => {
    setDragging(false);
    if (locked) {
      setDragX(0);
      setError(true);
      setTimeout(() => setError(false), 600);
    } else if (dragX > 200) {
      setSolved(true);
      setConfirming(true);
      try {
        const result = await api.confirmSecondAwake(config.sessionId, config.confirmToken);
        onConfirmed(result.saverName);
      } catch {
        setConfirming(false);
        setSolved(false);
        setDragX(0);
      }
    } else {
      setDragX(0);
      setError(true);
      setTimeout(() => setError(false), 600);
    }
  };

  return (
    <div style={{ padding: "24px 20px 100px", animation: "fadeUp 0.4s ease" }}>
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>🧠</div>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: 24, fontWeight: 700, marginBottom: 8 }}>Still awake?</h2>
        <p style={{ fontSize: 14, color: "var(--text-2)", lineHeight: 1.6 }}>You confirmed awake 3 minutes ago.<br />Prove you're still conscious.</p>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center", marginBottom: 32, padding: "8px 16px", background: remaining < 60000 ? "var(--red-glow)" : "var(--surface)", border: `1px solid ${remaining < 60000 ? "rgba(255,69,69,0.44)" : "var(--border)"}`, borderRadius: 20, width: "fit-content", margin: "0 auto 32px" }}>
        <div style={{ width: 6, height: 6, borderRadius: "50%", background: remaining < 60000 ? "var(--red)" : "var(--amber)", animation: "ping 1s ease-in-out infinite" }} />
        <span style={{ fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 700, color: remaining < 60000 ? "var(--red)" : "var(--amber)" }}>{fmt2(mins)}:{fmt2(secs)}</span>
        <span style={{ fontSize: 12, color: "var(--text-2)" }}>remaining</span>
      </div>
      <div style={{ marginBottom: 24, padding: "32px 20px" }}>
        <p style={{ textAlign: "center", fontSize: 14, color: "var(--text-2)", marginBottom: 24 }}>{locked ? `🔒 Unlocks in ${fmt2(Math.floor(unlockInMs / 60000))}:${fmt2(Math.floor((unlockInMs % 60000) / 1000))} — stay awake` : "Slide all the way to confirm"}</p>
        <div style={{ position: "relative", height: 64, background: solved ? "var(--green-glow)" : error ? "var(--red-glow)" : "var(--surface)", border: `1.5px solid ${solved ? "var(--green)" : error ? "var(--red)" : "var(--border-2)"}`, borderRadius: 32, overflow: "hidden", animation: error ? "shake 0.5s ease" : "none" }}>
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", paddingLeft: dragX + 48, fontSize: 13, color: solved ? "var(--green)" : "var(--text-3)", pointerEvents: "none", transition: "none" }}>
            {solved ? "✓ Confirmed!" : "→ Slide to confirm"}
          </div>
          <div
            style={{ position: "absolute", top: 8, left: 8 + dragX, width: 48, height: 48, borderRadius: 24, background: solved ? "var(--green)" : "var(--amber)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, cursor: dragging ? "grabbing" : "grab", userSelect: "none", transition: dragging ? "none" : "left 0.3s ease", boxShadow: "var(--shadow-sm)" }}
            onMouseDown={(e) => { setDragging(true); const startX = e.clientX - dragX; const onMove = (me: MouseEvent) => setDragX(Math.max(0, Math.min(240, me.clientX - startX))); const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); handleDragEnd(); }; document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp); }}
            onTouchStart={(e) => { setDragging(true); const startX = e.touches[0].clientX - dragX; const onMove = (te: TouchEvent) => setDragX(Math.max(0, Math.min(240, te.touches[0].clientX - startX))); const onEnd = () => { document.removeEventListener("touchmove", onMove); document.removeEventListener("touchend", onEnd); handleDragEnd(); }; document.addEventListener("touchmove", onMove); document.addEventListener("touchend", onEnd); }}
          >
            {solved ? "✓" : "→"}
          </div>
        </div>
      </div>
      {confirming && <p style={{ textAlign: "center", fontSize: 13, color: "var(--text-3)" }}>Confirming with server…</p>}
    </div>
  );
}

/* ─── ROUND TWO ────────────────────────────────────────────────────── */
// FIX 5: onFailed stabilized via ref
function RoundTwo({ config, onConfirm, onFailed }: {
  config: SessionConfig;
  onConfirm: () => void;
  onFailed: () => void;
}) {
  const { remaining, mins, secs, done } = useTimer(8 * 60 * 1000, true);
  const onFailedRef = useRef(onFailed);
  useEffect(() => { onFailedRef.current = onFailed; }, [onFailed]);

  useEffect(() => {
    if (done) onFailedRef.current();
  }, [done]);

  const [confirming, setConfirming] = useState(false);

  const handleConfirm = async () => {
    setConfirming(true);
    try {
      await api.confirmAwake(config.sessionId, config.confirmToken);
      onConfirm();
    } catch { setConfirming(false); }
  };

  return (
    <div style={{ padding: "24px 20px 100px", minHeight: "100vh", animation: "alarmFlash 1.5s ease-in-out infinite" }}>
      <div style={{ textAlign: "center", marginBottom: 24, padding: "24px", background: "var(--red-glow)", border: "1px solid rgba(255,69,69,0.44)", borderRadius: "var(--r-xl)" }}>
        <div style={{ fontSize: 56, animation: "shake 0.4s ease infinite", marginBottom: 8 }}>🚨</div>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: 28, fontWeight: 800, color: "var(--red)", letterSpacing: "-0.03em", marginBottom: 6 }}>ROUND 2</h2>
        <p style={{ fontSize: 14, color: "var(--text-2)", lineHeight: 1.6 }}>All friends have been called. Confirm you're awake.</p>
      </div>
      <div style={{ textAlign: "center", marginBottom: 24, padding: "10px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--r-md)" }}>
        <span style={{ fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 700, color: "var(--red)" }}>{fmt2(mins)}:{fmt2(secs)}</span>
        <span style={{ fontSize: 12, color: "var(--text-2)" }}> until session fails</span>
      </div>
      <button onClick={handleConfirm} disabled={confirming} style={{ width: "100%", padding: "20px", background: "var(--amber)", borderRadius: "var(--r-xl)", border: "none", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 700, color: "#0a0b0f", marginBottom: 12, animation: "pulse-ring 1.5s ease-in-out infinite" }}>
        {confirming ? "Confirming…" : "✓ I'm Awake — Confirm"}
      </button>
    </div>
  );
}

/* ─── DEBRIEF ─────────────────────────────────────────────────────── */
function Debrief({ config, success, saverName, onDone }: {
  config: SessionConfig;
  success: boolean;
  saverName: string | null;
  onDone: () => void;
}) {
  const [phase, setPhase] = useState(1);
  useEffect(() => { const t = setTimeout(() => setPhase(2), 1100); return () => clearTimeout(t); }, []);
  const now = new Date();
  const confirmTime = now.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });
  const saver = saverName ?? config.friendNames[0] ?? null;
  const sentence = success
    ? `${saver ? `${saver} saved you` : "You woke up"} at ${confirmTime}. Round 1. Together.`
    : "Roundup tried everything. The crew gave it all they had.";
  const reasons: { id: WakeReason; label: string; icon: string }[] = [
    { id: "EXAM", label: "Exam", icon: "📝" },
    { id: "FLIGHT", label: "Flight", icon: "✈️" },
    { id: "MEETING", label: "Meeting", icon: "💼" },
    { id: "WORKOUT", label: "Workout", icon: "🏋️" },
    { id: "OTHER", label: "Other", icon: "⏰" },
  ];

  return (
    <div style={{ padding: "0 0 100px", background: "#0c0e18", minHeight: "100vh", animation: "fadeIn 0.5s ease" }}>
      <div style={{ padding: "48px 24px 28px", textAlign: "center", borderBottom: "1px solid var(--border)" }}>
        <div style={{ fontSize: 80, marginBottom: 20, animation: "celebrationPop 0.7s cubic-bezier(0.34,1.56,0.64,1)" }}>{success ? "🎉" : "😴"}</div>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 12, fontWeight: 500, color: "var(--text-3)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 16 }}>{success ? "Session complete" : "Session ended"}</div>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 21, fontWeight: 700, lineHeight: 1.5, letterSpacing: "-0.02em", color: success ? "var(--amber)" : "var(--text-2)", marginBottom: 12 }}>"{sentence}"</div>
        <div style={{ fontSize: 12, color: "var(--text-3)" }}>{now.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}</div>
      </div>
      {phase >= 2 && (
        <div style={{ padding: "20px 20px 0", animation: "fadeUp 0.55s ease" }}>
          <div style={{ fontSize: 11, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Session card</div>
          <div style={{ background: "var(--surface)", borderLeft: "4px solid var(--amber)", border: "1px solid var(--border-2)", borderRadius: "var(--r-lg)", padding: "18px 18px 14px", marginBottom: 8 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <span style={{ fontFamily: "var(--font-display)", fontSize: 13, fontWeight: 700, color: "var(--amber)" }}>Roundup</span>
              {success ? <Badge type="green">✓ Woke up</Badge> : <Badge type="red">✗ Failed</Badge>}
            </div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 15, fontWeight: 600, lineHeight: 1.5, marginBottom: 14 }}>"{sentence}"</div>
            <div style={{ display: "flex", gap: 20, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
              {[{ k: "Wake", v: config.wakeTimeStr }, { k: "Rounds", v: "R1" }, { k: "Result", v: success ? "✓" : "✗" }].map((s, i) => (
                <div key={i}><div style={{ fontSize: 10, color: "var(--text-3)", marginBottom: 2 }}>{s.k}</div><div style={{ fontSize: 13, fontWeight: 600 }}>{s.v}</div></div>
              ))}
            </div>
          </div>
          {success && saver && (
            <div style={{ padding: "14px", background: "var(--green-glow)", border: "1px solid rgba(46,204,113,0.33)", borderRadius: "var(--r-md)", display: "flex", alignItems: "center", gap: 14, marginBottom: 14, marginTop: 14 }}>
              <div style={{ width: 48, height: 48, borderRadius: "50%", background: "var(--green-glow)", border: "1.5px solid rgba(46,204,113,0.44)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24 }}>🌟</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, color: "var(--text-2)", marginBottom: 2 }}>Saved by</div>
                <div style={{ fontFamily: "var(--font-display)", fontSize: 17, fontWeight: 700 }}>{saver}</div>
              </div>
            </div>
          )}
          <button onClick={onDone} style={{ ...pBtn, marginTop: 20 }}>Done ✓</button>
        </div>
      )}
    </div>
  );
}

/* ─── HISTORY SCREEN ─────────────────────────────────────────────── */
function HistoryScreen({ sessions, loading, hasMore, onLoadMore }: {
  sessions: SessionHistoryItem[];
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
}) {
  const totalSuccess = sessions.filter((s) => s.status === "CONFIRMED").length;
  const successRate = sessions.length > 0 ? Math.round((totalSuccess / sessions.length) * 100) : 0;

  return (
    <div style={{ padding: "24px 20px 100px", animation: "fadeUp 0.4s ease" }}>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 700, marginBottom: 20 }}>History</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 24 }}>
        {[
          { label: "Sessions", val: String(sessions.length), icon: "📅" },
          { label: "Success rate", val: `${successRate}%`, icon: "✅" },
          { label: "Total rounds", val: String(sessions.reduce((a, s) => a + s.roundsEscalated, 0)), icon: "🔔" },
        ].map((s, i) => (
          <div key={i} style={{ background: "var(--surface)", borderRadius: "var(--r-md)", border: "1px solid var(--border)", padding: "14px 12px" }}>
            <div style={{ fontSize: 22, marginBottom: 6 }}>{s.icon}</div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--amber)" }}>{s.val}</div>
            <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 2 }}>{s.label}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>Sessions</div>
      {loading && sessions.length === 0 && (
        <div style={{ textAlign: "center", color: "var(--text-3)", padding: 24 }}>Loading…</div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {sessions.map((s, i) => (
          <div key={s.id} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: "16px", display: "flex", alignItems: "center", gap: 14, animation: `fadeUp 0.3s ease ${i * 0.07}s both` }}>
            <div style={{ width: 44, height: 44, borderRadius: "50%", flexShrink: 0, background: s.status === "CONFIRMED" ? "var(--green-glow)" : "var(--red-glow)", border: `1.5px solid ${s.status === "CONFIRMED" ? "var(--green)" : "var(--red)"}44`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>
              {s.status === "CONFIRMED" ? "✓" : "✗"}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 2 }}>
                {s.primaryWatcher ? `Woken by ${s.primaryWatcher.name.split(" ")[0]}` : "No watcher — failed"}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-2)" }}>
                {new Date(s.wakeAt).toLocaleDateString("en-IN", { month: "short", day: "numeric" })} · {new Date(s.wakeAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true })}
                {s.reason && <span style={{ color: "var(--amber)" }}> · {s.reason.toLowerCase()}</span>}
              </div>
            </div>
            <Badge type={s.status === "CONFIRMED" ? "green" : "red"}>R{s.roundsEscalated + 1}</Badge>
          </div>
        ))}
        {sessions.length === 0 && !loading && (
          <div style={{ padding: "32px", textAlign: "center", color: "var(--text-3)", fontSize: 14 }}>No sessions yet. Go to sleep!</div>
        )}
        {hasMore && (
          <button onClick={onLoadMore} disabled={loading} style={{ width: "100%", padding: "14px", borderRadius: "var(--r-md)", background: "var(--surface)", border: "1px solid var(--border-2)", color: "var(--text-2)", fontSize: 13, cursor: loading ? "default" : "pointer", opacity: loading ? 0.6 : 1, fontFamily: "var(--font-body)", marginTop: 4 }}>
            {loading ? "Loading…" : "Load more sessions"}
          </button>
        )}
      </div>
    </div>
  );
}

/* ─── FRIENDS SCREEN ─────────────────────────────────────────────── */
function FriendsScreen({ friends, loading, friendsError, onRetryFriends, onAddFriend, onDelete }: {
  friends: FriendPublic[];
  loading: boolean;
  friendsError: boolean;
  onRetryFriends: () => void;
  onAddFriend: () => void;
  onDelete: (id: string) => void;
}) {
  type FriendExtended = FriendPublic & { telegramDisconnected?: boolean };
  const extFriends = friends as FriendExtended[];

  return (
    <div style={{ padding: "24px 20px 100px", animation: "fadeUp 0.4s ease" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 700 }}>Your crew</h2>
        <button onClick={onAddFriend} style={{ padding: "8px 14px", borderRadius: 20, background: "var(--amber-glow)", border: "1px solid var(--amber)", color: "var(--amber)", fontSize: 13, fontWeight: 500, cursor: "pointer" }}>+ Add</button>
      </div>
      {friendsError && (
        <div style={{ padding: "20px", textAlign: "center", background: "rgba(255,69,69,0.07)", border: "1px solid rgba(255,69,69,0.2)", borderRadius: "var(--r-lg)", marginBottom: 16 }}>
          <div style={{ fontSize: 13, color: "var(--red)", marginBottom: 8 }}>Failed to load crew</div>
          <button onClick={onRetryFriends} style={{ padding: "8px 16px", borderRadius: 20, background: "transparent", border: "1px solid var(--red)", color: "var(--red)", fontSize: 12, cursor: "pointer" }}>↺ Retry</button>
        </div>
      )}
      {loading && !friendsError && <div style={{ textAlign: "center", color: "var(--text-3)", padding: 24 }}>Loading…</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {extFriends.map((f, i) => (
          <div key={f.id} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: "16px", animation: `fadeUp 0.3s ease ${i * 0.06}s both` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
              <Avatar name={f.name} id={f.id} size={44} online={f.telegramLinked} />
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                  <span style={{ fontSize: 15, fontWeight: 600 }}>{f.name}</span>
                  {f.telegramLinked && <Badge type="tg">✈️ Linked</Badge>}
                  {f.telegramDisconnected && (
                    <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 10, background: "rgba(255,69,69,0.12)", color: "var(--red)", border: "1px solid rgba(255,69,69,0.3)" }}>
                      ⚠ Telegram disconnected
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-2)" }}>
                  ⚡ {f.totalSaves} saves · 👀 {f.totalWatches} watches
                </div>
              </div>
            </div>
            {!f.telegramLinked && !f.telegramDisconnected && (
              <div style={{ padding: "10px 12px", background: "rgba(41,182,246,0.08)", border: "1px solid rgba(41,182,246,0.25)", borderRadius: "var(--r-md)", marginBottom: 8 }}>
                <div style={{ fontSize: 12, color: "#29b6f6", marginBottom: 4 }}>Telegram not linked yet</div>
                <div style={{ fontSize: 11, color: "var(--text-3)" }}>
                  Share this link: <span style={{ color: "#29b6f6", fontFamily: "monospace" }}>t.me/roundupbot?start=friend_{f.linkToken.slice(0, 8)}…</span>
                </div>
              </div>
            )}
            {f.telegramDisconnected && (
              <div style={{ padding: "10px 12px", background: "rgba(255,69,69,0.07)", border: "1px solid rgba(255,69,69,0.2)", borderRadius: "var(--r-md)", marginBottom: 8 }}>
                <div style={{ fontSize: 12, color: "var(--red)", marginBottom: 4 }}>Telegram link broken</div>
                <div style={{ fontSize: 11, color: "var(--text-3)" }}>They blocked the bot. Send a new invite link so they can re-link.</div>
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => navigator.clipboard?.writeText(`https://t.me/${process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || "roundupbot"}?start=friend_${f.linkToken}`).catch(() => {})}
                style={{ flex: 1, padding: "8px", borderRadius: "var(--r-sm)", background: "var(--surface-2)", border: "1px solid var(--border-2)", color: "var(--text-2)", fontSize: 12, cursor: "pointer" }}
              >
                📋 Copy invite
              </button>
              <button onClick={() => onDelete(f.id)} style={{ padding: "8px 12px", borderRadius: "var(--r-sm)", background: "transparent", border: "1px solid rgba(255,69,69,0.3)", color: "var(--red)", fontSize: 12, cursor: "pointer" }}>✗</button>
            </div>
          </div>
        ))}
        {friends.length === 0 && !loading && !friendsError && (
          <div style={{ padding: "32px", textAlign: "center", color: "var(--text-3)", fontSize: 14, border: "1px dashed var(--border-2)", borderRadius: "var(--r-lg)" }}>
            No friends yet. Add your crew to get started!
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── SETTINGS SCREEN ────────────────────────────────────────────── */
function SettingsScreen({ userProfile, onLinkTelegram, onSignOut }: {
  userProfile: { name: string; email: string; telegramChatId: string | null; telegramUsername: string | null } | null;
  onLinkTelegram: () => void;
  onSignOut: () => void;
}) {
  return (
    <div style={{ padding: "24px 20px 100px", animation: "fadeUp 0.4s ease" }}>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 700, marginBottom: 20 }}>Settings</h2>
      {userProfile && (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: "16px", marginBottom: 20 }}>
          <div style={{ fontSize: 11, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Account</div>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 2 }}>{userProfile.name}</div>
          <div style={{ fontSize: 13, color: "var(--text-2)" }}>{userProfile.email}</div>
        </div>
      )}
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", padding: "16px", marginBottom: 20 }}>
        <div style={{ fontSize: 11, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>Telegram</div>
        {userProfile?.telegramChatId ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 18 }}>✈️</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: "#29b6f6" }}>Linked</div>
              {userProfile.telegramUsername && <div style={{ fontSize: 11, color: "var(--text-3)" }}>@{userProfile.telegramUsername}</div>}
            </div>
            <Badge type="tg">✓ Active</Badge>
          </div>
        ) : (
          <button onClick={onLinkTelegram} style={{ width: "100%", padding: "12px", borderRadius: "var(--r-md)", background: "rgba(41,182,246,0.1)", border: "1px solid rgba(41,182,246,0.3)", color: "#29b6f6", fontSize: 14, cursor: "pointer" }}>
            ✈️ Link Telegram for alerts
          </button>
        )}
      </div>
      <button onClick={onSignOut} style={{ width: "100%", padding: "14px", borderRadius: "var(--r-md)", background: "transparent", border: "1px solid rgba(255,69,69,0.3)", color: "var(--red)", fontSize: 14, cursor: "pointer", fontFamily: "var(--font-body)" }}>
        Sign out
      </button>
    </div>
  );
}

/* ─── TELEGRAM SETUP ─────────────────────────────────────────────── */
// FIX 6: onLinked now refetches profile so UI updates immediately after linking
function TelegramSetup({ userProfile, onBack, onLinked }: {
  userProfile: Awaited<ReturnType<typeof api.getUserProfile>>;
  onBack: () => void;
  onLinked: () => void;
}) {
  const botUsername = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || "roundupbot";
  const payload = userProfile.id ?? "";
  const link = `https://t.me/${botUsername}?start=user_${payload}`;
  const [checking, setChecking] = useState(false);
  const [pollCount, setPollCount] = useState(0);

  // FIX: Poll for up to 2 minutes after user taps "I've linked it"
  // so we can detect the Telegram link without requiring a page refresh
  const handleLinked = useCallback(async () => {
    setChecking(true);
    let attempts = 0;
    const maxAttempts = 30; // 30 × 2s = 60s total, but 2s intervals feel instant

    const poll = async (): Promise<void> => {
      try {
        const profile = await api.getUserProfile();
        if (profile.telegramChatId) {
          setChecking(false);
          onLinked();
          return;
        }
      } catch { /* ignore network errors — keep polling */ }
      attempts++;
      setPollCount(attempts);
      if (attempts < maxAttempts) {
        await new Promise((r) => setTimeout(r, 2000));
        return poll();
      }
      // Timed out — don't leave user stuck; proceed anyway
      setChecking(false);
      onLinked();
    };
    poll();
  }, [onLinked]);

  return (
    <div style={{ padding: "24px 20px 60px", animation: "fadeUp 0.4s ease" }}>
      <button onClick={onBack} style={{ marginBottom: 24, background: "none", border: "none", color: "var(--text-3)", cursor: "pointer", fontSize: 14 }}>← Back</button>
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <div style={{ fontSize: 64, marginBottom: 16 }}>✈️</div>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: 26, fontWeight: 800, marginBottom: 8 }}>Link Telegram</h2>
        <p style={{ fontSize: 14, color: "var(--text-2)", lineHeight: 1.7 }}>Roundup sends your alarm and wake confirmations through Telegram. Free, instant, reliable.</p>
      </div>
      <div style={{ background: "var(--surface)", border: "1px solid var(--border-2)", borderRadius: "var(--r-xl)", padding: "24px", marginBottom: 20 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {["Open the link below in Telegram", "Hit START in the bot", "Come back here — done!"].map((step, i) => (
            <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
              <div style={{ width: 28, height: 28, borderRadius: "50%", background: "var(--amber)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-display)", fontSize: 14, fontWeight: 700, color: "#0a0b0f", flexShrink: 0 }}>{i + 1}</div>
              <div style={{ fontSize: 14, color: "var(--text)", paddingTop: 4 }}>{step}</div>
            </div>
          ))}
        </div>
      </div>
      <a href={link} target="_blank" rel="noopener noreferrer" style={{ display: "block", width: "100%", padding: "16px", background: "#29b6f6", borderRadius: "var(--r-lg)", textAlign: "center", color: "#fff", fontSize: 16, fontWeight: 700, fontFamily: "var(--font-display)", textDecoration: "none", marginBottom: 12 }}>
        ✈️ Open @{botUsername}
      </a>
      <button onClick={handleLinked} disabled={checking} style={{ width: "100%", padding: "14px", borderRadius: "var(--r-md)", background: checking ? "var(--surface-3)" : "var(--surface-2)", border: "1px solid var(--border-2)", color: checking ? "var(--text-3)" : "var(--text-2)", fontSize: 14, cursor: checking ? "default" : "pointer", transition: "all 0.2s" }}>
        {checking ? `Checking… (${pollCount * 2}s)` : "✓ I've linked it — done"}
      </button>
      {checking && (
        <div style={{ marginTop: 10, textAlign: "center" }}>
          <p style={{ fontSize: 11, color: "var(--text-3)", marginBottom: pollCount >= 8 ? 10 : 0 }}>
            Open the bot above → tap <strong style={{ color: "var(--text-2)" }}>Start</strong> → come back here
          </p>
          {pollCount >= 8 && (
            <button
              onClick={() => { setChecking(false); onLinked(); }}
              style={{ padding: "6px 18px", borderRadius: 20, background: "transparent", border: "1px solid var(--border-2)", color: "var(--text-3)", fontSize: 12, cursor: "pointer", fontFamily: "var(--font-body)" }}
            >
              Skip for now →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── ADD FRIEND MODAL ────────────────────────────────────────────── */
function AddFriendModal({ onClose, onAdded, showToast }: {
  onClose: () => void;
  onAdded: (friend: FriendPublic, inviteLink: string) => void;
  showToast: (msg: string, type?: string) => void;
}) {
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState<{ friend: FriendPublic; inviteLink: string } | null>(null);

  const handleAdd = async () => {
    if (!name.trim()) return;
    setLoading(true);
    try {
      const result = await api.createFriend({ name: name.trim() });
      setDone(result);
      onAdded(result.friend, result.inviteLink);
    } catch {
      showToast("Failed to add friend", "error");
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <div style={{ padding: "0 20px 40px" }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🎉</div>
          <h3 style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 700, marginBottom: 8 }}>{done.friend.name} added!</h3>
          <p style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.6 }}>Share this Telegram link so they can join your crew. Once they tap Start, they're linked.</p>
        </div>
        <div style={{ background: "var(--surface)", border: "1px solid var(--border-2)", borderRadius: "var(--r-md)", padding: "14px", marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 4 }}>Telegram invite link</div>
          <div style={{ fontSize: 12, color: "#29b6f6", fontFamily: "monospace", wordBreak: "break-all" }}>{done.inviteLink}</div>
        </div>
        <button
          onClick={() => { navigator.clipboard?.writeText(done.inviteLink).catch(() => {}); showToast("Link copied!", "success"); }}
          style={{ width: "100%", padding: "12px", borderRadius: "var(--r-md)", background: "var(--amber)", border: "none", cursor: "pointer", color: "#0a0b0f", fontWeight: 700, fontFamily: "var(--font-display)", marginBottom: 10 }}
        >
          📋 Copy invite link
        </button>
        <button onClick={onClose} style={{ width: "100%", padding: "12px", borderRadius: "var(--r-md)", background: "transparent", border: "1px solid var(--border-2)", color: "var(--text-2)", cursor: "pointer" }}>Done</button>
      </div>
    );
  }

  return (
    <div style={{ padding: "0 20px 40px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <h3 style={{ fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 700 }}>Add a friend</h3>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-3)", cursor: "pointer", fontSize: 22 }}>×</button>
      </div>
      <p style={{ fontSize: 13, color: "var(--text-2)", marginBottom: 20 }}>You'll get a Telegram link to share with them. No app install needed on their end.</p>
      <input type="text" placeholder="Friend's name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleAdd()} style={{ marginBottom: 16 }} />
      <button onClick={handleAdd} disabled={loading || !name.trim()} style={{ ...pBtn, opacity: loading || !name.trim() ? 0.5 : 1 }}>
        {loading ? "Adding…" : "Add friend →"}
      </button>
    </div>
  );
}

/* ─── ROOT APP ────────────────────────────────────────────────────── */
const SESSION_STORAGE_KEY = "roundup_active_session";

export default function RoundupApp() {
  const { supabase, user, loading: authLoading } = useSupabase();
  const [screen, setScreen] = useState("home");
  const [sessionConfig, setSessionConfigState] = useState<SessionConfig | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);
  const [success, setSuccess] = useState(true);
  const [saverName, setSaverName] = useState<string | null>(null);
  const [showAddFriend, setShowAddFriend] = useState(false);

  const [friends, setFriends] = useState<FriendPublic[]>([]);
  const [sessions, setSessions] = useState<SessionHistoryItem[]>([]);
  const [userProfile, setUserProfile] = useState<Awaited<ReturnType<typeof api.getUserProfile>> | null>(null);
  const [healthOk, setHealthOk] = useState<boolean | null>(null);
  const [dataLoading, setDataLoading] = useState(true);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [friendsError, setFriendsError] = useState(false);

  const showToast = useCallback((msg: string, type = "info") => setToast({ msg, type }), []);
  const nav = useCallback((to: string) => setScreen(to), []);

  const saveSessionConfig = useCallback((config: SessionConfig | null) => {
    setSessionConfigState(config);
    try {
      if (config) {
        sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(config));
      } else {
        sessionStorage.removeItem(SESSION_STORAGE_KEY);
      }
    } catch { }
  }, []);

  // FIX 7: Session restore on hard refresh — properly maps all server statuses to screens
  useEffect(() => {
    if (authLoading || !user) return;
    try {
      const saved = sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (!saved) return;
      const config: SessionConfig = JSON.parse(saved);
      api.getSessionStatus(config.sessionId)
        .then((status) => {
          if (status.status === "SCHEDULED") {
            setSessionConfigState(config);
            setScreen("session_active");
          } else if (status.status === "ALARM_FIRED") {
            setSessionConfigState(config);
            setScreen("first_confirm");
          } else if (status.status === "FIRST_CONFIRMED") {
            setSessionConfigState(config);
            setScreen("second_confirm");
          } else if (status.status === "ROUND_TWO") {
            setSessionConfigState(config);
            setScreen("round_two");
          } else {
            // CONFIRMED, FAILED, CANCELLED — session is over
            sessionStorage.removeItem(SESSION_STORAGE_KEY);
          }
        })
        .catch(() => { sessionStorage.removeItem(SESSION_STORAGE_KEY); });
    } catch { }
  }, [authLoading, user]);

  useEffect(() => {
    if (authLoading || !user) return;
    const load = async () => {
      setDataLoading(true);
      setFriendsError(false);
      try {
        const [profileResult, friendsResult, healthResult, sessionsResult] = await Promise.allSettled([
          api.getUserProfile(),
          api.getFriends(),
          api.getHealth(),
          api.getSessions(5),
        ]);
        if (profileResult.status === "fulfilled") {
          setUserProfile(profileResult.value);
          // Keep the timezone used in Telegram messages in step with the browser's.
          const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
          if (browserTz && browserTz !== profileResult.value.timezone) {
            api.updateTimezone(browserTz)
              .then((r) => setUserProfile((p) => (p ? { ...p, timezone: r.timezone } : p)))
              .catch(() => { /* non-critical */ });
          }
        }
        if (friendsResult.status === "fulfilled") {
          setFriends(friendsResult.value.friends);
          setFriendsError(false);
        } else {
          setFriendsError(true);
        }
        if (healthResult.status === "fulfilled") setHealthOk(healthResult.value.ok);
        if (sessionsResult.status === "fulfilled") setSessions(sessionsResult.value.sessions);
      } finally {
        setDataLoading(false);
      }
    };
    load();
  }, [authLoading, user]);

  useEffect(() => {
    if (screen !== "history" || !user) return;
    setSessionsLoading(true);
    api.getSessions(20)
      .then((r) => {
        setSessions(r.sessions);
        setHistoryCursor(r.nextCursor);
        setHistoryHasMore(!!r.nextCursor);
      })
      .catch(() => {})
      .finally(() => setSessionsLoading(false));
  }, [screen, user]);

  const handleLoadMoreHistory = useCallback(async () => {
    if (!historyCursor || sessionsLoading) return;
    setSessionsLoading(true);
    try {
      const r = await api.getSessions(20, historyCursor);
      setSessions((prev) => [...prev, ...r.sessions]);
      setHistoryCursor(r.nextCursor);
      setHistoryHasMore(!!r.nextCursor);
    } catch {
      showToast("Failed to load more sessions", "error");
    } finally {
      setSessionsLoading(false);
    }
  }, [historyCursor, sessionsLoading, showToast]);

  const retryLoadFriends = useCallback(() => {
    setFriendsError(false);
    setDataLoading(true);
    api.getFriends()
      .then((r) => { setFriends(r.friends); })
      .catch(() => setFriendsError(true))
      .finally(() => setDataLoading(false));
  }, []);

  // FIX 8: All stable useCallback handlers so child useEffects don't re-run on every render
  const handleAlarmFired = useCallback(() => setScreen("first_confirm"), []);

  const handleFirstConfirmDone = useCallback(() => {
    showToast("Good — confirming again in 3 min", "info");
    setScreen("second_confirm");
  }, [showToast]);

  const handleRoundTwo = useCallback(() => setScreen("round_two"), []);

  const handleSecondConfirmed = useCallback((name: string | null) => {
    setSuccess(true);
    setSaverName(name);
    showToast("You're awake! Crew notified 🎉", "success");
    setTimeout(() => setScreen("debrief"), 400);
  }, [showToast]);

  const handleSecondConfirmFailed = useCallback(() => setScreen("round_two"), []);

  const handleRoundTwoConfirm = useCallback(() => setScreen("second_confirm"), []);

  const handleRoundTwoFailed = useCallback(() => {
    setSuccess(false);
    setScreen("debrief");
  }, []);

  const handleDebriefDone = useCallback(() => {
    setScreen("home");
    saveSessionConfig(null);
    setSaverName(null);
  }, [saveSessionConfig]);

  // FIX 9: Telegram linked — immediately refetch profile so banner updates
  const handleTelegramLinked = useCallback(() => {
    showToast("Telegram linked! ✈️", "success");
    setScreen("settings");
    api.getUserProfile()
      .then((p) => setUserProfile(p))
      .catch(() => {});
  }, [showToast]);

  const handleSleep = useCallback(async (cfg: {
    hour: number; minute: number; ampm: string;
    selectedFriendIds: string[]; reason: WakeReason | null;
    privacy: PrivacyMode; openWatch: boolean;
  }) => {
    unlockAudio(); // pre-unlock AudioContext on this user gesture so alarm can play later
    const now = new Date();
    let h = cfg.hour;
    if (cfg.ampm === "PM" && h !== 12) h += 12;
    if (cfg.ampm === "AM" && h === 12) h = 0;
    const wakeDate = new Date(now);
    wakeDate.setHours(h, cfg.minute, 0, 0);
    if (wakeDate <= now) wakeDate.setDate(wakeDate.getDate() + 1);

    const wakeTimeStr = `${cfg.hour}:${fmt2(cfg.minute)} ${cfg.ampm}`;

    try {
      const result = await api.createSession({
        wakeAt: wakeDate.toISOString(),
        friendIds: cfg.selectedFriendIds,
        reason: cfg.reason ?? undefined,
        privacyMode: cfg.privacy,
        openWatchLink: cfg.openWatch,
      });

      const selectedFriends = friends.filter((f) => cfg.selectedFriendIds.includes(f.id));
      const config: SessionConfig = {
        sessionId: result.sessionId,
        confirmToken: result.confirmToken,
        wakeTimeStr,
        wakeAt: wakeDate.toISOString(),
        selectedFriends: cfg.selectedFriendIds,
        friendNames: selectedFriends.map((f) => f.name),
        reason: cfg.reason ?? undefined,
        privacyMode: cfg.privacy,
        openWatchToken: result.openWatchToken,
      };

      saveSessionConfig(config);
      if (result.reachableWatchers !== undefined && result.reachableWatchers < result.watcherCount) {
        showToast(
          result.reachableWatchers === 0
            ? "Session created — but none of your friends have linked Telegram, so nobody can be alerted."
            : `Session created — only ${result.reachableWatchers} of ${result.watcherCount} friends can be alerted (the rest haven't linked Telegram).`,
          "error"
        );
      } else {
        showToast("Session created — crew notified 🌙", "success");
      }
      setScreen("session_active");
    } catch (e) {
      if (e instanceof api.NetworkError) {
        showToast("No connection — check your internet and try again.", "error");
      } else {
        showToast("Failed to create session. Try again.", "error");
      }
    }
  }, [friends, saveSessionConfig, showToast]);

  const handleCancel = useCallback(async () => {
    if (!sessionConfig) return;
    try {
      await api.cancelSession(sessionConfig.sessionId);
      showToast("Session cancelled");
      setScreen("home");
      saveSessionConfig(null);
    } catch (e) {
      if (e instanceof api.NetworkError) {
        showToast("No connection — session cancel may not have reached the server.", "error");
      } else {
        showToast("Failed to cancel", "error");
      }
    }
  }, [sessionConfig, showToast, saveSessionConfig]);

  const handleDeleteFriend = useCallback(async (id: string) => {
    try {
      await api.deleteFriend(id);
      setFriends((prev) => prev.filter((f) => f.id !== id));
      showToast("Friend removed");
    } catch (e) {
      if (e instanceof api.ApiError && e.statusCode === 409) {
        showToast("Can't remove — they're watching an active session.", "error");
      } else {
        showToast("Failed to remove friend", "error");
      }
    }
  }, [showToast]);

  const handleSignOut = useCallback(async () => {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }, [supabase]);

  const noNavScreens = ["telegram_setup"];

  if (authLoading) {
    return <div style={{ minHeight: "100vh", background: "#0a0b0f", display: "flex", alignItems: "center", justifyContent: "center", color: "#9099b5" }}>Loading…</div>;
  }

  return (
    <>
      <style>{CSS}</style>
      {toast && <Toast message={toast.msg} type={toast.type} onDone={() => setToast(null)} />}
      <div style={{ maxWidth: 430, margin: "0 auto", minHeight: "100vh", background: "var(--ink)", position: "relative", overflowX: "hidden" }}>

        {screen === "home" && (
          <HomeScreen
            onStart={() => setScreen("sleep_entry")}
            userProfile={userProfile}
            friends={friends}
            sessions={sessions}
            healthOk={healthOk}
            onLinkTelegram={() => setScreen("telegram_setup")}
          />
        )}

        {screen === "sleep_entry" && (
          <SleepEntry onConfirm={handleSleep} onBack={() => setScreen("home")} friends={friends} />
        )}

        {screen === "session_active" && sessionConfig && (
          <ActiveSession
            config={sessionConfig}
            onAlarmFired={handleAlarmFired}
            onCancel={handleCancel}
            friends={friends}
          />
        )}

        {screen === "first_confirm" && sessionConfig && (
          <AlarmFiring
            config={sessionConfig}
            onConfirm={handleFirstConfirmDone}
            onRoundTwo={handleRoundTwo}
          />
        )}

        {screen === "second_confirm" && sessionConfig && (
          <SecondConfirm
            config={sessionConfig}
            onConfirmed={handleSecondConfirmed}
            onFailed={handleSecondConfirmFailed}
          />
        )}

        {screen === "round_two" && sessionConfig && (
          <RoundTwo
            config={sessionConfig}
            onConfirm={handleRoundTwoConfirm}
            onFailed={handleRoundTwoFailed}
          />
        )}

        {screen === "debrief" && sessionConfig && (
          <Debrief
            config={sessionConfig}
            success={success}
            saverName={saverName}
            onDone={handleDebriefDone}
          />
        )}

        {screen === "history" && (
          <HistoryScreen
            sessions={sessions}
            loading={sessionsLoading}
            hasMore={historyHasMore}
            onLoadMore={handleLoadMoreHistory}
          />
        )}

        {screen === "friends" && (
          <FriendsScreen
            friends={friends}
            loading={dataLoading}
            friendsError={friendsError}
            onRetryFriends={retryLoadFriends}
            onAddFriend={() => setShowAddFriend(true)}
            onDelete={handleDeleteFriend}
          />
        )}

        {screen === "settings" && (
          <SettingsScreen
            userProfile={userProfile}
            onLinkTelegram={() => setScreen("telegram_setup")}
            onSignOut={handleSignOut}
          />
        )}

        {screen === "telegram_setup" && userProfile && (
          <TelegramSetup
            userProfile={userProfile}
            onBack={() => setScreen("settings")}
            onLinked={handleTelegramLinked}
          />
        )}

        {!noNavScreens.includes(screen) && <BottomNav screen={screen} onNav={nav} />}

        {showAddFriend && (
          <div style={{ position: "fixed", inset: 0, zIndex: 500, display: "flex", flexDirection: "column", justifyContent: "flex-end", maxWidth: 430, margin: "0 auto" }}>
            <div onClick={() => setShowAddFriend(false)} style={{ flex: 1, background: "rgba(0,0,0,0.5)" }} />
            <div style={{ background: "var(--ink-2)", border: "1px solid var(--border-2)", borderRadius: "var(--r-xl) var(--r-xl) 0 0", animation: "sheetUp 0.35s cubic-bezier(0.4,0,0.2,1)", paddingTop: 16, maxHeight: "80vh", overflowY: "auto" }}>
              <div style={{ width: 36, height: 4, borderRadius: 2, background: "var(--surface-3)", margin: "0 auto 20px" }} />
              <AddFriendModal
                onClose={() => setShowAddFriend(false)}
                onAdded={(friend) => {
                  setFriends((prev) => [...prev, friend]);
                  showToast(`${friend.name} added!`, "success");
                }}
                showToast={showToast}
              />
            </div>
          </div>
        )}
      </div>
    </>
  );
}
