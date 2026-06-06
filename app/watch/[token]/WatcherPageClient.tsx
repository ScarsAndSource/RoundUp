"use client";
// app/watch/[token]/WatcherPageClient.tsx
// Complete watcher UI — no auth, token is the key.
// Phases: waiting → alarming → round_two → saved/ended

import { useState, useEffect, useCallback } from "react";
import type { WatcherPageData } from "@/types";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://roundup.vercel.app";

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=Syne:wght@700;800&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --ink: #0a0b0f; --ink-2: #10121a; --surface: #1e2235; --surface-2: #252a3d;
    --border: rgba(255,255,255,0.07); --border-2: rgba(255,255,255,0.13);
    --amber: #f5a623; --amber-glow: rgba(245,166,35,0.18);
    --red: #ff4545; --red-glow: rgba(255,69,69,0.22);
    --green: #2ecc71; --green-glow: rgba(46,204,113,0.18);
    --text: #e8eaf0; --text-2: #9099b5; --text-3: #5a6280;
    --font-display: 'Syne', sans-serif; --font-body: 'DM Sans', sans-serif;
    --r-md: 14px; --r-lg: 20px; --r-xl: 28px;
  }
  body { font-family: var(--font-body); background: var(--ink); color: var(--text); -webkit-font-smoothing: antialiased; }
  @keyframes fadeUp { from{opacity:0;transform:translateY(16px);} to{opacity:1;transform:translateY(0);} }
  @keyframes fadeIn { from{opacity:0;} to{opacity:1;} }
  @keyframes shake { 0%,100%{transform:translateX(0);} 20%{transform:translateX(-6px);} 40%{transform:translateX(6px);} 60%{transform:translateX(-4px);} 80%{transform:translateX(4px);} }
  @keyframes pulse-ring { 0%,100%{transform:scale(1);opacity:0.7;} 50%{transform:scale(1.08);opacity:0.4;} }
  @keyframes ping { 0%{transform:scale(1);opacity:1;} 75%,100%{transform:scale(2);opacity:0;} }
  @keyframes alarmFlash { 0%,100%{background:var(--ink-2);} 50%{background:rgba(255,69,69,0.15);} }
  @keyframes celebrationPop { 0%{transform:scale(0.3);opacity:0;} 60%{transform:scale(1.15);opacity:1;} 100%{transform:scale(1);opacity:1;} }
  @keyframes sleepFloat { 0%,100%{transform:translateY(0) rotate(-2deg);} 50%{transform:translateY(-10px) rotate(2deg);} }
  @keyframes ticker { 0%,100%{opacity:1;transform:scale(1);} 50%{opacity:0.5;transform:scale(0.95);} }
`;

function fmt2(n: number) { return String(n).padStart(2, "0"); }




const pBtn: React.CSSProperties = {
  width: "100%", padding: "18px 24px", background: "var(--amber)", borderRadius: "var(--r-xl)",
  border: "none", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 700,
  color: "#0a0b0f", letterSpacing: "-0.01em",
};

export default function WatcherPageClient({ token }: { token: string }) {
  const [data, setData] = useState<WatcherPageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [committed, setCommitted] = useState(false);
  const [markedAwake, setMarkedAwake] = useState(false);
  const [actioning, setActioning] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/watch/${token}`);
      if (!res.ok) {
        if (res.status === 404) setError("This watch link doesn't exist or has expired.");
        else setError("Something went wrong. Try refreshing.");
        setLoading(false);
        return;
      }
      const d: WatcherPageData = await res.json();
      setData(d);
      setCommitted(d.committed);
      setMarkedAwake(d.markedAwake);
      setLoading(false);
    } catch {
      setError("Network error. Try refreshing.");
      setLoading(false);
    }
  }, [token]);

  // Initial load + poll every 5 seconds
  useEffect(() => {
    fetchData();
    const iv = setInterval(fetchData, 5000);
    return () => clearInterval(iv);
  }, [fetchData]);

  const handleCommit = async () => {
    setActioning(true);
    try {
      await fetch("/api/watch/commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      setCommitted(true);
    } catch { /* silent */ }
    setActioning(false);
  };

  const handleMarkAwake = async () => {
    setActioning(true);
    try {
      await fetch("/api/watch/mark-awake", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      setMarkedAwake(true);
    } catch { /* silent */ }
    setActioning(false);
  };

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--ink)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <style>{CSS}</style>
        <div style={{ textAlign: "center", color: "var(--text-3)" }}>
          <div style={{ fontSize: 40, marginBottom: 12, animation: "pulse-ring 2s infinite" }}>🌙</div>
          <div style={{ fontSize: 14 }}>Loading…</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--ink)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <style>{CSS}</style>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🔗</div>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 700, marginBottom: 8 }}>Link unavailable</h2>
          <p style={{ color: "var(--text-2)", fontSize: 14 }}>{error}</p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const isEnded = ["CONFIRMED", "FAILED", "CANCELLED"].includes(data.status);
  const isAlarming = ["ALARM_FIRED", "FIRST_CONFIRMED", "ROUND_TWO"].includes(data.status);
  const isRoundTwo = data.status === "ROUND_TWO";

  // ── SAVED state ──────────────────────────────────────────────
  if (markedAwake || data.status === "CONFIRMED") {
    return (
      <div style={{ minHeight: "100vh", background: "var(--ink)", padding: "40px 20px" }}>
        <style>{CSS}</style>
        <div style={{ maxWidth: 430, margin: "0 auto", textAlign: "center" }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 24, fontWeight: 800, marginBottom: 32, color: "var(--text)" }}>
            Round<span style={{ color: "var(--amber)" }}>up</span>
          </div>
          <div style={{ fontSize: 72, marginBottom: 16, animation: "celebrationPop 0.5s ease" }}>🏆</div>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: 28, fontWeight: 800, marginBottom: 12 }}>
            {markedAwake ? `You saved ${data.sleeperName}.` : `${data.sleeperName} is awake!`}
          </h2>
          <p style={{ fontSize: 14, color: "var(--text-2)", marginBottom: 32, lineHeight: 1.7 }}>
            That kind of reliability is rare.<br />Thanks for watching their back.
          </p>
          <div style={{ background: "var(--surface)", border: "1px solid rgba(245,166,35,0.44)", borderRadius: "var(--r-xl)", padding: "24px", marginBottom: 16 }}>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Want someone watching your back too?</div>
            <p style={{ fontSize: 13, color: "var(--text-2)", marginBottom: 16, lineHeight: 1.5 }}>
              Roundup is free. Set up a crew who commits — not just gets notified.
            </p>
            <a href={APP_URL} style={{ display: "block", padding: "14px", background: "var(--amber)", borderRadius: "var(--r-lg)", textAlign: "center", color: "#0a0b0f", fontWeight: 700, fontFamily: "var(--font-display)", fontSize: 15, textDecoration: "none" }}>
              Get my own crew — free →
            </a>
          </div>
        </div>
      </div>
    );
  }

  // ── ENDED / FAILED state ─────────────────────────────────────
  if (isEnded) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--ink)", padding: "40px 20px" }}>
        <style>{CSS}</style>
        <div style={{ maxWidth: 430, margin: "0 auto", textAlign: "center" }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 24, fontWeight: 800, marginBottom: 32 }}>
            Round<span style={{ color: "var(--amber)" }}>up</span>
          </div>
          <div style={{ fontSize: 56, marginBottom: 16 }}>📋</div>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 700, marginBottom: 8 }}>This session has ended</h2>
          <p style={{ fontSize: 14, color: "var(--text-2)", marginBottom: 24 }}>
            {data.status === "CONFIRMED" ? `${data.sleeperName} is awake. All good!` : "The session timed out."}
          </p>
          <a href={APP_URL} style={{ display: "block", padding: "14px", background: "var(--surface)", border: "1px solid var(--border-2)", borderRadius: "var(--r-lg)", textAlign: "center", color: "var(--text-2)", fontSize: 14, textDecoration: "none" }}>
            Open Roundup →
          </a>
        </div>
      </div>
    );
  }

  // ── ALARMING state (RED) ─────────────────────────────────────
  if (isAlarming) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--ink-2)", padding: "0 0 40px", animation: "alarmFlash 2s ease-in-out infinite" }}>
        <style>{CSS}</style>
        <div style={{ maxWidth: 430, margin: "0 auto" }}>
          <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 800 }}>Round<span style={{ color: "var(--amber)" }}>up</span></div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", background: "var(--red-glow)", borderRadius: 20 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--red)", animation: "ping 1s ease-in-out infinite" }} />
              <span style={{ fontSize: 11, color: "var(--red)", fontWeight: 500 }}>ALARM ACTIVE</span>
            </div>
          </div>

          <div style={{ padding: "32px 20px" }}>
            <div style={{ textAlign: "center", padding: "24px", background: "var(--red-glow)", border: "1px solid rgba(255,69,69,0.44)", borderRadius: "var(--r-xl)", marginBottom: 24 }}>
              <div style={{ fontSize: 64, animation: "shake 0.4s ease-in-out infinite", marginBottom: 12 }}>🚨</div>
              <h2 style={{ fontFamily: "var(--font-display)", fontSize: 28, fontWeight: 800, color: "var(--red)", letterSpacing: "-0.03em", marginBottom: 8 }}>
                {isRoundTwo ? "ROUND 2 — CALL NOW" : "ALARM IS RINGING"}
              </h2>
              <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>{data.sleeperName}</div>
              <div style={{ fontSize: 14, color: "var(--text-2)" }}>Wake time: {data.wakeTime}</div>
              {isRoundTwo && <div style={{ marginTop: 10, fontSize: 13, color: "var(--red)", fontWeight: 500 }}>Hasn't confirmed awake. Call them immediately.</div>}
            </div>

            {!committed ? (
              <button onClick={handleCommit} disabled={actioning} style={{ ...pBtn, marginBottom: 12, boxShadow: "0 8px 32px rgba(245,166,35,0.4)" }}>
                {actioning ? "…" : "✓ I'll watch — commit"}
              </button>
            ) : (
              <div style={{ padding: "12px 16px", background: "var(--green-glow)", border: "1px solid rgba(46,204,113,0.33)", borderRadius: "var(--r-md)", marginBottom: 12, fontSize: 13, color: "var(--green)", textAlign: "center" }}>
                ✓ Committed — you'll be notified of updates
              </div>
            )}

            <button onClick={handleMarkAwake} disabled={actioning} style={{ width: "100%", padding: "18px", background: "var(--red)", borderRadius: "var(--r-xl)", border: "none", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 17, fontWeight: 700, color: "#fff", animation: "pulse-ring 1.5s ease-in-out infinite", boxShadow: "0 8px 32px rgba(255,69,69,0.4)" }}>
              {actioning ? "…" : `📞 I've reached ${data.sleeperName} — Mark awake`}
            </button>
            <p style={{ textAlign: "center", fontSize: 11, color: "var(--text-3)", marginTop: 8 }}>Only tap after confirming with {data.sleeperName} directly</p>
          </div>
        </div>
      </div>
    );
  }

  // ── WAITING state (SCHEDULED) ─────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", background: "var(--ink)", padding: "0 0 40px" }}>
      <style>{CSS}</style>
      <div style={{ maxWidth: 430, margin: "0 auto" }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 800 }}>Round<span style={{ color: "var(--amber)" }}>up</span></div>
          <span style={{ fontSize: 12, color: "var(--text-3)", padding: "4px 10px", background: "var(--surface)", borderRadius: 20 }}>Watcher view</span>
        </div>

        <div style={{ padding: "32px 20px", animation: "fadeUp 0.4s ease" }}>
          <div style={{ textAlign: "center", marginBottom: 28 }}>
            <div style={{ fontSize: 64, marginBottom: 14, animation: "sleepFloat 3s ease-in-out infinite" }}>😴</div>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: 24, fontWeight: 700, marginBottom: 8 }}>
              {data.sleeperName} is sleeping.
            </h2>
            <p style={{ fontSize: 14, color: "var(--text-2)", lineHeight: 1.6 }}>
              {committed ? "You've committed. Stay alert." : "Will you commit to watching?"}
            </p>
          </div>

          <div style={{ background: "var(--surface)", border: "1px solid var(--border-2)", borderRadius: "var(--r-xl)", padding: "24px", textAlign: "center", marginBottom: 20 }}>
            <div style={{ fontSize: 12, color: "var(--text-3)", marginBottom: 6 }}>Wake time</div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 48, fontWeight: 800, color: "var(--amber)", letterSpacing: "-0.04em", lineHeight: 1, marginBottom: 6 }}>
              {data.wakeTime}
            </div>
            {data.reason && <div style={{ marginTop: 8, display: "inline-block", padding: "3px 10px", background: "var(--amber-glow)", borderRadius: 20, color: "var(--amber)", fontSize: 12 }}>{data.reason.toLowerCase()}</div>}
          </div>

          {committed ? (
            <div style={{ padding: "12px 14px", background: "var(--green-glow)", border: "1px solid rgba(46,204,113,0.33)", borderRadius: "var(--r-md)", display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <span style={{ fontSize: 18 }}>✓</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--green)" }}>Commitment logged</div>
                <div style={{ fontSize: 11, color: "var(--text-2)", marginTop: 1 }}>{data.sleeperName} knows you're watching</div>
              </div>
            </div>
          ) : (
            <button onClick={handleCommit} disabled={actioning} style={{ ...pBtn, marginBottom: 10, boxShadow: "0 8px 32px rgba(245,166,35,0.35)" }}>
              {actioning ? "…" : "✓ I'll watch — commit"}
            </button>
          )}

          <div style={{ padding: "12px 14px", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", fontSize: 12, color: "var(--text-2)", lineHeight: 1.6 }}>
            This page turns red if {data.sleeperName} doesn't confirm awake by {data.wakeTime}. You'll be asked to call them.
          </div>

          <div style={{ marginTop: 24, padding: "16px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--r-md)" }}>
            <div style={{ fontSize: 13, color: "var(--text-3)", marginBottom: 8 }}>Want your own crew?</div>
            <a href={APP_URL} style={{ color: "#29b6f6", fontSize: 13, textDecoration: "none" }}>Get Roundup free →</a>
          </div>
        </div>
      </div>
    </div>
  );
}
