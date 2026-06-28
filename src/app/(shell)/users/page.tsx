"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Plus,
  AlertTriangle,
  ShieldCheck,
  UserRound,
  Check,
  X as XIcon,
  Lock,
  KeyRound,
  LogOut,
  Unlock,
  Eye,
  EyeOff,
  Warehouse as WarehouseIcon,
} from "lucide-react";
import { useToast } from "@/components/ToastProvider";
import { AdminOnly } from "@/components/AdminOnly";
import { AddUserModal } from "@/components/users/AddUserModal";
import { Modal } from "@/components/Modal";
import type { Warehouse } from "@/types";
import {
  ADMIN_PERMISSIONS,
  SELLER_PERMISSIONS,
  initials,
  isAdminTier,
  isLocked,
  roleLabel,
  uiRoleToEnum,
  type UiRole,
  type UserDTO,
} from "@/components/users/userMeta";

/** Minimum password length — mirrors the server (auth Phase 3). */
const MIN_PASSWORD_LEN = 8;

type LoadState = "loading" | "ready" | "error";
type FilterChip = "all" | "seller" | "admin";

export default function UsersPage() {
  return (
    <AdminOnly>
      <UsersScreen />
    </AdminOnly>
  );
}

function UsersScreen() {
  const { showToast } = useToast();

  const [users, setUsers] = useState<UserDTO[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [filter, setFilter] = useState<FilterChip>("all");

  // Warehouse master (Branch/Warehouse program, Phase 2) — feeds the add/edit
  // pickers AND the 'สาขา' column display (the branch is DERIVED from this list by
  // warehouseCode). Best-effort: a failed fetch just leaves the picker empty.
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);

  // Edit-warehouse modal (Phase 2): the user whose warehouse is being reassigned.
  const [warehouseTarget, setWarehouseTarget] = useState<UserDTO | null>(null);
  const [warehouseSubmitting, setWarehouseSubmitting] = useState(false);

  // Add-user modal.
  const [addOpen, setAddOpen] = useState(false);
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [addError, setAddError] = useState("");

  // Per-row toggle in-flight ids (to disable the toggle while patching).
  const [togglingId, setTogglingId] = useState<string | null>(null);
  // Per-row action in-flight id (force-logout / unlock) to disable while patching.
  const [actingId, setActingId] = useState<string | null>(null);

  // Reset-password modal (auth Phase 3).
  const [resetTarget, setResetTarget] = useState<UserDTO | null>(null);
  const [resetSubmitting, setResetSubmitting] = useState(false);

  async function loadUsers() {
    setLoadState("loading");
    try {
      const res = await fetch("/api/users");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as UserDTO[];
      setUsers(Array.isArray(data) ? data : []);
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }

  // Load the warehouse master for the picker + 'สาขา' column (Phase 2). Best-effort
  // — on failure the picker is simply empty and the column falls back to the code.
  async function loadWarehouses() {
    try {
      const res = await fetch("/api/warehouses");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Warehouse[];
      setWarehouses(Array.isArray(data) ? data : []);
    } catch {
      setWarehouses([]);
    }
  }

  useEffect(() => {
    loadUsers();
    loadWarehouses();
  }, []);

  // warehouseCode → Warehouse lookup so the 'สาขา' column can DERIVE the branch and
  // human name from the master list without trusting a client-stored branchCode.
  const warehouseByCode = useMemo(() => {
    const m = new Map<string, Warehouse>();
    for (const w of warehouses) m.set(w.warehouseCode, w);
    return m;
  }, [warehouses]);

  // Filter chips: ทั้งหมด / ผู้ขาย (CASHIER) / Admin (ADMIN+MANAGER).
  const filtered = useMemo(() => {
    if (filter === "all") return users;
    if (filter === "admin") return users.filter((u) => isAdminTier(u.role));
    return users.filter((u) => !isAdminTier(u.role));
  }, [users, filter]);

  // ---- add user ----
  function openAdd() {
    setAddError("");
    setAddOpen(true);
  }

  async function submitAdd(input: {
    name: string;
    email: string;
    role: UiRole;
    password: string;
    warehouseCode: string | null;
  }) {
    setAddSubmitting(true);
    setAddError("");
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: input.name,
          email: input.email,
          role: uiRoleToEnum(input.role),
          password: input.password,
          // Phase 2: null = unassigned; the server re-validates against the
          // Warehouse master (never trusts the client).
          warehouseCode: input.warehouseCode,
        }),
      });
      if (!res.ok) {
        let msg = "เพิ่มผู้ใช้ไม่สำเร็จ";
        try {
          const data = await res.json();
          if (data?.error) msg = data.error;
        } catch {
          /* keep default */
        }
        setAddError(msg);
        return;
      }
      const created = (await res.json()) as UserDTO;
      // Prepend the created user (matches Simple POS add-user behavior).
      setUsers((prev) => [created, ...prev]);
      setAddOpen(false);
      showToast("เพิ่มผู้ใช้แล้ว");
    } catch {
      setAddError("เพิ่มผู้ใช้ไม่สำเร็จ");
    } finally {
      setAddSubmitting(false);
    }
  }

  // ---- activate / deactivate (no destructive delete) ----
  async function toggleActive(user: UserDTO) {
    if (togglingId) return;
    setTogglingId(user.id);
    try {
      const res = await fetch(`/api/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !user.isActive }),
      });
      if (!res.ok) {
        showToast("อัปเดตสถานะไม่สำเร็จ");
        return;
      }
      const updated = (await res.json()) as UserDTO;
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
      showToast(updated.isActive ? "เปิดใช้งานผู้ใช้แล้ว" : "ปิดใช้งานผู้ใช้แล้ว");
    } catch {
      showToast("อัปเดตสถานะไม่สำเร็จ");
    } finally {
      setTogglingId(null);
    }
  }

  // ---- admin reset password (auth Phase 3: PATCH {password}) ----
  async function submitResetPassword(password: string) {
    if (!resetTarget) return;
    setResetSubmitting(true);
    try {
      const res = await fetch(`/api/users/${resetTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        showToast("รีเซ็ตรหัสผ่านไม่สำเร็จ");
        return;
      }
      const updated = (await res.json()) as UserDTO;
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
      setResetTarget(null);
      showToast("รีเซ็ตรหัสผ่านแล้ว");
    } catch {
      showToast("รีเซ็ตรหัสผ่านไม่สำเร็จ");
    } finally {
      setResetSubmitting(false);
    }
  }

  // ---- admin force-logout (auth Phase 3: PATCH {action:"forceLogout"}) ----
  async function forceLogout(user: UserDTO) {
    if (actingId) return;
    setActingId(user.id);
    try {
      const res = await fetch(`/api/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "forceLogout" }),
      });
      if (!res.ok) {
        showToast("บังคับออกจากระบบไม่สำเร็จ");
        return;
      }
      const updated = (await res.json()) as UserDTO;
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
      showToast("บังคับออกจากระบบแล้ว");
    } catch {
      showToast("บังคับออกจากระบบไม่สำเร็จ");
    } finally {
      setActingId(null);
    }
  }

  // ---- admin unlock (auth Phase 3: PATCH {action:"unlock"}) ----
  async function unlockUser(user: UserDTO) {
    if (actingId) return;
    setActingId(user.id);
    try {
      const res = await fetch(`/api/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unlock" }),
      });
      if (!res.ok) {
        showToast("ปลดล็อกไม่สำเร็จ");
        return;
      }
      const updated = (await res.json()) as UserDTO;
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
      showToast("ปลดล็อกบัญชีแล้ว");
    } catch {
      showToast("ปลดล็อกไม่สำเร็จ");
    } finally {
      setActingId(null);
    }
  }

  // ---- admin assign/clear warehouse (Phase 2: PATCH {warehouseCode}) ----
  // `warehouseCode` is the chosen KRS WarehouseCode, or null = clear assignment.
  // The server re-validates against the Warehouse master before persisting.
  async function submitWarehouse(warehouseCode: string | null) {
    if (!warehouseTarget) return;
    setWarehouseSubmitting(true);
    try {
      const res = await fetch(`/api/users/${warehouseTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ warehouseCode }),
      });
      if (!res.ok) {
        let msg = "อัปเดตคลังไม่สำเร็จ";
        try {
          const data = await res.json();
          if (data?.error) msg = data.error;
        } catch {
          /* keep default */
        }
        showToast(msg);
        return;
      }
      const updated = (await res.json()) as UserDTO;
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
      setWarehouseTarget(null);
      showToast("อัปเดตคลังแล้ว");
    } catch {
      showToast("อัปเดตคลังไม่สำเร็จ");
    } finally {
      setWarehouseSubmitting(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-[22px]">
      {/* Header */}
      <header className="flex flex-wrap items-center gap-3.5">
        <div className="flex-1 min-w-[220px]">
          <h1 className="m-0 text-[24px] font-bold leading-[1.08] tracking-tight">
            จัดการผู้ใช้และสิทธิ์
          </h1>
          <p className="mt-1 text-[12.5px]" style={{ color: "var(--muted)" }}>
            Users &amp; Roles · กำหนดบทบาท เปิด/ปิดการใช้งาน
          </p>
        </div>
        <button
          type="button"
          onClick={openAdd}
          className="flex h-11 items-center gap-2 rounded-[14px] px-4 text-[13.5px] font-bold text-white"
          style={{ background: "var(--brand)", boxShadow: "var(--shadow-sm)" }}
        >
          <Plus size={17} strokeWidth={2.5} /> เพิ่มผู้ใช้
        </button>
      </header>

      {/* Role-permission summary cards */}
      <section className="grid gap-3.5" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))" }}>
        <PermissionCard
          title="ผู้ขาย · Seller"
          icon={<UserRound size={18} strokeWidth={2} />}
          accent="#2563eb"
          accentSoft="#eef4ff"
          allowed={SELLER_PERMISSIONS.allowed}
          denied={SELLER_PERMISSIONS.denied}
        />
        <PermissionCard
          title="Admin · ผู้ดูแล"
          icon={<ShieldCheck size={18} strokeWidth={2} />}
          accent="var(--brand-2)"
          accentSoft="var(--mint)"
          allowed={ADMIN_PERMISSIONS.allowed}
          denied={ADMIN_PERMISSIONS.denied}
        />
      </section>

      {/* Filter chips */}
      <div className="flex flex-wrap items-center gap-2">
        <Chip active={filter === "all"} onClick={() => setFilter("all")}>
          ทั้งหมด
        </Chip>
        <Chip active={filter === "seller"} onClick={() => setFilter("seller")}>
          ผู้ขาย
        </Chip>
        <Chip active={filter === "admin"} onClick={() => setFilter("admin")}>
          Admin
        </Chip>
      </div>

      {/* User table */}
      <section
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[18px] border bg-white"
        style={{ borderColor: "var(--line)", boxShadow: "var(--shadow-sm)" }}
      >
        {loadState === "loading" ? (
          <div
            className="grid flex-1 place-items-center py-16 text-center text-[13px]"
            style={{ color: "var(--soft)" }}
          >
            กำลังโหลดผู้ใช้…
          </div>
        ) : loadState === "error" ? (
          <div
            className="mx-auto flex max-w-[320px] flex-1 flex-col items-center justify-center gap-3 py-16 text-center"
            style={{ color: "var(--muted)" }}
          >
            <span
              className="grid h-[64px] w-[64px] place-items-center rounded-[22px]"
              style={{ background: "var(--red-soft)", color: "#dc2626" }}
            >
              <AlertTriangle size={28} strokeWidth={2} />
            </span>
            <strong className="text-[14px]" style={{ color: "var(--ink)" }}>
              โหลดผู้ใช้ไม่สำเร็จ
            </strong>
            <button
              type="button"
              onClick={loadUsers}
              className="h-10 rounded-[12px] border px-4 text-[13px] font-semibold"
              style={{ borderColor: "var(--line)" }}
            >
              ลองใหม่
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div
            className="grid flex-1 place-items-center py-16 text-center text-[13px]"
            style={{ color: "var(--soft)" }}
          >
            ไม่พบผู้ใช้ในตัวกรองนี้
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr
                  className="sticky top-0 z-10 text-left"
                  style={{ background: "var(--surface-2)", color: "var(--muted)" }}
                >
                  <Th>ผู้ใช้</Th>
                  <Th>อีเมล</Th>
                  <Th>บทบาท</Th>
                  <Th>สาขา</Th>
                  <Th>สถานะ</Th>
                  <Th className="text-right">จัดการ</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((u) => (
                  <tr key={u.id} className="border-t" style={{ borderColor: "var(--line)" }}>
                    <Td>
                      <div className="flex items-center gap-2.5">
                        <span
                          aria-hidden="true"
                          className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-full text-[12px] font-bold"
                          style={{
                            background: isAdminTier(u.role) ? "var(--mint)" : "#eef4ff",
                            color: isAdminTier(u.role) ? "var(--brand-2)" : "#2563eb",
                          }}
                        >
                          {initials(u.name)}
                        </span>
                        <span className="font-semibold" style={{ opacity: u.isActive ? 1 : 0.55 }}>
                          {u.name}
                        </span>
                      </div>
                    </Td>
                    <Td>
                      <span className="mono text-[12px]" style={{ color: "var(--muted)" }}>
                        {u.email}
                      </span>
                    </Td>
                    <Td>
                      <span
                        className="inline-flex items-center rounded-full px-2.5 py-1 text-[11.5px] font-semibold"
                        style={{
                          background: isAdminTier(u.role) ? "var(--mint)" : "#eef4ff",
                          color: isAdminTier(u.role) ? "var(--brand-2)" : "#2563eb",
                        }}
                      >
                        {roleLabel(u.role)}
                      </span>
                    </Td>
                    <Td>
                      {(() => {
                        const wh = u.warehouseCode
                          ? warehouseByCode.get(u.warehouseCode)
                          : undefined;
                        return (
                          <div className="flex flex-col items-start gap-1">
                            {u.warehouseCode ? (
                              <>
                                <span className="font-semibold text-[12.5px]">
                                  {wh ? wh.warehouseName : "คลัง"}
                                </span>
                                <span
                                  className="mono text-[11.5px]"
                                  style={{ color: "var(--muted)" }}
                                >
                                  {u.warehouseCode}
                                  {wh ? ` · สาขา ${wh.branchCode}` : ""}
                                </span>
                              </>
                            ) : (
                              <span
                                className="text-[12.5px]"
                                style={{ color: "var(--soft)" }}
                              >
                                — ไม่ระบุคลัง —
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => setWarehouseTarget(u)}
                              aria-label={`แก้ไขคลัง ${u.name}`}
                              className="inline-flex h-7 items-center gap-1 rounded-[9px] border px-2 text-[11.5px] font-semibold"
                              style={{ borderColor: "var(--line)", color: "var(--brand-2)" }}
                            >
                              <WarehouseIcon size={12} strokeWidth={2} aria-hidden="true" />
                              แก้ไขคลัง
                            </button>
                          </div>
                        );
                      })()}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-semibold"
                          style={{
                            background: u.isActive ? "var(--mint)" : "#f2f4f7",
                            color: u.isActive ? "var(--brand-2)" : "var(--soft)",
                          }}
                        >
                          {u.isActive ? "ใช้งานอยู่" : "ปิดใช้งาน"}
                        </span>
                        {isLocked(u) && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-semibold"
                            style={{ background: "var(--red-soft)", color: "#b42318" }}
                          >
                            <Lock size={11} strokeWidth={2.5} aria-hidden="true" />
                            ล็อกอยู่ · Locked
                          </span>
                        )}
                      </div>
                    </Td>
                    <Td className="text-right">
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        {isLocked(u) && (
                          <button
                            type="button"
                            onClick={() => unlockUser(u)}
                            disabled={actingId === u.id}
                            aria-label={`ปลดล็อก ${u.name}`}
                            className="inline-flex h-9 items-center gap-1.5 rounded-[11px] border px-3 text-[12.5px] font-semibold disabled:opacity-50"
                            style={{ borderColor: "var(--line)", color: "var(--brand-2)" }}
                          >
                            <Unlock size={14} strokeWidth={2} aria-hidden="true" />
                            ปลดล็อก
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setResetTarget(u)}
                          aria-label={`รีเซ็ตรหัสผ่าน ${u.name}`}
                          className="inline-flex h-9 items-center gap-1.5 rounded-[11px] border px-3 text-[12.5px] font-semibold"
                          style={{ borderColor: "var(--line)", color: "var(--ink)" }}
                        >
                          <KeyRound size={14} strokeWidth={2} aria-hidden="true" />
                          รีเซ็ตรหัสผ่าน
                        </button>
                        <button
                          type="button"
                          onClick={() => forceLogout(u)}
                          disabled={actingId === u.id}
                          aria-label={`บังคับออกจากระบบ ${u.name}`}
                          className="inline-flex h-9 items-center gap-1.5 rounded-[11px] border px-3 text-[12.5px] font-semibold disabled:opacity-50"
                          style={{ borderColor: "var(--line)", color: "var(--ink)" }}
                        >
                          <LogOut size={14} strokeWidth={2} aria-hidden="true" />
                          บังคับออกจากระบบ
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleActive(u)}
                          disabled={togglingId === u.id}
                          aria-label={`${u.isActive ? "ปิดใช้งาน" : "เปิดใช้งาน"} ${u.name}`}
                          className="h-9 rounded-[11px] border px-3 text-[12.5px] font-semibold disabled:opacity-50"
                          style={{
                            borderColor: "var(--line)",
                            color: u.isActive ? "#b42318" : "var(--brand-2)",
                          }}
                        >
                          {togglingId === u.id
                            ? "กำลังบันทึก…"
                            : u.isActive
                            ? "ปิดใช้งาน"
                            : "เปิดใช้งาน"}
                        </button>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <AddUserModal
        open={addOpen}
        submitting={addSubmitting}
        error={addError}
        warehouses={warehouses}
        onClose={() => setAddOpen(false)}
        onSubmit={submitAdd}
      />

      <ResetPasswordModal
        target={resetTarget}
        submitting={resetSubmitting}
        onClose={() => setResetTarget(null)}
        onSubmit={submitResetPassword}
      />

      <EditWarehouseModal
        target={warehouseTarget}
        warehouses={warehouses}
        submitting={warehouseSubmitting}
        onClose={() => setWarehouseTarget(null)}
        onSubmit={submitWarehouse}
      />
    </div>
  );
}

/**
 * Admin reset-password modal (auth Phase 3). Sets a new password for the target
 * user via PATCH {password}; the server hashes it (bcrypt 12) and the old
 * password stops working immediately. Validates min length client-side; the
 * server re-validates.
 */
function ResetPasswordModal({
  target,
  submitting,
  onClose,
  onSubmit,
}: {
  target: UserDTO | null;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (password: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [touched, setTouched] = useState(false);

  const open = target !== null;

  useEffect(() => {
    if (open) {
      setPassword("");
      setShowPassword(false);
      setTouched(false);
    }
  }, [open]);

  const passwordOk = password.length >= MIN_PASSWORD_LEN;
  const canSubmit = passwordOk && !submitting;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!canSubmit) return;
    onSubmit(password);
  }

  return (
    <Modal open={open} onClose={onClose} label="รีเซ็ตรหัสผ่าน">
      <form
        onSubmit={handleSubmit}
        className="w-[min(440px,calc(100vw-32px))] rounded-[22px] bg-white"
        style={{ boxShadow: "var(--shadow)" }}
      >
        <header
          className="flex items-center gap-3 border-b px-5 py-4"
          style={{ borderColor: "var(--line)" }}
        >
          <span
            className="grid h-10 w-10 place-items-center rounded-[14px]"
            style={{ background: "var(--mint)", color: "var(--brand-2)" }}
          >
            <KeyRound size={20} strokeWidth={2} />
          </span>
          <div className="flex-1">
            <strong className="block text-[15px]">รีเซ็ตรหัสผ่าน</strong>
            <span className="block text-[11.5px]" style={{ color: "var(--muted)" }}>
              Reset password{target ? ` · ${target.name}` : ""}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="ปิด"
            className="grid h-9 w-9 place-items-center rounded-[12px] border"
            style={{ borderColor: "var(--line)", color: "var(--muted)" }}
          >
            <XIcon size={18} strokeWidth={2} />
          </button>
        </header>

        <div className="flex flex-col gap-3.5 px-5 py-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold">
              รหัสผ่านใหม่ · New password
            </span>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="อย่างน้อย 8 ตัวอักษร"
                autoComplete="new-password"
                aria-invalid={touched && !passwordOk}
                className="h-11 w-full rounded-[12px] border pl-3 pr-11 text-[14px]"
                style={{
                  borderColor: touched && !passwordOk ? "#fca5a5" : "var(--line)",
                }}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={
                  showPassword
                    ? "ซ่อนรหัสผ่าน · Hide password"
                    : "แสดงรหัสผ่าน · Show password"
                }
                className="absolute right-0 top-0 grid h-11 w-11 place-items-center"
                style={{ color: "var(--soft)" }}
              >
                {showPassword ? (
                  <EyeOff size={18} strokeWidth={2} />
                ) : (
                  <Eye size={18} strokeWidth={2} />
                )}
              </button>
            </div>
            {touched && !passwordOk && (
              <span className="text-[11.5px]" style={{ color: "#b42318" }}>
                รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร
              </span>
            )}
          </label>
        </div>

        <footer
          className="flex justify-end gap-2.5 border-t px-5 py-4"
          style={{ borderColor: "var(--line)" }}
        >
          <button
            type="button"
            onClick={onClose}
            className="h-11 rounded-[12px] border px-4 text-[13.5px] font-semibold"
            style={{ borderColor: "var(--line)", color: "var(--ink)" }}
          >
            ยกเลิก
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="h-11 rounded-[12px] px-5 text-[13.5px] font-bold text-white disabled:opacity-50"
            style={{ background: "var(--brand)" }}
          >
            {submitting ? "กำลังบันทึก…" : "รีเซ็ตรหัสผ่าน"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

/**
 * Edit-warehouse modal (Branch/Warehouse program, Phase 2). Assigns or clears the
 * target user's KRS WarehouseCode via PATCH {warehouseCode}. The picker offers
 * "— ไม่ระบุ —" (clear → null) plus every warehouse from the master list; the
 * server re-validates the chosen code against the Warehouse table. The branch shown
 * per option is DERIVED from the master (never a client-stored branchCode). Admin-
 * gated by the page wrapper (AdminOnly) and the requireAdmin PATCH route.
 */
function EditWarehouseModal({
  target,
  warehouses,
  submitting,
  onClose,
  onSubmit,
}: {
  target: UserDTO | null;
  warehouses: Warehouse[];
  submitting: boolean;
  onClose: () => void;
  onSubmit: (warehouseCode: string | null) => void;
}) {
  const [warehouseCode, setWarehouseCode] = useState("");

  const open = target !== null;

  useEffect(() => {
    if (open) {
      // Prefill with the user's current assignment ("" = unassigned).
      setWarehouseCode(target?.warehouseCode ?? "");
    }
  }, [open, target]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    // "" → null clears the assignment; the server re-validates a non-null code.
    onSubmit(warehouseCode || null);
  }

  return (
    <Modal open={open} onClose={onClose} label="แก้ไขคลัง / สาขา">
      <form
        onSubmit={handleSubmit}
        className="w-[min(440px,calc(100vw-32px))] rounded-[22px] bg-white"
        style={{ boxShadow: "var(--shadow)" }}
      >
        <header
          className="flex items-center gap-3 border-b px-5 py-4"
          style={{ borderColor: "var(--line)" }}
        >
          <span
            className="grid h-10 w-10 place-items-center rounded-[14px]"
            style={{ background: "var(--mint)", color: "var(--brand-2)" }}
          >
            <WarehouseIcon size={20} strokeWidth={2} />
          </span>
          <div className="flex-1">
            <strong className="block text-[15px]">แก้ไขคลัง / สาขา</strong>
            <span className="block text-[11.5px]" style={{ color: "var(--muted)" }}>
              Warehouse{target ? ` · ${target.name}` : ""}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="ปิด"
            className="grid h-9 w-9 place-items-center rounded-[12px] border"
            style={{ borderColor: "var(--line)", color: "var(--muted)" }}
          >
            <XIcon size={18} strokeWidth={2} />
          </button>
        </header>

        <div className="flex flex-col gap-3.5 px-5 py-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold">คลัง / สาขา · Warehouse</span>
            <select
              value={warehouseCode}
              onChange={(e) => setWarehouseCode(e.target.value)}
              className="h-11 rounded-[12px] border bg-white px-3 text-[14px]"
              style={{ borderColor: "var(--line)" }}
            >
              <option value="">— ไม่ระบุ —</option>
              {warehouses.map((w) => (
                <option key={w.warehouseCode} value={w.warehouseCode}>
                  {w.warehouseName} ({w.warehouseCode}) · สาขา {w.branchCode}
                </option>
              ))}
            </select>
          </label>
        </div>

        <footer
          className="flex justify-end gap-2.5 border-t px-5 py-4"
          style={{ borderColor: "var(--line)" }}
        >
          <button
            type="button"
            onClick={onClose}
            className="h-11 rounded-[12px] border px-4 text-[13.5px] font-semibold"
            style={{ borderColor: "var(--line)", color: "var(--ink)" }}
          >
            ยกเลิก
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="h-11 rounded-[12px] px-5 text-[13.5px] font-bold text-white disabled:opacity-50"
            style={{ background: "var(--brand)" }}
          >
            {submitting ? "กำลังบันทึก…" : "บันทึก"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function PermissionCard({
  title,
  icon,
  accent,
  accentSoft,
  allowed,
  denied,
}: {
  title: string;
  icon: React.ReactNode;
  accent: string;
  accentSoft: string;
  allowed: string[];
  denied: string[];
}) {
  return (
    <div
      className="flex flex-col gap-3 rounded-[18px] border bg-white p-4"
      style={{ borderColor: "var(--line)", boxShadow: "var(--shadow-sm)" }}
    >
      <div className="flex items-center gap-2.5">
        <span
          className="grid h-9 w-9 place-items-center rounded-[12px]"
          style={{ background: accentSoft, color: accent }}
        >
          {icon}
        </span>
        <strong className="text-[14.5px]">{title}</strong>
      </div>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {allowed.map((cap) => (
          <li key={cap} className="flex items-center gap-2 text-[12.5px]">
            <Check size={14} strokeWidth={2.5} color="var(--brand-2)" />
            <span>{cap}</span>
          </li>
        ))}
        {denied.map((cap) => (
          <li
            key={cap}
            className="flex items-center gap-2 text-[12.5px]"
            style={{ color: "var(--soft)" }}
          >
            <XIcon size={14} strokeWidth={2.5} color="#cbd5e1" />
            <span className="line-through">{cap}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="h-9 rounded-full border px-4 text-[12.5px] font-semibold transition"
      style={{
        borderColor: active ? "var(--brand)" : "var(--line)",
        background: active ? "var(--brand)" : "#fff",
        color: active ? "#fff" : "var(--ink)",
      }}
    >
      {children}
    </button>
  );
}

function Th({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th className={`px-4 py-2.5 text-[11.5px] font-semibold uppercase tracking-wide ${className}`}>
      {children}
    </th>
  );
}

function Td({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-4 py-3 align-middle ${className}`}>{children}</td>;
}
