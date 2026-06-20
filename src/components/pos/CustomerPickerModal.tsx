"use client";

import { useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import { Modal } from "@/components/Modal";
import type { CustomerDTO } from "@/types";

type CustomerPickerModalProps = {
  open: boolean;
  /** Pick a named customer (action-pick-customer). */
  onPick: (customer: CustomerDTO) => void;
  /** Pick walk-in / clear the selected customer (pick-walkin). */
  onPickWalkIn: () => void;
  /** Close without changing the selection (close-customer-picker / X / Escape). */
  onClose: () => void;
};

type FetchState = "idle" | "loading" | "ready" | "error";

/** First-grapheme initials for the round avatar (e.g. "บริษัท สยามเทรด" → "บส"). */
function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2);
  return (parts[0][0] ?? "") + (parts[1][0] ?? "");
}

/** Has a usable tax id? Drives the "มีข้อมูลภาษี" badge + tax-invoice eligibility. */
function hasTax(c: CustomerDTO): boolean {
  return typeof c.taxId === "string" && c.taxId.trim().length > 0;
}

/**
 * Customer picker modal (overlay-customer-picker), ported from the Simple POS
 * source-of-truth into Taste. A search field (name OR tax ID), a walk-in option
 * pinned at the top, then the fetched customer list with avatar initials, name,
 * sub line (taxId/phone), and a blue "มีข้อมูลภาษี" badge when the customer has a
 * tax id. Reuses the shared Modal primitive for backdrop/Escape/focus-trap.
 *
 * The picker only SELECTS seeded customers (no add-customer in 6a). Search is
 * client-side over the fetched list so typing stays instant.
 */
export function CustomerPickerModal({
  open,
  onPick,
  onPickWalkIn,
  onClose,
}: CustomerPickerModalProps) {
  const [query, setQuery] = useState("");
  const [customers, setCustomers] = useState<CustomerDTO[]>([]);
  const [state, setState] = useState<FetchState>("idle");

  // Fetch the customer list once per open. Reset query on open so a re-open is
  // a fresh search.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    const ctrl = new AbortController();
    setState("loading");
    fetch("/api/customers", { signal: ctrl.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: CustomerDTO[]) => {
        if (ctrl.signal.aborted) return;
        setCustomers(Array.isArray(data) ? data : []);
        setState("ready");
      })
      .catch((err) => {
        if (err?.name === "AbortError" || ctrl.signal.aborted) return;
        setState("error");
      });
    return () => ctrl.abort();
  }, [open]);

  // Client-side filter: case-insensitive substring on name OR taxId.
  const q = query.trim().toLowerCase();
  const filtered = q
    ? customers.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          (c.taxId ?? "").toLowerCase().includes(q)
      )
    : customers;

  return (
    <Modal open={open} onClose={onClose} label="เลือกลูกค้า">
      <div
        className="flex max-h-[78vh] w-[460px] max-w-[94vw] flex-col overflow-hidden rounded-[16px] bg-white"
        style={{ boxShadow: "0 24px 60px rgba(0,0,0,.3)" }}
      >
        {/* Header + search */}
        <div className="border-b px-[18px] py-4" style={{ borderColor: "#f1f5f9" }}>
          <div className="text-[15px] font-bold">เลือกลูกค้า · Select customer</div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ค้นหาชื่อ / เลขภาษี · Search name or tax ID"
            aria-label="ค้นหาลูกค้า"
            autoComplete="off"
            className="mt-[11px] h-[42px] w-full rounded-[10px] border px-[13px] text-[13.5px] outline-none"
            style={{ borderColor: "#e2e8f0" }}
          />
        </div>

        {/* List */}
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {/* Walk-in option (always first) */}
          <button
            type="button"
            onClick={onPickWalkIn}
            className="flex w-full items-center gap-3 rounded-[11px] p-3 text-left transition hover:bg-[#f1f5f9]"
          >
            <span
              className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-full"
              style={{ background: "#f1f5f9", color: "#64748b" }}
            >
              <UserRound size={20} strokeWidth={2} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-semibold">
                ลูกค้าทั่วไป · Walk-in
              </span>
              <span className="block text-[11.5px]" style={{ color: "#94a3b8" }}>
                ไม่ระบุข้อมูลลูกค้า
              </span>
            </span>
          </button>

          {state === "loading" && (
            <div
              className="py-8 text-center text-[13px]"
              style={{ color: "#94a3b8" }}
            >
              กำลังโหลดลูกค้า…
            </div>
          )}
          {state === "error" && (
            <div
              className="py-8 text-center text-[13px]"
              style={{ color: "#dc2626" }}
            >
              โหลดรายชื่อลูกค้าไม่สำเร็จ
            </div>
          )}
          {state === "ready" && filtered.length === 0 && (
            <div
              className="py-8 text-center text-[13px]"
              style={{ color: "#94a3b8" }}
            >
              ไม่พบลูกค้า · No matching customers
            </div>
          )}

          {state === "ready" &&
            filtered.map((c) => {
              const taxOk = hasTax(c);
              const sub = taxOk
                ? `TIN ${c.taxId}`
                : c.phone
                  ? c.phone
                  : "สมาชิก · ไม่มีเลขภาษี";
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onPick(c)}
                  className="flex w-full items-center gap-3 rounded-[11px] p-3 text-left transition hover:bg-[#f1f5f9]"
                >
                  <span
                    className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-full text-[13px] font-semibold"
                    style={{ background: "#e0e7ff", color: "#4338ca" }}
                  >
                    {initialsFor(c.name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-semibold">
                      {c.name}
                    </span>
                    <span
                      className="mono block truncate text-[11.5px]"
                      style={{ color: "#94a3b8" }}
                    >
                      {sub}
                    </span>
                  </span>
                  {taxOk && (
                    <span
                      className="flex-shrink-0 rounded-md px-2 py-[3px] text-[10px] font-semibold"
                      style={{
                        background: "#eff6ff",
                        color: "#2563eb",
                        border: "1px solid #bfdbfe",
                      }}
                    >
                      มีข้อมูลภาษี
                    </span>
                  )}
                </button>
              );
            })}
        </div>
      </div>
    </Modal>
  );
}
