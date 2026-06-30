"use client";

import { useEffect, useState } from "react";
import { Store } from "lucide-react";
import type { Warehouse } from "@/types";
import { useRole } from "@/components/RoleProvider";

/**
 * BranchBadge — a small Taste chip in the POS header that shows the LOGGED-IN
 * user's warehouse (+ derived branch) by NAME.
 *
 * The session only carries CODES (`warehouseCode`/`branchCode` via `useRole()`);
 * the human NAMES live in the Warehouse master (GET /api/warehouses, which needs
 * only `requireUser` — any cashier can call it). So we fetch that master once on
 * mount and resolve the user's `warehouseCode` → `{ warehouseName, branchName }`
 * client-side. No auth/session change.
 *
 * Degrade gracefully — the badge is purely informational and must NEVER break the
 * page:
 *  - session still loading (`!hydrated`)            → render nothing (no flash)
 *  - user unassigned (`warehouseCode == null`)      → muted "ยังไม่ได้ผูกคลัง" chip
 *  - name not resolved yet (fetch pending/failed)   → render nothing
 *  - name resolved                                  → mint/forest-green chip
 */
export function BranchBadge() {
  const { warehouseCode, hydrated } = useRole();
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);

  // Fetch the warehouse master once on mount (best-effort). On any failure we
  // leave the list empty so the chip simply renders nothing — a warehouse-name
  // lookup must never throw or block the cashier's checkout screen.
  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/warehouses", { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Warehouse[] | null) => {
        if (ctrl.signal.aborted || !Array.isArray(data)) return;
        setWarehouses(data);
      })
      .catch(() => {
        /* ignore — leave warehouses empty → chip renders nothing */
      });
    return () => ctrl.abort();
  }, []);

  // Session still resolving — render nothing so the chip doesn't flash before the
  // user's warehouseCode is known.
  if (!hydrated) return null;

  // Unassigned (e.g. an admin not bound to a warehouse) → a muted chip so they can
  // see the account has no warehouse rather than a silent gap.
  if (!warehouseCode) {
    return (
      <span
        title="บัญชีนี้ยังไม่ได้ผูกกับคลังสินค้า"
        className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium"
        style={{
          background: "#f2f4f7",
          color: "var(--muted)",
          border: "1px solid var(--line)",
        }}
      >
        <Store size={14} strokeWidth={2} aria-hidden />
        ยังไม่ได้ผูกคลัง
      </span>
    );
  }

  const wh =
    warehouses.find((w) => w.warehouseCode === warehouseCode) ?? null;

  // We have the code but not (yet) the name → render nothing rather than a
  // half-empty chip (fetch pending or failed).
  if (!wh) return null;

  const title = wh.branchName
    ? `${wh.warehouseName} · ${wh.branchName}`
    : wh.warehouseName;

  return (
    <span
      title={title}
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold"
      style={{
        background: "var(--mint)",
        color: "var(--brand-2)",
        border: "1px solid rgba(31,169,113,.22)",
      }}
    >
      <Store size={14} strokeWidth={2} aria-hidden />
      <span>{wh.warehouseName}</span>
      {wh.branchName ? (
        <span style={{ color: "var(--muted)", fontWeight: 500 }}>
          {`· ${wh.branchName}`}
        </span>
      ) : null}
    </span>
  );
}
