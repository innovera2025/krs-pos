"use client";

import { useEffect, useState } from "react";
import { UserPlus, X } from "lucide-react";
import { Modal } from "@/components/Modal";
import type { UiRole } from "@/components/users/userMeta";

type AddUserModalProps = {
  open: boolean;
  submitting: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (input: { name: string; email: string; role: UiRole }) => void;
};

// Same loose email shape as the server (and Simple POS add-user form).
const EMAIL_RE = /.+@.+\..+/;

/**
 * Add-user modal (overlay-add-user-modal). Validates name (non-empty) + email
 * (shape) client-side before posting; the server re-validates. New users always
 * start active with a placeholder password (set server-side).
 */
export function AddUserModal({
  open,
  submitting,
  error,
  onClose,
  onSubmit,
}: AddUserModalProps) {
  // action-set-nu-fields — the new-user field state.
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<UiRole>("seller");
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setName("");
      setEmail("");
      setRole("seller");
      setTouched(false);
    }
  }, [open]);

  const nameOk = name.trim().length > 0;
  const emailOk = EMAIL_RE.test(email.trim());
  const canSubmit = nameOk && emailOk && !submitting;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!canSubmit) return;
    onSubmit({ name: name.trim(), email: email.trim(), role });
  }

  return (
    <Modal open={open} onClose={onClose} label="เพิ่มผู้ใช้ใหม่">
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
            style={{ background: "#eef4ff", color: "#2563eb" }}
          >
            <UserPlus size={20} strokeWidth={2} />
          </span>
          <div className="flex-1">
            <strong className="block text-[15px]">เพิ่มผู้ใช้ใหม่</strong>
            <span className="block text-[11.5px]" style={{ color: "var(--muted)" }}>
              Add user · กำหนดบทบาทและสิทธิ์
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="ปิด"
            className="grid h-9 w-9 place-items-center rounded-[12px] border"
            style={{ borderColor: "var(--line)", color: "var(--muted)" }}
          >
            <X size={18} strokeWidth={2} />
          </button>
        </header>

        <div className="flex flex-col gap-3.5 px-5 py-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold">ชื่อ-นามสกุล · Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="เช่น สมชาย ใจดี"
              autoComplete="off"
              aria-invalid={touched && !nameOk}
              className="h-11 rounded-[12px] border px-3 text-[14px]"
              style={{ borderColor: touched && !nameOk ? "#fca5a5" : "var(--line)" }}
            />
            {touched && !nameOk && (
              <span className="text-[11.5px]" style={{ color: "#b42318" }}>
                กรุณากรอกชื่อผู้ใช้
              </span>
            )}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold">อีเมล · Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@krs-pos.local"
              autoComplete="off"
              aria-invalid={touched && !emailOk}
              className="h-11 rounded-[12px] border px-3 text-[14px]"
              style={{ borderColor: touched && !emailOk ? "#fca5a5" : "var(--line)" }}
            />
            {touched && !emailOk && (
              <span className="text-[11.5px]" style={{ color: "#b42318" }}>
                อีเมลไม่ถูกต้อง
              </span>
            )}
          </label>

          <fieldset className="flex flex-col gap-1.5 border-0 p-0">
            <legend className="mb-1 text-[12.5px] font-semibold">บทบาท · Role</legend>
            <div className="grid grid-cols-2 gap-2.5">
              <RoleOption
                active={role === "seller"}
                label="ผู้ขาย"
                sub="Seller · POS เท่านั้น"
                onClick={() => setRole("seller")}
              />
              <RoleOption
                active={role === "admin"}
                label="Admin"
                sub="ผู้ดูแล · ทุกสิทธิ์"
                onClick={() => setRole("admin")}
              />
            </div>
          </fieldset>

          {error && (
            <p
              role="alert"
              className="m-0 rounded-[12px] px-3 py-2 text-[12.5px]"
              style={{ background: "var(--red-soft)", color: "#b42318" }}
            >
              {error}
            </p>
          )}
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
            {submitting ? "กำลังบันทึก…" : "เพิ่มผู้ใช้"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function RoleOption({
  active,
  label,
  sub,
  onClick,
}: {
  active: boolean;
  label: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="flex flex-col items-start gap-0.5 rounded-[14px] border px-3.5 py-2.5 text-left transition"
      style={{
        borderColor: active ? "var(--brand)" : "var(--line)",
        background: active ? "var(--mint)" : "#fff",
      }}
    >
      <strong className="text-[13.5px]" style={{ color: active ? "var(--brand-2)" : "var(--ink)" }}>
        {label}
      </strong>
      <span className="text-[11px]" style={{ color: "var(--muted)" }}>
        {sub}
      </span>
    </button>
  );
}
