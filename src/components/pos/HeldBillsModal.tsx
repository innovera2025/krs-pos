"use client";

import { useEffect, useState } from "react";
import { Receipt, Trash2, X } from "lucide-react";
import { Modal } from "@/components/Modal";
import { formatSatang } from "@/lib/money";
import type { HeldBillDTO } from "@/types";

type HeldBillsModalProps = {
  open: boolean;
  /** Close without changing anything (X / backdrop / Escape). */
  onClose: () => void;
  /** Resume a parked bill back into the cart (delete-then-restore, owned by the parent). */
  onResume: (id: string, bill: HeldBillDTO) => void;
  /**
   * Discard a parked bill without resuming it. Returns true on success / false on a
   * failed DELETE so this modal can roll back its optimistic row removal (L1).
   */
  onDiscard: (id: string) => Promise<boolean> | void;
};

type FetchState = "idle" | "loading" | "ready" | "error";

/**
 * Held-bills modal (พักบิล · Held Bills). Lists the current cashier's parked bills
 * fetched on open (loading/error/empty states mirror CustomerPickerModal). Each row
 * shows the park label ("HH:MM · {N} รายการ"), the item count, the captured total, and
 * the customer name (or ลูกค้าทั่วไป), with "เรียกคืน" (resume) + "ลบ" (discard)
 * actions. Resume hands off to the parent (which deletes the bill atomically THEN
 * rebuilds the cart) and closes the modal; discard optimistically removes the row.
 *
 * Reuses the shared Modal primitive (backdrop/Escape/focus-trap) + Taste styling.
 */
export function HeldBillsModal({
  open,
  onClose,
  onResume,
  onDiscard,
}: HeldBillsModalProps) {
  const [bills, setBills] = useState<HeldBillDTO[]>([]);
  const [state, setState] = useState<FetchState>("idle");

  // Fetch the held-bill list on open. The parent keeps the badge count in sync; this
  // modal owns the detailed list shown while it is open.
  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setState("loading");
    fetch("/api/held-bills", { signal: ctrl.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: HeldBillDTO[]) => {
        if (ctrl.signal.aborted) return;
        setBills(Array.isArray(data) ? data : []);
        setState("ready");
      })
      .catch((err) => {
        if (err?.name === "AbortError" || ctrl.signal.aborted) return;
        setState("error");
      });
    return () => ctrl.abort();
  }, [open]);

  // Optimistically drop a discarded row, then delegate the DELETE to the parent. If the
  // DELETE fails (parent returns false), roll the row back into the list in createdAt
  // order so the cashier doesn't lose sight of a bill that is still parked (L1).
  async function handleDiscard(id: string) {
    const removed = bills.find((b) => b.id === id);
    setBills((prev) => prev.filter((b) => b.id !== id));
    const ok = await onDiscard(id);
    if (ok === false && removed) {
      setBills((prev) =>
        [...prev, removed].sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt)
        )
      );
    }
  }

  return (
    <Modal open={open} onClose={onClose} label="บิลที่พักไว้">
      <div
        className="flex max-h-[78vh] w-[500px] max-w-[95vw] flex-col overflow-hidden rounded-[16px] bg-white"
        style={{ boxShadow: "0 24px 60px rgba(0,0,0,.3)" }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between gap-3 border-b px-[18px] py-4"
          style={{ borderColor: "#f1f5f9" }}
        >
          <div className="text-[15px] font-bold">บิลที่พักไว้ · Held Bills</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="ปิด"
            className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-[10px] border transition hover:bg-[#f1f5f9]"
            style={{ borderColor: "var(--line)", color: "var(--muted)" }}
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        {/* List */}
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {state === "loading" && (
            <div
              className="py-8 text-center text-[13px]"
              style={{ color: "var(--soft)" }}
            >
              กำลังโหลดบิลที่พักไว้…
            </div>
          )}
          {state === "error" && (
            <div
              className="py-8 text-center text-[13px]"
              style={{ color: "#dc2626" }}
            >
              โหลดบิลที่พักไว้ไม่สำเร็จ
            </div>
          )}
          {state === "ready" && bills.length === 0 && (
            <div
              className="py-8 text-center text-[13px]"
              style={{ color: "var(--soft)" }}
            >
              ยังไม่มีบิลที่พักไว้
            </div>
          )}

          {state === "ready" &&
            bills.map((b) => (
              <div
                key={b.id}
                className="flex items-center gap-2 rounded-[11px] p-3 transition hover:bg-[#f1f5f9]"
              >
                <span
                  className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-[12px]"
                  style={{ background: "#ecfdf5", color: "var(--brand)" }}
                >
                  <Receipt size={18} strokeWidth={2} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[14px] font-semibold">
                      {b.label}
                    </span>
                  </div>
                  <span
                    className="block truncate text-[11.5px]"
                    style={{ color: "var(--soft)" }}
                  >
                    {b.itemCount} รายการ ·{" "}
                    {b.customerName ? b.customerName : "ลูกค้าทั่วไป"}
                  </span>
                </div>
                <span
                  className="mono flex-shrink-0 text-[13.5px] font-bold"
                  style={{ color: "var(--brand)" }}
                >
                  {formatSatang(b.totalSatang)}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    onResume(b.id, b);
                    onClose();
                  }}
                  className="ml-1 h-9 flex-shrink-0 rounded-[10px] px-3 text-[12.5px] font-bold text-white transition"
                  style={{ background: "var(--brand)" }}
                >
                  เรียกคืน
                </button>
                <button
                  type="button"
                  onClick={() => handleDiscard(b.id)}
                  aria-label={`ลบบิล ${b.label}`}
                  title="ลบบิลที่พักไว้ · Discard"
                  className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-[10px] border transition hover:bg-white"
                  style={{ borderColor: "#fecaca", color: "#dc2626" }}
                >
                  <Trash2 size={15} strokeWidth={2} />
                </button>
              </div>
            ))}
        </div>
      </div>
    </Modal>
  );
}
