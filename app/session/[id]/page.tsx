"use client";
// app/session/[id]/page.tsx
// FIX #3: Confirm page opened from Telegram "I'm Awake" button.
// PUBLIC ROUTE — no auth needed. The confirmToken in the URL is the credential.
// Handles the full two-step confirm flow so sleepers who tap the Telegram link
// don't need to have the app open.

import { useState, useEffect } from "react";
import { useSearchParams, useParams } from "next/navigation";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://roundup.vercel.app";

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=Syne:wght@700;800&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --ink: #0a0b0f; --ink-2: #10121a;
    --surface: #1e2235; --surface-2: #252a3d;
    --border: rgba(255,255,255,0.07); --border-2: rgba(255,255,255,0.13);
    --amber: #f5a623; --amber-glow: rgba(245,166,35,0.18);
    --red: #ff4545; --red-glow: rgba(255,69,69,0.22);
    --green: #2ecc71; --green-glow: rgba(46,204,113,0.18);
    --text: #e8eaf0; --text-2: #9099b5; --text-3: #5a6280;
    --font-display: 'Syne', sans-serif; --font-body: 'DM Sans', sans-serif;
    --r-md: 14px; --r-lg: 20px; --r-xl: 28px;
  }
  body { font-family: var(--font-body); background: var(--ink); color: var(--text); -webkit-font-smoothing: antialiased; margin: 0; }
  @keyframes fadeUp { from{opacity:0;transform:translateY(16px);} to{opacity:1;transform:translateY(0);} }
  @keyframes shake { 0%,100%{transform:translateX(0);} 20%{transform:translateX(-6px);} 40%{transform:translateX(6px);} 60%{transform:translateX(-4px);} 80%{transform:translateX(4px);} }
  @keyframes pulse-ring { 0%,100%{transform:scale(1);opacity:0.7;} 50%{transform:scale(1.08);opacity:0.4;} }
  @keyframes alarmFlash { 0%,100%{background:var(--ink-2);} 50%{background:rgba(255,69,69,0.12);} }
  @keyframes celebrationPop { 0%{transform:scale(0.3);opacity:0;} 60%{transform:scale(1.15);opacity:1;} 100%{transform:scale(1);opacity:1;} }
`;

type Phase =
  | "loading"
  | "ready_to_confirm"   // alarm fired, waiting for first tap
  | "second_confirm"     // first confirmed, need second proof
  | "confirmed"          // fully confirmed — done
  | "already_confirmed"  // session already confirmed before we got here
  | "error";

export default function SessionConfirmPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const sessionId = params.id as string;
  const token = searchParams.get("token");

  const [phase, setPhase] = useState<Phase>("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saverName, setSaverName] = useState<string | null>(null);

  // Drag-to-confirm state
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [dragError, setDragError] = useState(false);

  // Second proof is locked for 2 minutes after the first tap (the server enforces the same gap).
  const [confirmedAtMs, setConfirmedAtMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (phase !== "second_confirm") return;
    const iv = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [phase]);
  const unlockInMs =
    confirmedAtMs === null ? 0 : Math.max(0, 2 * 60 * 1000 - (nowMs - confirmedAtMs));
  const locked = unlockInMs > 0;

  useEffect(() => {
    if (!token) {
      setErrorMsg("Confirmation link is missing the token parameter.");
      setPhase("error");
      return;
    }

    // Check current session status to decide which phase to show
    fetch(`/api/sessions/${sessionId}/status?token=${encodeURIComponent(token)}`)
      .then((r) => {
        if (!r.ok) throw new Error("not_found");
        return r.json();
      })
      .then((data) => {
        if (data.status === "CONFIRMED") {
          setPhase("already_confirmed");
        } else if (["ALARM_FIRED", "ROUND_TWO"].includes(data.status)) {
          setPhase("ready_to_confirm");
        } else if (data.status === "FIRST_CONFIRMED") {
          setConfirmedAtMs(data.confirmedAt ? new Date(data.confirmedAt).getTime() : Date.now());
          setPhase("second_confirm");
        } else {
          setErrorMsg(`Session is in state: ${data.status}. Nothing to confirm.`);
          setPhase("error");
        }
      })
      .catch(() => {
        setErrorMsg("Could not load session. The link may have expired.");
        setPhase("error");
      });
  }, [sessionId, token]);

  const handleFirstConfirm = async () => {
    if (confirming) return;
    setConfirming(true);

    try {
      const res = await fetch(`/api/sessions/${sessionId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();

      if (data.error === "ALREADY_CONFIRMED") {
        setPhase("already_confirmed");
      } else if (data.error === "SESSION_ENDED") {
        setErrorMsg("This session already ended (cancelled or timed out). Open Roundup to start a new one.");
        setPhase("error");
      } else if (res.ok) {
        setConfirmedAtMs(Date.now());
        setPhase("second_confirm");
      } else {
        setErrorMsg(data.error || "Something went wrong. Please try again.");
        setPhase("error");
      }
    } catch {
      setErrorMsg("Network error. Check your connection and try again.");
      setPhase("error");
    } finally {
      setConfirming(false);
    }
  };

  const handleSecondConfirm = async () => {
    setConfirming(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/confirm-second`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();

      if (data.error === "TOO_EARLY") {
        setDragX(0);
        setDragError(true);
        setTimeout(() => setDragError(false), 600);
        return;
      }

      if (res.ok || data.alreadyConfirmed) {
        setSaverName(data.saverName ?? null);
        setPhase("confirmed");
      } else {
        setErrorMsg(data.error || "Something went wrong. Please try again.");
        setPhase("error");
      }
    } catch {
      setErrorMsg("Network error. Check your connection and try again.");
      setPhase("error");
    } finally {
      setConfirming(false);
    }
  };

  const handleDragEnd = async () => {
    setDragging(false);
    if (locked) {
      setDragX(0);
      setDragError(true);
      setTimeout(() => setDragError(false), 600);
    } else if (dragX > 210) {
      await handleSecondConfirm();
    } else {
      setDragX(0);
      setDragError(true);
      setTimeout(() => setDragError(false), 600);
    }
  };

  const pBtn: React.CSSProperties = {
    width: "100%",
    padding: "20px 24px",
    background: "var(--amber)",
    borderRadius: "var(--r-xl)",
    border: "none",
    cursor: "pointer",
    fontFamily: "var(--font-display)",
    fontSize: 18,
    fontWeight: 700,
    color: "#0a0b0f",
    letterSpacing: "-0.01em",
  };

  const wrap: React.CSSProperties = {
    minHeight: "100vh",
    background: "var(--ink)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "40px 24px",
    maxWidth: 430,
    margin: "0 auto",
  };

  // ── LOADING ──────────────────────────────────────────────────────────
  if (phase === "loading") {
    return (
      <>
        <style>{CSS}</style>
        <div style={wrap}>
          <div style={{ fontSize: 48, marginBottom: 16, animation: "pulse-ring 2s infinite" }}>🌙</div>
          <div style={{ fontSize: 14, color: "var(--text-3)" }}>Loading session…</div>
        </div>
      </>
    );
  }

  // ── ERROR ────────────────────────────────────────────────────────────
  if (phase === "error") {
    return (
      <>
        <style>{CSS}</style>
        <div style={wrap}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 56, marginBottom: 16 }}>🔗</div>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 700, marginBottom: 12 }}>
              Link unavailable
            </h2>
            <p style={{ fontSize: 14, color: "var(--text-2)", lineHeight: 1.6, marginBottom: 28 }}>
              {errorMsg}
            </p>
            <a
              href={APP_URL}
              style={{ display: "block", ...pBtn, textDecoration: "none", textAlign: "center" }}
            >
              Open Roundup app →
            </a>
          </div>
        </div>
      </>
    );
  }

  // ── ALREADY CONFIRMED ────────────────────────────────────────────────
  if (phase === "already_confirmed") {
    return (
      <>
        <style>{CSS}</style>
        <div style={wrap}>
          <div style={{ textAlign: "center", animation: "fadeUp 0.4s ease" }}>
            <div style={{ fontSize: 72, marginBottom: 16, animation: "celebrationPop 0.5s ease" }}>✅</div>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: 26, fontWeight: 800, color: "var(--green)", marginBottom: 12 }}>
              You&apos;re already confirmed awake!
            </h2>
            <p style={{ fontSize: 14, color: "var(--text-2)", marginBottom: 28 }}>
              This session has already been confirmed. Go conquer your day.
            </p>
            <a href={APP_URL} style={{ display: "block", ...pBtn, textDecoration: "none", textAlign: "center", background: "var(--surface)", color: "var(--text-2)", border: "1px solid var(--border-2)" }}>
              Open Roundup →
            </a>
          </div>
        </div>
      </>
    );
  }

  // ── CONFIRMED ────────────────────────────────────────────────────────
  if (phase === "confirmed") {
    return (
      <>
        <style>{CSS}</style>
        <div style={{ ...wrap, background: "var(--ink)" }}>
          <div style={{ textAlign: "center", animation: "fadeUp 0.4s ease" }}>
            <div style={{ fontSize: 80, marginBottom: 20, animation: "celebrationPop 0.6s cubic-bezier(0.34,1.56,0.64,1)" }}>🎉</div>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: 28, fontWeight: 800, color: "var(--amber)", marginBottom: 12, letterSpacing: "-0.02em" }}>
              You&apos;re awake!
            </h2>
            {saverName && (
              <p style={{ fontSize: 15, color: "var(--text-2)", marginBottom: 8 }}>
                {saverName} is notified — they saved you. 🌟
              </p>
            )}
            <p style={{ fontSize: 14, color: "var(--text-3)", marginBottom: 32 }}>
              Session confirmed. Go make the most of your day.
            </p>
            <a href={APP_URL} style={{ display: "block", ...pBtn, textDecoration: "none", textAlign: "center" }}>
              Open Roundup →
            </a>
          </div>
        </div>
      </>
    );
  }

  // ── SECOND CONFIRM (drag slider) ────────────────────────────────────
  if (phase === "second_confirm") {
    return (
      <>
        <style>{CSS}</style>
        <div style={{ minHeight: "100vh", background: "var(--ink)", padding: "40px 24px", maxWidth: 430, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 32, animation: "fadeUp 0.35s ease" }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>🧠</div>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: 24, fontWeight: 800, marginBottom: 8 }}>
              Still awake?
            </h2>
            <p style={{ fontSize: 14, color: "var(--text-2)", lineHeight: 1.6 }}>
              You tapped "I&apos;m awake" — now prove it.<br />
              Slide to confirm you&apos;re genuinely conscious.
            </p>
          </div>

          {/* Drag slider */}
          <div
            style={{
              position: "relative",
              height: 68,
              background: dragError ? "var(--red-glow)" : "var(--surface)",
              border: `1.5px solid ${dragError ? "var(--red)" : "var(--border-2)"}`,
              borderRadius: 34,
              overflow: "hidden",
              animation: dragError ? "shake 0.5s ease" : "none",
              marginBottom: 28,
            }}
          >
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", paddingLeft: dragX + 60, fontSize: 13, color: "var(--text-3)", pointerEvents: "none" }}>
              {locked
                ? `🔒 Unlocks in ${Math.floor(unlockInMs / 60000)}:${String(Math.floor((unlockInMs % 60000) / 1000)).padStart(2, "0")}`
                : "→ Slide all the way to confirm"}
            </div>
            <div
              style={{
                position: "absolute",
                top: 8,
                left: 8 + dragX,
                width: 52,
                height: 52,
                borderRadius: 26,
                background: "var(--amber)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 22,
                cursor: dragging ? "grabbing" : "grab",
                userSelect: "none",
                transition: dragging ? "none" : "left 0.3s ease",
                boxShadow: "0 2px 12px rgba(0,0,0,0.4)",
              }}
              onMouseDown={(e) => {
                setDragging(true);
                const startX = e.clientX - dragX;
                const onMove = (me: MouseEvent) =>
                  setDragX(Math.max(0, Math.min(240, me.clientX - startX)));
                const onUp = () => {
                  document.removeEventListener("mousemove", onMove);
                  document.removeEventListener("mouseup", onUp);
                  handleDragEnd();
                };
                document.addEventListener("mousemove", onMove);
                document.addEventListener("mouseup", onUp);
              }}
              onTouchStart={(e) => {
                setDragging(true);
                const startX = e.touches[0].clientX - dragX;
                const onMove = (te: TouchEvent) =>
                  setDragX(Math.max(0, Math.min(240, te.touches[0].clientX - startX)));
                const onEnd = () => {
                  document.removeEventListener("touchmove", onMove);
                  document.removeEventListener("touchend", onEnd);
                  handleDragEnd();
                };
                document.addEventListener("touchmove", onMove);
                document.addEventListener("touchend", onEnd);
              }}
            >
              →
            </div>
          </div>

          {confirming && (
            <p style={{ textAlign: "center", fontSize: 13, color: "var(--text-3)", marginBottom: 16 }}>
              Confirming…
            </p>
          )}

          <p style={{ textAlign: "center", fontSize: 11, color: "var(--text-3)", lineHeight: 1.5 }}>
            This 3-minute second confirmation prevents half-asleep taps from counting as awake.
          </p>
        </div>
      </>
    );
  }

  // ── READY TO CONFIRM (first tap) ─────────────────────────────────────
  return (
    <>
      <style>{CSS}</style>
      <div
        style={{
          minHeight: "100vh",
          background: "var(--ink-2)",
          padding: "40px 24px",
          animation: "alarmFlash 2s ease-in-out infinite",
          maxWidth: 430,
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div style={{ width: "100%", textAlign: "center", animation: "fadeUp 0.35s ease" }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 16px",
              background: "var(--red-glow)",
              border: "1px solid rgba(255,69,69,0.44)",
              borderRadius: 20,
              marginBottom: 24,
            }}
          >
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "var(--red)",
                animation: "pulse-ring 1s ease-in-out infinite",
              }}
            />
            <span style={{ fontSize: 12, color: "var(--red)", fontWeight: 600 }}>
              ALARM RINGING
            </span>
          </div>

          <div
            style={{
              fontSize: 72,
              marginBottom: 16,
              animation: "shake 0.5s ease-in-out infinite",
              lineHeight: 1,
            }}
          >
            ⏰
          </div>

          <h2
            style={{
              fontFamily: "var(--font-display)",
              fontSize: 36,
              fontWeight: 800,
              color: "var(--amber)",
              letterSpacing: "-0.03em",
              marginBottom: 8,
            }}
          >
            Wake Up!
          </h2>
          <p style={{ fontSize: 14, color: "var(--text-2)", marginBottom: 36, lineHeight: 1.6 }}>
            Your alarm is ringing. Tap below to confirm you&apos;re awake.
            You&apos;ll need to confirm once more in 3 minutes.
          </p>

          <button
            onClick={handleFirstConfirm}
            disabled={confirming}
            style={{
              ...pBtn,
              opacity: confirming ? 0.6 : 1,
              animation: "pulse-ring 2s ease-in-out infinite",
              boxShadow: "0 8px 32px rgba(245,166,35,0.45)",
              marginBottom: 12,
            }}
          >
            {confirming ? "Confirming…" : "✓ I'm Awake"}
          </button>

          <p style={{ fontSize: 11, color: "var(--text-3)", lineHeight: 1.5 }}>
            Your crew is watching. They&apos;ve been notified.
          </p>
        </div>
      </div>
    </>
  );
}
