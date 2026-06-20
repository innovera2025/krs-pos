"use client";

// TODO(auth): real authentication is production-readiness Phase 1 — verify credentials
// server-side, create a session (Auth.js/Lucia), set httpOnly cookie, then redirect
// + enforce RBAC. This is a UI stub only.

import { useState, useId } from "react";
import { useRouter } from "next/navigation";
import { Store, Eye, EyeOff, ShieldAlert, CheckCircle2, Zap, BarChart3, Shield } from "lucide-react";
import { useToast } from "@/components/ToastProvider";

const FEATURES = [
  {
    icon: Zap,
    th: "รวดเร็ว ลดการกดซ้ำ",
    en: "Fast checkout, fewer taps",
  },
  {
    icon: BarChart3,
    th: "รายงานยอดขายแบบเรียลไทม์",
    en: "Real-time sales dashboard",
  },
  {
    icon: Shield,
    th: "จัดการสิทธิ์ตามบทบาท",
    en: "Role-based access control",
  },
];

export default function LoginPage() {
  const router = useRouter();
  const { showToast } = useToast();

  const emailId = useId();
  const passwordId = useId();
  const rememberMeId = useId();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [emailError, setEmailError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  function validate(): boolean {
    let valid = true;

    if (!/.+@.+\..+/.test(email.trim())) {
      setEmailError("กรุณากรอกอีเมลให้ถูกต้อง · Please enter a valid email");
      valid = false;
    } else {
      setEmailError("");
    }

    if (password.length === 0) {
      setPasswordError("กรุณากรอกรหัสผ่าน · Password is required");
      valid = false;
    } else {
      setPasswordError("");
    }

    return valid;
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!validate()) return;

    setIsSubmitting(true);
    try {
      // Simulate brief network feel
      await new Promise((r) => setTimeout(r, 400));
      showToast("เดโม: ยังไม่ตรวจสอบรหัสผ่านจริง · Demo stub — no real auth");
      router.push("/pos");
    } catch {
      // If navigation is blocked/interrupted, re-enable the form instead of locking it.
      setIsSubmitting(false);
    }
  }

  const hasEmailError = emailError.length > 0;
  const hasPasswordError = passwordError.length > 0;

  return (
    <div
      className="min-h-screen flex"
      style={{ background: "var(--bg)" }}
    >
      {/* ── LEFT BRAND PANEL ── */}
      <div
        aria-hidden="true"
        className="hidden lg:flex flex-col relative overflow-hidden"
        style={{
          width: "46%",
          minWidth: 400,
          flexShrink: 0,
          background: "linear-gradient(155deg,#0e3b2e 0%,#082619 100%)",
        }}
      >
        {/* Subtle white-hairline grid overlay */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)",
            backgroundSize: "52px 52px",
            pointerEvents: "none",
          }}
        />

        {/* Radial glow — top-left accent */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            top: -80,
            left: -80,
            width: 420,
            height: 420,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, rgba(31,169,113,0.22) 0%, transparent 70%)",
            pointerEvents: "none",
          }}
        />

        {/* Content */}
        <div className="relative z-10 flex flex-col h-full px-12 py-12">
          {/* KRS mark + wordmark */}
          <div className="flex items-center gap-4 mb-auto">
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: 16,
                background: "linear-gradient(135deg,#23c884,#0b8060)",
                display: "grid",
                placeItems: "center",
                boxShadow: "0 16px 30px rgba(31,169,113,.30)",
                flexShrink: 0,
              }}
            >
              <Store size={26} strokeWidth={2} color="#ffffff" />
            </div>
            <div>
              <div
                style={{
                  fontSize: 22,
                  fontWeight: 700,
                  color: "#ffffff",
                  letterSpacing: "-0.02em",
                  lineHeight: 1.1,
                }}
              >
                KRS POS
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: "#7bbba0",
                  marginTop: 2,
                  letterSpacing: "0.01em",
                }}
              >
                Point of Sale System
              </div>
            </div>
          </div>

          {/* Hero copy — centered vertically */}
          <div className="flex-1 flex flex-col justify-center">
            <p
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: "#2ade96",
                marginBottom: 16,
              }}
            >
              ระบบจัดการร้านค้า
            </p>
            <h1
              style={{
                fontSize: 40,
                fontWeight: 700,
                color: "#ffffff",
                lineHeight: 1.15,
                letterSpacing: "-0.03em",
                margin: 0,
                marginBottom: 12,
              }}
            >
              ระบบขายหน้าร้าน
            </h1>
            <p
              style={{
                fontSize: 16,
                color: "#93c5b1",
                lineHeight: 1.6,
                margin: 0,
                marginBottom: 44,
              }}
            >
              ระบบขายหน้าร้าน · Point of Sale
            </p>

            {/* Feature bullets */}
            <div className="flex flex-col gap-4">
              {FEATURES.map(({ icon: Icon, th, en }) => (
                <div key={th} className="flex items-start gap-3">
                  <div
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 10,
                      background: "rgba(255,255,255,0.08)",
                      border: "1px solid rgba(255,255,255,0.10)",
                      display: "grid",
                      placeItems: "center",
                      flexShrink: 0,
                      marginTop: 1,
                    }}
                  >
                    <Icon size={16} strokeWidth={2} color="#2ade96" />
                  </div>
                  <div>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: "#dff8ec",
                        lineHeight: 1.3,
                      }}
                    >
                      {th}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: "#7bbba0",
                        marginTop: 2,
                        lineHeight: 1.4,
                      }}
                    >
                      {en}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Bottom tagline */}
          <div
            style={{
              marginTop: "auto",
              paddingTop: 32,
              borderTop: "1px solid rgba(255,255,255,0.08)",
            }}
          >
            <p
              style={{
                fontSize: 12,
                color: "#5d8f7a",
                margin: 0,
                lineHeight: 1.5,
              }}
            >
              KRS POS · ออกแบบเพื่อความเร็วในการขายจริง
              <br />
              Built for speed · Designed for clarity
            </p>
          </div>
        </div>
      </div>

      {/* ── RIGHT AUTH PANEL ── */}
      <div
        className="flex-1 flex flex-col items-center justify-center"
        style={{
          padding: "32px 24px",
          minHeight: "100vh",
        }}
      >
        {/* Demo warning badge — PROMINENTLY visible */}
        <div
          role="status"
          aria-label="Demo mode — authentication not active"
          style={{
            display: "inline-flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
            maxWidth: "100%",
            background: "#fff4d8",
            border: "1px solid #fcd34d",
            borderRadius: 10,
            padding: "8px 14px",
            marginBottom: 28,
            fontSize: 12,
            fontWeight: 600,
            color: "#92400e",
          }}
        >
          <ShieldAlert size={14} strokeWidth={2.5} color="#d97706" aria-hidden="true" />
          เดโม / Demo — auth ยังไม่เปิดใช้งานจริง
        </div>

        {/* Mobile brand mark (shown when left panel is hidden) */}
        <div
          className="flex lg:hidden items-center gap-3 mb-8"
          aria-hidden="true"
        >
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 14,
              background: "linear-gradient(135deg,#23c884,#0b8060)",
              display: "grid",
              placeItems: "center",
              boxShadow: "0 12px 24px rgba(31,169,113,.25)",
            }}
          >
            <Store size={22} strokeWidth={2} color="#ffffff" />
          </div>
          <div>
            <div
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: "var(--ink)",
                letterSpacing: "-0.02em",
              }}
            >
              KRS POS
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)" }}>
              ระบบขายหน้าร้าน
            </div>
          </div>
        </div>

        {/* Auth card */}
        <div
          style={{
            width: "100%",
            maxWidth: 420,
            background: "var(--surface)",
            borderRadius: "var(--r-xl)",
            border: "1px solid var(--line)",
            boxShadow: "var(--shadow)",
            padding: "36px 32px 32px",
          }}
        >
          {/* Card heading */}
          <div style={{ marginBottom: 28 }}>
            <h1
              style={{
                fontSize: 24,
                fontWeight: 700,
                color: "var(--ink)",
                letterSpacing: "-0.02em",
                margin: 0,
                lineHeight: 1.2,
              }}
            >
              เข้าสู่ระบบ
            </h1>
            <p
              style={{
                margin: "6px 0 0",
                fontSize: 14,
                color: "var(--muted)",
                lineHeight: 1.5,
              }}
            >
              Sign in to your account · กรุณาเข้าสู่ระบบ
            </p>
          </div>

          <form onSubmit={handleSubmit} noValidate>
            {/* Email field */}
            <div style={{ marginBottom: 18 }}>
              <label
                htmlFor={emailId}
                style={{
                  display: "block",
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--ink)",
                  marginBottom: 8,
                }}
              >
                อีเมล · Email
              </label>
              <input
                id={emailId}
                type="email"
                autoComplete="email"
                inputMode="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (emailError) setEmailError("");
                }}
                aria-invalid={hasEmailError}
                aria-describedby={hasEmailError ? `${emailId}-error` : undefined}
                disabled={isSubmitting}
                style={{
                  display: "block",
                  width: "100%",
                  height: 48,
                  border: `1.5px solid ${hasEmailError ? "var(--red)" : "var(--line)"}`,
                  borderRadius: "var(--r-sm)",
                  padding: "0 14px",
                  fontSize: 15,
                  color: "var(--ink)",
                  background: hasEmailError ? "var(--red-soft)" : "var(--surface)",
                  outline: "none",
                  transition: "border-color .14s, box-shadow .14s",
                  boxSizing: "border-box",
                  fontFamily: "inherit",
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = hasEmailError
                    ? "var(--red)"
                    : "var(--brand)";
                  e.currentTarget.style.boxShadow = `0 0 0 3px ${hasEmailError ? "rgba(239,68,68,.12)" : "rgba(31,169,113,.15)"}`;
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = hasEmailError
                    ? "var(--red)"
                    : "var(--line)";
                  e.currentTarget.style.boxShadow = "none";
                }}
              />
              {hasEmailError && (
                <p
                  id={`${emailId}-error`}
                  role="alert"
                  style={{
                    margin: "6px 0 0",
                    fontSize: 12,
                    color: "var(--red)",
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                  }}
                >
                  <ShieldAlert size={12} strokeWidth={2.5} aria-hidden="true" />
                  {emailError}
                </p>
              )}
            </div>

            {/* Password field */}
            <div style={{ marginBottom: 8 }}>
              <label
                htmlFor={passwordId}
                style={{
                  display: "block",
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--ink)",
                  marginBottom: 8,
                }}
              >
                รหัสผ่าน · Password
              </label>
              <div style={{ position: "relative" }}>
                <input
                  id={passwordId}
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (passwordError) setPasswordError("");
                  }}
                  aria-invalid={hasPasswordError}
                  aria-describedby={
                    hasPasswordError ? `${passwordId}-error` : undefined
                  }
                  disabled={isSubmitting}
                  style={{
                    display: "block",
                    width: "100%",
                    height: 48,
                    border: `1.5px solid ${hasPasswordError ? "var(--red)" : "var(--line)"}`,
                    borderRadius: "var(--r-sm)",
                    padding: "0 48px 0 14px",
                    fontSize: 15,
                    color: "var(--ink)",
                    background: hasPasswordError
                      ? "var(--red-soft)"
                      : "var(--surface)",
                    outline: "none",
                    transition: "border-color .14s, box-shadow .14s",
                    boxSizing: "border-box",
                    fontFamily: "inherit",
                  }}
                  onFocus={(e) => {
                    e.currentTarget.style.borderColor = hasPasswordError
                      ? "var(--red)"
                      : "var(--brand)";
                    e.currentTarget.style.boxShadow = `0 0 0 3px ${hasPasswordError ? "rgba(239,68,68,.12)" : "rgba(31,169,113,.15)"}`;
                  }}
                  onBlur={(e) => {
                    e.currentTarget.style.borderColor = hasPasswordError
                      ? "var(--red)"
                      : "var(--line)";
                    e.currentTarget.style.boxShadow = "none";
                  }}
                />
                <button
                  type="button"
                  aria-label={showPassword ? "ซ่อนรหัสผ่าน · Hide password" : "แสดงรหัสผ่าน · Show password"}
                  onClick={() => setShowPassword((v) => !v)}
                  disabled={isSubmitting}
                  style={{
                    position: "absolute",
                    right: 0,
                    top: 0,
                    width: 48,
                    height: 48,
                    display: "grid",
                    placeItems: "center",
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    color: "var(--soft)",
                    borderRadius: "0 var(--r-sm) var(--r-sm) 0",
                    transition: "color .14s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = "var(--muted)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = "var(--soft)";
                  }}
                >
                  {showPassword ? (
                    <EyeOff size={18} strokeWidth={2} aria-hidden="true" />
                  ) : (
                    <Eye size={18} strokeWidth={2} aria-hidden="true" />
                  )}
                </button>
              </div>
              {hasPasswordError && (
                <p
                  id={`${passwordId}-error`}
                  role="alert"
                  style={{
                    margin: "6px 0 0",
                    fontSize: 12,
                    color: "var(--red)",
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                  }}
                >
                  <ShieldAlert size={12} strokeWidth={2.5} aria-hidden="true" />
                  {passwordError}
                </p>
              )}
            </div>

            {/* Remember me checkbox */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 28,
                marginTop: 16,
              }}
            >
              <input
                id={rememberMeId}
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                disabled={isSubmitting}
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 5,
                  accentColor: "var(--brand)",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              />
              <label
                htmlFor={rememberMeId}
                style={{
                  fontSize: 13,
                  color: "var(--muted)",
                  cursor: "pointer",
                  lineHeight: 1.4,
                  userSelect: "none",
                }}
              >
                จดจำฉัน · Remember me
              </label>
            </div>

            {/* Sign-in CTA — matches Taste `.pay` button */}
            <button
              type="submit"
              disabled={isSubmitting}
              style={{
                width: "100%",
                height: 54,
                border: 0,
                borderRadius: "var(--r-md)",
                background: isSubmitting
                  ? "var(--line)"
                  : "linear-gradient(180deg,#22b877,#11865a)",
                color: isSubmitting ? "var(--soft)" : "#ffffff",
                fontSize: 16,
                fontWeight: 700,
                fontFamily: "inherit",
                cursor: isSubmitting ? "not-allowed" : "pointer",
                boxShadow: isSubmitting
                  ? "none"
                  : "0 15px 30px rgba(31,169,113,.24)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 10,
                transition: "opacity .14s, transform .14s, box-shadow .14s",
              }}
              onMouseEnter={(e) => {
                if (!isSubmitting) {
                  e.currentTarget.style.opacity = "0.92";
                  e.currentTarget.style.transform = "translateY(-1px)";
                  e.currentTarget.style.boxShadow =
                    "0 18px 36px rgba(31,169,113,.32)";
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = "1";
                e.currentTarget.style.transform = "translateY(0)";
                e.currentTarget.style.boxShadow = isSubmitting
                  ? "none"
                  : "0 15px 30px rgba(31,169,113,.24)";
              }}
            >
              {isSubmitting ? (
                <>
                  <span
                    aria-hidden="true"
                    style={{
                      width: 18,
                      height: 18,
                      border: "2px solid rgba(255,255,255,0.3)",
                      borderTopColor: "var(--soft)",
                      borderRadius: "50%",
                      display: "inline-block",
                      animation: "spin .7s linear infinite",
                    }}
                  />
                  กำลังเข้าสู่ระบบ…
                </>
              ) : (
                <>
                  <CheckCircle2 size={18} strokeWidth={2.5} aria-hidden="true" />
                  เข้าสู่ระบบ · Sign in
                </>
              )}
            </button>
          </form>
        </div>

        {/* Footer note */}
        <p
          style={{
            marginTop: 24,
            fontSize: 12,
            color: "var(--soft)",
            textAlign: "center",
            lineHeight: 1.6,
            maxWidth: 380,
          }}
        >
          เข้าสู่ระบบด้วยบัญชีที่ผู้ดูแลกำหนดให้
          <br />
          Sign in with the account provided by your administrator.
        </p>
      </div>

    </div>
  );
}
