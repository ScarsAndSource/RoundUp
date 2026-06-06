"use client";
import { useState, Suspense } from "react";
import { createBrowserClient } from "@supabase/ssr";
import { useSearchParams, useRouter } from "next/navigation";

const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [usePassword, setUsePassword] = useState(false);
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const searchParams = useSearchParams();
  const redirect = searchParams.get("redirect") ?? "/";
  const router = useRouter();

  const handleLogin = async () => {
    if (!email.trim()) return;
    setLoading(true);
    setError("");

    if (usePassword) {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password: password.trim(),
      });
      if (error) setError(error.message);
      else window.location.replace("/");
      setLoading(false);
      return;
    }

    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?redirect=${encodeURIComponent(redirect)}`,
      },
    });
    if (!error) setSent(true);
    else setError(error.message);
    setLoading(false);
  };

  const page: React.CSSProperties = {
    minHeight: "100vh",
    background: "#0a0b0f",
    color: "#e8eaf0",
    fontFamily: "system-ui, sans-serif",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  };

  const input: React.CSSProperties = {
    width: "100%",
    padding: 16,
    borderRadius: 12,
    background: "#1e2235",
    border: "1px solid rgba(255,255,255,0.13)",
    color: "#e8eaf0",
    fontSize: 16,
    outline: "none",
    marginBottom: 12,
    boxSizing: "border-box",
  };

  const btn: React.CSSProperties = {
    width: "100%",
    padding: 16,
    borderRadius: 12,
    background: "#f5a623",
    border: "none",
    cursor: "pointer",
    fontSize: 16,
    fontWeight: 700,
    color: "#0a0b0f",
  };

  if (sent) {
    return (
      <div style={page}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>📬</div>
          <p style={{ color: "#9099b5", fontSize: 14 }}>
            Check your inbox. The sign-in link expires in 1 hour.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={page}>
      <div style={{ maxWidth: 380, width: "100%" }}>
        <div style={{ textAlign: "center", fontSize: 52, marginBottom: 12 }}>🌙</div>
        <h1 style={{ textAlign: "center", fontSize: 26, fontWeight: 700, marginBottom: 8 }}>
          Roundup
        </h1>
        <p style={{ textAlign: "center", fontSize: 14, color: "#9099b5", marginBottom: 32 }}>
          {usePassword
            ? "Sign in with email + password."
            : "Sign in with your email — magic link, no password."}
        </p>
        <input
          type="email"
          placeholder="your@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleLogin()}
          style={input}
        />
        {usePassword && (
          <input
            type="password"
            placeholder="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLogin()}
            style={input}
          />
        )}
        {error && (
          <p style={{ color: "#ff6b6b", fontSize: 13, marginBottom: 12, textAlign: "center" }}>
            {error}
          </p>
        )}
        <button
          onClick={handleLogin}
          disabled={loading || !email.trim() || (usePassword && !password.trim())}
          style={{
            ...btn,
            opacity: loading || !email.trim() || (usePassword && !password.trim()) ? 0.5 : 1,
          }}
        >
          {loading
            ? usePassword ? "Signing in…" : "Sending…"
            : usePassword ? "Sign in →" : "Send magic link →"}
        </button>
        <p
          onClick={() => { setUsePassword(!usePassword); setError(""); }}
          style={{
            textAlign: "center",
            fontSize: 13,
            color: "#9099b5",
            marginTop: 16,
            cursor: "pointer",
            textDecoration: "underline",
          }}
        >
          {usePassword ? "Use magic link instead" : "Rate limited? Sign in with password"}
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}