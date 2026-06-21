"use client";

import { useEffect, useState } from "react";
import { UserRoundPlus, UserRoundPen, X } from "lucide-react";
import { Modal } from "@/components/Modal";
import type { CustomerDTO } from "@/types";

/**
 * The validated, normalized field set the parent POSTs/PATCHes. `taxId`/`address`/
 * `phone` are sent as a string (possibly empty); the server schema trims and
 * nulls empties. `buyerBranchCode` defaults to "00000" server-side when blank.
 */
export type CustomerFormInput = {
  name: string;
  taxId: string;
  address: string;
  phone: string;
  buyerBranchCode: string;
};

type CustomerFormModalProps = {
  open: boolean;
  /** When set, the modal is in EDIT mode and pre-fills from this customer. */
  editing: CustomerDTO | null;
  submitting: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (input: CustomerFormInput) => void;
};

/** Buyer TIN: exactly 13 digits (matches the server §86/4 rule). */
const TAXID_RE = /^\d{13}$/;
/** RD branch code: exactly 5 digits ("00000" = head office). */
const BRANCH_CODE_RE = /^\d{5}$/;

/**
 * Add / edit-customer modal (Phase 4 tax-invoice 4c). Ported from the Simple POS
 * "Customers · ข้อมูลลูกค้า · เลขผู้เสียภาษี · ที่อยู่ออกใบกำกับ" IA into the Taste
 * visual language (mirrors AddUserModal: shared Modal primitive, forest/mint
 * brand button, IBM Plex Sans Thai bilingual microcopy). Lets a cashier add or
 * fix a B2B tax customer mid-sale so a full §86/4 tax invoice can be issued.
 *
 * Client-side validation mirrors the server (CustomerPostBodySchema): name
 * non-empty (≤200); taxId optional but 13 digits when present; buyerBranchCode 5
 * digits when present. The server re-validates and owns TAXID_TAKEN/NOT_FOUND.
 */
export function CustomerFormModal({
  open,
  editing,
  submitting,
  error,
  onClose,
  onSubmit,
}: CustomerFormModalProps) {
  const isEdit = editing != null;

  const [name, setName] = useState("");
  const [taxId, setTaxId] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [buyerBranchCode, setBuyerBranchCode] = useState("");
  const [touched, setTouched] = useState(false);

  // Re-seed the fields whenever the modal opens (fresh for add, pre-filled for
  // edit). Depends on the editing identity so re-opening on a different row
  // refreshes the form.
  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? "");
    setTaxId(editing?.taxId ?? "");
    setAddress(editing?.address ?? "");
    setPhone(editing?.phone ?? "");
    setBuyerBranchCode(editing?.buyerBranchCode ?? "");
    setTouched(false);
  }, [open, editing]);

  const trimmedName = name.trim();
  const trimmedTax = taxId.trim();
  const trimmedBranch = buyerBranchCode.trim();

  const nameOk = trimmedName.length > 0 && trimmedName.length <= 200;
  // Optional fields are valid when empty; invalid only on a present-but-malformed value.
  const taxOk = trimmedTax.length === 0 || TAXID_RE.test(trimmedTax);
  const branchOk = trimmedBranch.length === 0 || BRANCH_CODE_RE.test(trimmedBranch);
  const canSubmit = nameOk && taxOk && branchOk && !submitting;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!canSubmit) return;
    onSubmit({
      name: trimmedName,
      taxId: trimmedTax,
      address: address.trim(),
      phone: phone.trim(),
      buyerBranchCode: trimmedBranch,
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      label={isEdit ? "แก้ไขลูกค้า" : "เพิ่มลูกค้าใหม่"}
    >
      <form
        onSubmit={handleSubmit}
        className="w-[min(460px,calc(100vw-32px))] rounded-[22px] bg-white"
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
            {isEdit ? (
              <UserRoundPen size={20} strokeWidth={2} />
            ) : (
              <UserRoundPlus size={20} strokeWidth={2} />
            )}
          </span>
          <div className="flex-1">
            <strong className="block text-[15px]">
              {isEdit ? "แก้ไขลูกค้า" : "เพิ่มลูกค้าใหม่"}
            </strong>
            <span className="block text-[11.5px]" style={{ color: "var(--muted)" }}>
              {isEdit
                ? "Edit customer · ข้อมูลผู้เสียภาษี"
                : "Add customer · เลขผู้เสียภาษี · ที่อยู่ออกใบกำกับ"}
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

        <div className="flex max-h-[64vh] flex-col gap-3.5 overflow-y-auto px-5 py-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold">ชื่อลูกค้า · Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="เช่น บริษัท สยามเทรด จำกัด"
              autoComplete="off"
              aria-invalid={touched && !nameOk}
              className="h-11 rounded-[12px] border px-3 text-[14px]"
              style={{ borderColor: touched && !nameOk ? "#fca5a5" : "var(--line)" }}
            />
            {touched && !nameOk && (
              <span className="text-[11.5px]" style={{ color: "#b42318" }}>
                กรุณากรอกชื่อลูกค้า
              </span>
            )}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold">
              เลขผู้เสียภาษี · Tax ID
            </span>
            <input
              type="text"
              inputMode="numeric"
              value={taxId}
              onChange={(e) => setTaxId(e.target.value)}
              placeholder="เลข 13 หลัก (เว้นว่างได้)"
              autoComplete="off"
              maxLength={13}
              aria-invalid={touched && !taxOk}
              className="mono h-11 rounded-[12px] border px-3 text-[14px]"
              style={{ borderColor: touched && !taxOk ? "#fca5a5" : "var(--line)" }}
            />
            {touched && !taxOk ? (
              <span className="text-[11.5px]" style={{ color: "#b42318" }}>
                เลขผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก
              </span>
            ) : (
              <span className="text-[11px]" style={{ color: "var(--muted)" }}>
                ต้องระบุเพื่อออกใบกำกับภาษีแบบเต็ม
              </span>
            )}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold">
              ที่อยู่ออกใบกำกับ · Address
            </span>
            <textarea
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="ที่อยู่สำหรับออกใบกำกับภาษี (เว้นว่างได้)"
              autoComplete="off"
              rows={2}
              maxLength={300}
              className="resize-none rounded-[12px] border px-3 py-2 text-[14px] leading-relaxed"
              style={{ borderColor: "var(--line)" }}
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-semibold">เบอร์โทร · Phone</span>
              <input
                type="text"
                inputMode="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="เว้นว่างได้"
                autoComplete="off"
                maxLength={30}
                className="h-11 rounded-[12px] border px-3 text-[14px]"
                style={{ borderColor: "var(--line)" }}
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-semibold">
                รหัสสาขา · Branch
              </span>
              <input
                type="text"
                inputMode="numeric"
                value={buyerBranchCode}
                onChange={(e) => setBuyerBranchCode(e.target.value)}
                placeholder="00000"
                autoComplete="off"
                maxLength={5}
                aria-invalid={touched && !branchOk}
                className="mono h-11 rounded-[12px] border px-3 text-[14px]"
                style={{
                  borderColor: touched && !branchOk ? "#fca5a5" : "var(--line)",
                }}
              />
              {touched && !branchOk ? (
                <span className="text-[11.5px]" style={{ color: "#b42318" }}>
                  รหัสสาขาต้องเป็นตัวเลข 5 หลัก
                </span>
              ) : (
                <span className="text-[11px]" style={{ color: "var(--muted)" }}>
                  00000 = สำนักงานใหญ่
                </span>
              )}
            </label>
          </div>

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
            {submitting
              ? "กำลังบันทึก…"
              : isEdit
                ? "บันทึกการแก้ไข"
                : "เพิ่มลูกค้า"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
