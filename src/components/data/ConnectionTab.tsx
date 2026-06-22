"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Database, RefreshCw, Plus, Boxes, Eye, EyeOff, Save, PackageSearch } from "lucide-react";
import { useToast } from "@/components/ToastProvider";
import type { KrsConnectionSettingsDTO } from "@/types";
import type { DbState, SyncMode } from "./connectionTypes";

/**
 * Connection tab (KRS Data Link) — FUNCTIONAL as of krs-sync P1.
 *
 * The tab is now backed by real admin-only API routes (it no longer simulates):
 *  - On mount it loads the saved config via GET /api/krs/settings (password masked
 *    as `passwordSet` — the plaintext/ciphertext is never returned).
 *  - A masked password input (show/hide toggle, matching the login form) lets the
 *    admin set/replace the SQL Server password. It is NEVER pre-populated; leaving
 *    it blank keeps the existing stored password. The plaintext lives in local
 *    state only and is CLEARED on a successful save.
 *  - Save → PATCH /api/krs/settings (encrypts the password server-side).
 *  - Test Connection → POST /api/krs/test-connection, driving the real status card
 *    (connected/latency/error). The result also updates the shared `db` state so
 *    the header live-status pill reflects reality.
 *
 * Visual language is the Taste port preserved from the original demo: the dark
 * status card, the two-column config / connection-string + stock-sync grid, the
 * `Field` inputs, and the green action pills are all unchanged. The password field
 * and Save button reuse that same language.
 *
 * The component receives the shared `db`/`setDb`/`testing`/`setTesting` state from
 * the /data screen (so the header pill + Live Data tab stay consistent) and owns
 * the password / saving / load behavior internally.
 *
 * The "ทดลอง INSERT" button stays visible (layout parity) but is a P1 stub — the
 * real insert path is P2.
 */
export function ConnectionTab({
  db,
  setDb,
  testing,
  setTesting,
  stockSync,
  onToggleStockSync,
}: {
  db: DbState;
  setDb: (patch: Partial<DbState>) => void;
  testing: boolean;
  setTesting: (testing: boolean) => void;
  stockSync: boolean;
  onToggleStockSync: () => void;
}) {
  const { showToast } = useToast();

  // Plaintext password lives ONLY in local state, never persisted to `db`, never
  // sent to the parent, and cleared on a successful save.
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Inbound "pull products from KRS" busy flag (krs-sync). Disables the button +
  // drives its label while the POST is in flight.
  const [pulling, setPulling] = useState(false);

  // Guard against a deferred setState after unmount (load/save/test are async).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ---- Load saved config on mount ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/krs/settings");
        if (!res.ok) throw new Error("load failed");
        const data = (await res.json()) as { settings: KrsConnectionSettingsDTO | null };
        if (cancelled || !mountedRef.current) return;
        if (data.settings) {
          const s = data.settings;
          setDb({
            host: s.host,
            port: String(s.port),
            name: s.database,
            user: s.username,
            ssl: s.ssl,
            trustServerCert: s.trustServerCert,
            passwordSet: s.passwordSet,
            syncMode: (s.syncMode as SyncMode) ?? "realtime",
          });
        }
      } catch {
        if (cancelled || !mountedRef.current) return;
        setLoadError("โหลดการตั้งค่าไม่สำเร็จ · Could not load settings");
      }
    })();
    return () => {
      cancelled = true;
    };
    // setDb is a stable useCallback from the parent; load once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Save (PATCH) ----
  const onSave = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/krs/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: db.host,
          port: Number(db.port),
          database: db.name,
          username: db.user,
          // Only include the password when the admin typed one — omitting it keeps
          // the existing stored password.
          ...(password ? { password } : {}),
          ssl: db.ssl,
          trustServerCert: db.trustServerCert,
          engine: "SQLSERVER",
          syncMode: db.syncMode ?? "realtime",
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { settings?: KrsConnectionSettingsDTO; error?: string }
        | null;
      if (!res.ok || !body?.settings) {
        const msg = body?.error ?? "Unknown error";
        showToast("บันทึกไม่สำเร็จ: " + msg);
        return;
      }
      // Reflect the masked passwordSet from the response via the PARENT setter —
      // `setDb` is a stable parent callback and must run UNCONDITIONALLY (FIX 2) so
      // the shared `db` state is correct even if this tab unmounted mid-request.
      setDb({ passwordSet: body.settings.passwordSet });
      // Local-state writes + the toast stay behind the mounted guard (a setState on
      // an unmounted component is the thing the guard protects against).
      if (!mountedRef.current) return;
      setPassword("");
      setShowPassword(false);
      showToast("บันทึกการตั้งค่า KRS สำเร็จ · Saved");
    } catch {
      showToast("บันทึกไม่สำเร็จ · Save failed");
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }, [
    saving,
    db.host,
    db.port,
    db.name,
    db.user,
    db.ssl,
    db.trustServerCert,
    db.syncMode,
    password,
    setDb,
    showToast,
  ]);

  // ---- Test Connection (POST) ----
  //
  // FIX 2: the parent-owned setters (`setTesting`, `setDb`) are stable callbacks
  // and MUST run UNCONDITIONALLY in every exit path. Previously the `catch`/`finally`
  // and the result branches were gated on `mountedRef.current`, so switching tabs
  // (unmounting this tab) mid-test left the parent stuck — the LiveStatusPill froze
  // on "testing" and the Test button stayed disabled. Only the `showToast` calls
  // (and any LOCAL-state writes) stay behind the mounted guard; the shared `db`/
  // `testing` state always resets.
  const onTestConnection = useCallback(async () => {
    if (testing) return;
    setTesting(true);
    setDb({ status: "testing" });
    showToast(`กำลังทดสอบการเชื่อมต่อ ${db.host || "KRS"}...`);
    try {
      const res = await fetch("/api/krs/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Empty body → test the SAVED config (the saved-config path). The override
        // path needs the plaintext password (not held after save), so the UI never
        // sends a partial override; `trustServerCert` is read from the saved row.
        body: JSON.stringify({}),
      });
      const result = (await res.json().catch(() => null)) as
        | { connected: boolean; latencyMs: number | null; error: string | null }
        | null;
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const lastCheck = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
      if (result?.connected) {
        // PARENT setter — always run (FIX 2).
        setDb({ status: "connected", latency: result.latencyMs ?? 0, lastCheck });
        if (mountedRef.current) {
          showToast(`เชื่อมต่อสำเร็จ · KRS @ ${db.host} (${result.latencyMs ?? 0}ms)`);
        }
      } else {
        setDb({ status: "disconnected", latency: 0, lastCheck });
        if (mountedRef.current) {
          showToast("เชื่อมต่อไม่สำเร็จ: " + (result?.error ?? "Unknown error"));
        }
      }
    } catch {
      // PARENT setter — always run so the pill/button never get stuck (FIX 2).
      setDb({ status: "disconnected", latency: 0 });
      if (mountedRef.current) {
        showToast("ทดสอบการเชื่อมต่อไม่สำเร็จ · Test failed");
      }
    } finally {
      // PARENT setter — always reset `testing` (the stuck-state root cause, FIX 2).
      setTesting(false);
    }
  }, [testing, db.host, setDb, setTesting, showToast]);

  // The real test-row insert path is P2; keep the button for layout parity.
  const onInsertTestRow = useCallback(() => {
    showToast("ทดลอง INSERT ยังไม่พร้อมใช้ใน P1 · coming in P2");
  }, [showToast]);

  // ---- Pull products from KRS (inbound, POST) ----
  //
  // Reads the KRS product master (dbo.InventoryItem) and upserts it into POS
  // Category/Product via /api/krs/pull-products. Admin-only on the server. Shows a
  // result summary (created / updated / barcode-skipped / categories) via toast.
  const onPullProducts = useCallback(async () => {
    if (pulling) return;
    setPulling(true);
    showToast("กำลังดึงสินค้าจาก KRS · Pulling products from KRS...");
    try {
      const res = await fetch("/api/krs/pull-products", { method: "POST" });
      const body = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            created?: number;
            updated?: number;
            barcodeSkipped?: number;
            categories?: number;
            total?: number;
            error?: string;
          }
        | null;
      if (!res.ok || !body?.ok) {
        const msg = body?.error ?? "Unknown error";
        if (mountedRef.current) showToast("ดึงสินค้าไม่สำเร็จ: " + msg);
        return;
      }
      const created = body.created ?? 0;
      const updated = body.updated ?? 0;
      const skipped = body.barcodeSkipped ?? 0;
      const cats = body.categories ?? 0;
      if (mountedRef.current) {
        showToast(
          `ดึงสินค้าจาก KRS สำเร็จ · ใหม่ ${created} · อัปเดต ${updated} · หมวดใหม่ ${cats}` +
            (skipped > 0 ? ` · ข้ามบาร์โค้ดซ้ำ ${skipped}` : "")
        );
      }
    } catch {
      if (mountedRef.current) showToast("ดึงสินค้าไม่สำเร็จ · Pull failed");
    } finally {
      if (mountedRef.current) setPulling(false);
    }
  }, [pulling, showToast]);

  // Tri-state status card meta.
  const stMeta = testing
    ? { label: "กำลังทดสอบ · Testing", color: "#b45309", bg: "#fffbeb", dot: "#d97706" }
    : db.status === "connected"
      ? { label: "เชื่อมต่ออยู่ · Connected", color: "#15803d", bg: "#f0fdf4", dot: "#16a34a" }
      : { label: "ตัดการเชื่อมต่อ · Disconnected", color: "#b91c1c", bg: "#fef2f2", dot: "#dc2626" };

  // SQL Server connection-string preview, rendered from the live fields.
  const connString = `sqlserver://${db.user || "user"}@${db.host || "host"}:${db.port}/${
    db.name || "database"
  }${db.ssl ? "?ssl=true" : ""}`;

  const toggleSsl = () => {
    const next = !db.ssl;
    setDb({ ssl: next });
    showToast(next ? "เปิด SSL/TLS · เข้ารหัสการเชื่อมต่อ" : "ปิด SSL/TLS");
  };

  const toggleTrustCert = () => {
    const next = !db.trustServerCert;
    setDb({ trustServerCert: next });
    showToast(
      next
        ? "ยอมรับใบรับรองที่ออกเอง · Trust self-signed cert"
        : "ไม่ยอมรับใบรับรองที่ออกเอง · require CA-verified cert"
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Dark status card */}
      <div
        className="flex flex-wrap items-center gap-[18px] rounded-2xl px-[22px] py-[18px]"
        style={{ background: "#0f172a" }}
      >
        <div className="flex items-center gap-3">
          <div
            className="grid h-11 w-11 place-items-center rounded-[11px]"
            style={{ background: "#1e293b", color: "#7dd3fc" }}
          >
            <Database size={22} strokeWidth={1.8} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span
                style={{ width: 9, height: 9, borderRadius: 99, background: stMeta.dot }}
              />
              <span className="text-[15px] font-bold text-white">{stMeta.label}</span>
            </div>
            <div className="mono mt-0.5 text-[11.5px]" style={{ color: "#94a3b8" }}>
              KRS · {db.engine} · {db.host || "—"}:{db.port}
            </div>
          </div>
        </div>

        <div
          className="flex gap-5 border-l pl-[18px]"
          style={{ borderColor: "#1e293b" }}
        >
          <Stat label="Latency" value={`${db.latency} ms`} valueColor="#a7f3d0" />
          <Stat label="ตรวจล่าสุด" value={db.lastCheck || "—"} valueColor="#cbd5e1" />
          <Stat label="INSERT (เซสชัน)" value={String(db.inserted)} valueColor="#cbd5e1" />
        </div>

        <div className="flex-1" />

        <div className="flex gap-[9px]">
          <button
            type="button"
            onClick={onTestConnection}
            disabled={testing}
            className="flex h-[42px] items-center gap-2 rounded-[11px] px-4 text-[13px] font-semibold text-white transition hover:bg-[#334155] disabled:opacity-60"
            style={{ background: "#1e293b" }}
          >
            <RefreshCw size={16} strokeWidth={2} color="#7dd3fc" />
            {testing ? "กำลังทดสอบ..." : "ทดสอบการเชื่อมต่อ"}
          </button>
          {/* Inbound pull: read the KRS product master into POS. Mint pill to
              distinguish the inbound PULL from the forest-green outbound INSERT. */}
          <button
            type="button"
            onClick={onPullProducts}
            disabled={pulling}
            className="flex h-[42px] items-center gap-2 rounded-[11px] px-4 text-[13px] font-semibold transition hover:brightness-105 disabled:opacity-60"
            style={{ background: "#ecfdf5", color: "#047857", boxShadow: "inset 0 0 0 1px #a7f3d0" }}
          >
            <PackageSearch size={16} strokeWidth={2} />
            {pulling ? "กำลังดึงสินค้า..." : "ดึงสินค้าจาก KRS · Pull products"}
          </button>
          <button
            type="button"
            onClick={onInsertTestRow}
            className="flex h-[42px] items-center gap-2 rounded-[11px] px-4 text-[13px] font-semibold text-white transition hover:brightness-110"
            style={{ background: "#16a34a", boxShadow: "0 4px 12px rgba(22,163,74,.3)" }}
          >
            <Plus size={16} strokeWidth={2} />
            ทดลอง INSERT
          </button>
        </div>
      </div>

      {/* Config + connection string */}
      <div className="grid gap-4" style={{ gridTemplateColumns: "1.25fr 1fr" }}>
        <div
          className="rounded-2xl border px-5 py-[18px]"
          style={{ background: "#fff", borderColor: "#e8edf3" }}
        >
          <div className="mb-[14px] text-[14.5px] font-bold">
            ตั้งค่าการเชื่อมต่อ KRS · Connection
          </div>
          {loadError ? (
            <div
              className="mb-3 rounded-[10px] px-3 py-2 text-[12px] font-medium"
              style={{ background: "#fef2f2", color: "#b91c1c" }}
              role="alert"
            >
              {loadError}
            </div>
          ) : null}
          <div className="grid gap-3" style={{ gridTemplateColumns: "1.4fr 1fr" }}>
            <Field
              full
              label="Host / IP Address"
              value={db.host}
              onChange={(v) => setDb({ host: v })}
            />
            <Field label="Port" value={db.port} onChange={(v) => setDb({ port: v })} />
            <div>
              <FieldLabel>Engine</FieldLabel>
              <div
                className="flex h-[42px] items-center rounded-[10px] border px-3 text-[13.5px] font-medium"
                style={{ background: "#f8fafc", borderColor: "#e2e8f0", color: "#334155" }}
              >
                {db.engine}
              </div>
            </div>
            <Field label="Database" value={db.name} onChange={(v) => setDb({ name: v })} />
            <Field label="Username" value={db.user} onChange={(v) => setDb({ user: v })} />

            {/* Password (NEW — the field missing from the original design). Masked
                with a show/hide toggle (matching the login form). Never
                pre-populated; the placeholder reflects whether one is already
                stored. */}
            <div className="col-span-full">
              <FieldLabel>
                {db.passwordSet
                  ? "รหัสผ่าน · Password (ตั้งค่าแล้ว — เว้นว่างเพื่อใช้ค่าเดิม)"
                  : "รหัสผ่าน · Password"}
              </FieldLabel>
              <div style={{ position: "relative" }}>
                <input
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={
                    db.passwordSet ? "•••• ตั้งค่าแล้ว · set — leave blank to keep" : "รหัสผ่าน SQL Server"
                  }
                  aria-label="รหัสผ่าน · Password"
                  className="mono h-[42px] w-full rounded-[10px] border pl-3 text-[13.5px]"
                  style={{ borderColor: "#e2e8f0", paddingRight: 42 }}
                />
                <button
                  type="button"
                  aria-label={
                    showPassword ? "ซ่อนรหัสผ่าน · Hide password" : "แสดงรหัสผ่าน · Show password"
                  }
                  onClick={() => setShowPassword((v) => !v)}
                  style={{
                    position: "absolute",
                    right: 0,
                    top: 0,
                    width: 42,
                    height: 42,
                    display: "grid",
                    placeItems: "center",
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    color: "#94a3b8",
                  }}
                >
                  {showPassword ? (
                    <EyeOff size={17} strokeWidth={2} aria-hidden="true" />
                  ) : (
                    <Eye size={17} strokeWidth={2} aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>

            {/* SSL toggle */}
            <div
              className="col-span-full flex items-center justify-between rounded-[10px] px-3 py-[10px]"
              style={{ background: "#f8fafc" }}
            >
              <div>
                <div className="text-[13px] font-semibold" style={{ color: "#334155" }}>
                  SSL / TLS
                </div>
                <div className="text-[11px]" style={{ color: "#94a3b8" }}>
                  เข้ารหัสการเชื่อมต่อ KRS
                </div>
              </div>
              <Toggle on={db.ssl} onClick={toggleSsl} ariaLabel="SSL/TLS" small />
            </div>

            {/* Trust self-signed cert toggle (NEW) — only meaningful when SSL is on
                (on-prem KRS commonly runs a self-signed cert). Dimmed + disabled
                when SSL is off, since trust is moot for an unencrypted connection. */}
            <div
              className="col-span-full flex items-center justify-between rounded-[10px] px-3 py-[10px]"
              style={{ background: "#f8fafc", opacity: db.ssl ? 1 : 0.5 }}
            >
              <div>
                <div className="text-[13px] font-semibold" style={{ color: "#334155" }}>
                  ยอมรับใบรับรองที่ออกเอง · Trust self-signed cert
                </div>
                <div className="text-[11px]" style={{ color: "#94a3b8" }}>
                  {db.ssl
                    ? "สำหรับ KRS on-prem ที่ใช้ใบรับรองออกเอง"
                    : "มีผลเมื่อเปิด SSL/TLS เท่านั้น"}
                </div>
              </div>
              <Toggle
                on={db.trustServerCert}
                onClick={toggleTrustCert}
                ariaLabel="ยอมรับใบรับรองที่ออกเอง · Trust self-signed cert"
                small
                disabled={!db.ssl}
              />
            </div>

            {/* Save (NEW) — green pill matching the action language. */}
            <div className="col-span-full flex justify-end">
              <button
                type="button"
                onClick={onSave}
                disabled={saving}
                className="flex h-[42px] items-center gap-2 rounded-[11px] px-5 text-[13px] font-semibold text-white transition hover:brightness-110 disabled:opacity-60"
                style={{ background: "#16a34a", boxShadow: "0 4px 12px rgba(22,163,74,.3)" }}
              >
                <Save size={16} strokeWidth={2} />
                {saving ? "กำลังบันทึก..." : "บันทึก · Save"}
              </button>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <div
            className="rounded-2xl border px-5 py-[18px]"
            style={{ background: "#fff", borderColor: "#e8edf3" }}
          >
            <div className="mb-[9px] text-[13px] font-bold">Connection string</div>
            <div
              className="mono break-all rounded-[9px] border px-3 py-[11px] text-[11.5px] leading-relaxed"
              style={{ color: "#0f766e", background: "#f0fdfa", borderColor: "#ccfbf1" }}
            >
              {connString}
            </div>
            <div
              className="mt-[11px] flex items-center gap-2 text-[11.5px]"
              style={{ color: "#15803d" }}
            >
              <span style={{ width: 7, height: 7, borderRadius: 99, background: "#16a34a" }} />
              POS backend ↔ KRS · pool 0–8 connections
            </div>
            {db.lastInsert ? (
              <div className="mono mt-2 text-[11px]" style={{ color: "#94a3b8" }}>
                ล่าสุด INSERT: {db.lastInsert}
              </div>
            ) : null}
          </div>

          {/* Realtime stock-sync toggle */}
          <div
            className="flex items-center gap-3 rounded-2xl border px-[18px] py-[14px]"
            style={{ background: "#fff", borderColor: "#e8edf3" }}
          >
            <div
              className="grid h-[38px] w-[38px] place-items-center rounded-[10px]"
              style={{ background: "#eff6ff", color: "#2563eb" }}
            >
              <Boxes size={19} strokeWidth={2} />
            </div>
            <div className="flex-1">
              <div className="text-[13px] font-semibold" style={{ color: "#334155" }}>
                ซิงค์สต็อกเรียลไทม์
              </div>
              <div className="text-[11px]" style={{ color: "#94a3b8" }}>
                ขาย/รับเข้า → ส่งขึ้น KRS ทันที
              </div>
            </div>
            <span
              className="rounded-[7px] px-[10px] py-1 text-[11px] font-semibold"
              style={{
                background: stockSync ? "#f0fdf4" : "#f1f5f9",
                color: stockSync ? "#15803d" : "#94a3b8",
              }}
            >
              {stockSync ? "เปิดใช้งาน · On" : "ปิด · Off"}
            </span>
            <Toggle on={stockSync} onClick={onToggleStockSync} ariaLabel="ซิงค์สต็อกเรียลไทม์" />
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor: string;
}) {
  return (
    <div>
      <div className="text-[10.5px]" style={{ color: "#64748b" }}>
        {label}
      </div>
      <div className="mono text-[15px] font-semibold" style={{ color: valueColor }}>
        {value}
      </div>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-[5px] text-[11.5px] font-semibold" style={{ color: "#64748b" }}>
      {children}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  full,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  full?: boolean;
}) {
  return (
    <div className={full ? "col-span-full" : undefined}>
      <FieldLabel>{label}</FieldLabel>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mono h-[42px] w-full rounded-[10px] border px-3 text-[13.5px]"
        style={{ borderColor: "#e2e8f0" }}
        aria-label={label}
      />
    </div>
  );
}

function Toggle({
  on,
  onClick,
  ariaLabel,
  small,
  disabled,
}: {
  on: boolean;
  onClick: () => void;
  ariaLabel: string;
  small?: boolean;
  disabled?: boolean;
}) {
  const w = small ? 42 : 46;
  const h = small ? 24 : 26;
  const knob = small ? 18 : 20;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      onClick={onClick}
      disabled={disabled}
      style={{
        width: w,
        height: h,
        borderRadius: 99,
        padding: 3,
        border: 0,
        cursor: disabled ? "not-allowed" : "pointer",
        display: "flex",
        transition: "all .15s",
        background: on ? "#16a34a" : "#cbd5e1",
        justifyContent: on ? "flex-end" : "flex-start",
      }}
    >
      <span
        style={{
          width: knob,
          height: knob,
          borderRadius: 99,
          background: "#fff",
          boxShadow: "0 1px 3px rgba(0,0,0,.2)",
        }}
      />
    </button>
  );
}
