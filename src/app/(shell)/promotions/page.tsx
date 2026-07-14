"use client";

import { useEffect, useMemo, useState } from "react";
import { Search, Plus, AlertTriangle, Pencil } from "lucide-react";
import type { PromotionDTO } from "@/types";
import { useToast } from "@/components/ToastProvider";
import { AdminOnly } from "@/components/AdminOnly";
import { PROMO_META, promoSummary } from "@/components/promotions/promotionMeta";
import {
  PromotionFormModal,
  type PromotionFormPayload,
} from "@/components/promotions/PromotionFormModal";
import { Modal } from "@/components/Modal";
import { PromotionReportTab } from "@/components/promotions/PromotionReportTab";

type LoadState = "loading" | "ready" | "error";
type StatusFilter = "all" | "active" | "inactive";

/** Thai (Asia/Bangkok) short date for the ช่วงเวลา column. */
const THAI_DATE = new Intl.DateTimeFormat("th-TH", {
  timeZone: "Asia/Bangkok",
  day: "numeric",
  month: "short",
  year: "numeric",
});
function fmtBkk(d: Date): string {
  return THAI_DATE.format(d);
}

export default function PromotionsPage() {
  return (
    <AdminOnly strict>
      <PromotionsScreen />
    </AdminOnly>
  );
}

function PromotionsScreen() {
  const { showToast } = useToast();

  const [promotions, setPromotions] = useState<PromotionDTO[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");

  // Manage (existing CRUD) vs. Report (Phase 9 date-range sales report) tab.
  const [tab, setTab] = useState<"manage" | "report">("manage");

  // Add/edit modal.
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PromotionDTO | null>(null);
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [formError, setFormError] = useState("");

  // Deactivate confirm dialog.
  const [confirmTarget, setConfirmTarget] = useState<PromotionDTO | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function loadPromotions() {
    setLoadState("loading");
    try {
      const res = await fetch("/api/promotions");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as PromotionDTO[];
      setPromotions(Array.isArray(data) ? data : []);
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }

  useEffect(() => {
    loadPromotions();
  }, []);

  // Client-side search (name / code) + status filter.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return promotions.filter((p) => {
      if (filter === "active" && !p.isActive) return false;
      if (filter === "inactive" && p.isActive) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        (p.code ?? "").toLowerCase().includes(q)
      );
    });
  }, [promotions, search, filter]);

  // ---- add / edit ----
  function openAdd() {
    setEditing(null);
    setFormError("");
    setFormOpen(true);
  }

  function openEdit(promo: PromotionDTO) {
    setEditing(promo);
    setFormError("");
    setFormOpen(true);
  }

  async function submitForm(values: PromotionFormPayload) {
    setFormSubmitting(true);
    setFormError("");
    try {
      const isEdit = editing !== null;
      const url = isEdit ? `/api/promotions/${editing.id}` : "/api/promotions";
      const method = isEdit ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!res.ok) {
        let msg = "บันทึกโปรโมชันไม่สำเร็จ";
        try {
          const data = await res.json();
          if (data?.code === "CODE_TAKEN") msg = "รหัสโปรโมชันนี้ถูกใช้งานแล้ว";
          else if (data?.error) msg = data.error;
        } catch {
          /* keep default */
        }
        setFormError(msg);
        return;
      }
      setFormOpen(false);
      showToast(isEdit ? "บันทึกการแก้ไขแล้ว" : "เพิ่มโปรโมชันแล้ว");
      await loadPromotions();
    } catch {
      setFormError("บันทึกโปรโมชันไม่สำเร็จ");
    } finally {
      setFormSubmitting(false);
    }
  }

  // ---- activate / deactivate ----
  async function setActive(promo: PromotionDTO, next: boolean) {
    setBusyId(promo.id);
    try {
      const res = await fetch(`/api/promotions/${promo.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPromotions((prev) =>
        prev.map((p) => (p.id === promo.id ? { ...p, isActive: next } : p))
      );
      showToast(next ? "เปิดใช้งานโปรโมชันแล้ว" : "ปิดใช้งานโปรโมชันแล้ว");
    } catch {
      showToast("อัปเดตสถานะไม่สำเร็จ");
    } finally {
      setBusyId(null);
    }
  }

  function onToggle(promo: PromotionDTO) {
    // Deactivation is destructive to live billing → confirm first. Activation is
    // instant.
    if (promo.isActive) setConfirmTarget(promo);
    else setActive(promo, true);
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-[22px]">
      {/* Header */}
      <header className="flex flex-wrap items-center gap-3.5">
        <div className="flex-1 min-w-[220px]">
          <h1 className="m-0 text-[24px] font-bold leading-[1.08] tracking-tight">
            โปรโมชัน
          </h1>
          <p className="mt-1 text-[12.5px]" style={{ color: "var(--muted)" }}>
            Promotions · จัดการส่วนลดอัตโนมัติหน้าขาย
          </p>
        </div>

        {tab === "manage" && (
          <button
            type="button"
            onClick={openAdd}
            className="flex h-11 items-center gap-2 rounded-[14px] px-4 text-[13.5px] font-bold text-white"
            style={{ background: "var(--brand)", boxShadow: "var(--shadow-sm)" }}
          >
            <Plus size={17} strokeWidth={2.5} /> เพิ่มโปรโมชัน
          </button>
        )}
      </header>

      {/* จัดการ / รายงาน tab switcher (filter-pill style) */}
      <div className="flex items-center gap-1.5">
        <FilterPill active={tab === "manage"} onClick={() => setTab("manage")}>
          จัดการ · Manage
        </FilterPill>
        <FilterPill active={tab === "report"} onClick={() => setTab("report")}>
          รายงาน · Report
        </FilterPill>
      </div>

      {tab === "report" ? (
        <PromotionReportTab />
      ) : (
        <>
      {/* Search + status filter pills */}
      <div className="flex flex-wrap items-center gap-3">
        <label
          className="flex h-12 flex-1 min-w-[240px] items-center gap-2.5 rounded-[14px] border bg-white px-3.5"
          style={{ borderColor: "var(--line)", boxShadow: "var(--shadow-sm)" }}
        >
          <Search size={18} strokeWidth={2} color="#667085" />
          <span className="sr-only">ค้นหาโปรโมชัน</span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="ค้นหาโปรโมชัน ชื่อ / สินค้า"
            autoComplete="off"
            aria-label="ค้นหาโปรโมชัน"
            className="min-w-0 flex-1 border-0 text-[14px] font-medium outline-none"
            style={{ color: "var(--ink)" }}
          />
        </label>

        <div className="flex items-center gap-1.5">
          <FilterPill active={filter === "all"} onClick={() => setFilter("all")}>
            ทั้งหมด
          </FilterPill>
          <FilterPill active={filter === "active"} onClick={() => setFilter("active")}>
            กำลังใช้งาน
          </FilterPill>
          <FilterPill active={filter === "inactive"} onClick={() => setFilter("inactive")}>
            ปิดใช้งาน
          </FilterPill>
        </div>
      </div>

      {/* Table card */}
      <section
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[18px] border bg-white"
        style={{ borderColor: "var(--line)", boxShadow: "var(--shadow-sm)" }}
      >
        {loadState === "loading" ? (
          <div
            className="grid flex-1 place-items-center py-16 text-center text-[13px]"
            style={{ color: "var(--soft)" }}
          >
            กำลังโหลดโปรโมชัน…
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
              โหลดโปรโมชันไม่สำเร็จ
            </strong>
            <button
              type="button"
              onClick={loadPromotions}
              className="h-10 rounded-[12px] border px-4 text-[13px] font-semibold"
              style={{ borderColor: "var(--line)" }}
            >
              ลองใหม่
            </button>
          </div>
        ) : promotions.length === 0 ? (
          <div
            className="grid flex-1 place-items-center py-16 text-center text-[13px]"
            style={{ color: "var(--soft)" }}
          >
            ยังไม่มีโปรโมชัน · กด “เพิ่มโปรโมชัน” เพื่อเริ่มต้น
          </div>
        ) : filtered.length === 0 ? (
          <div
            className="grid flex-1 place-items-center py-16 text-center text-[13px]"
            style={{ color: "var(--soft)" }}
          >
            ไม่พบโปรโมชัน · No matching promotions
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr
                  className="sticky top-0 z-10 text-left"
                  style={{ background: "var(--surface-2)", color: "var(--muted)" }}
                >
                  <Th>ชื่อโปรโมชัน</Th>
                  <Th>ประเภท</Th>
                  <Th>ส่วนลด/เงื่อนไข</Th>
                  <Th>สินค้า</Th>
                  <Th>ช่วงเวลา</Th>
                  <Th>สถานะ</Th>
                  <Th className="text-right">จัดการ</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => (
                  <PromotionRow
                    key={p.id}
                    promo={p}
                    busy={busyId === p.id}
                    onToggle={() => onToggle(p)}
                    onEdit={() => openEdit(p)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <PromotionFormModal
        open={formOpen}
        editing={editing}
        submitting={formSubmitting}
        error={formError}
        onClose={() => setFormOpen(false)}
        onSubmit={submitForm}
      />

      <DeactivateConfirm
        target={confirmTarget}
        onCancel={() => setConfirmTarget(null)}
        onConfirm={() => {
          const t = confirmTarget;
          setConfirmTarget(null);
          if (t) setActive(t, false);
        }}
      />
        </>
      )}
    </div>
  );
}

function PromotionRow({
  promo,
  busy,
  onToggle,
  onEdit,
}: {
  promo: PromotionDTO;
  busy: boolean;
  onToggle: () => void;
  onEdit: () => void;
}) {
  const meta = PROMO_META[promo.type];
  const Icon = meta.icon;

  // ช่วงเวลา — inclusive end date is one ms before the exclusive endsAt bound.
  const startStr = promo.startsAt ? fmtBkk(new Date(promo.startsAt)) : "—";
  const endStr = promo.endsAt
    ? fmtBkk(new Date(new Date(promo.endsAt).getTime() - 1))
    : "ไม่มีกำหนด";
  const expired = promo.endsAt != null && new Date(promo.endsAt).getTime() <= Date.now();

  const scopeLabel =
    promo.type === "BILL_THRESHOLD" ? "ทั้งบิล" : `${promo.productIds.length} รายการ`;

  return (
    <tr className="border-t" style={{ borderColor: "var(--line)" }}>
      <Td>
        <span className="font-semibold">{promo.name}</span>
      </Td>
      <Td>
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-semibold"
          style={{ background: "var(--mint)", color: "var(--brand-2)" }}
        >
          <Icon size={13} strokeWidth={2} />
          {meta.labelTh}
        </span>
      </Td>
      <Td>
        <span className="mono text-[12.5px]" style={{ color: "var(--ink)" }}>
          {promoSummary(promo)}
        </span>
      </Td>
      <Td>
        <span style={{ color: "var(--muted)" }}>{scopeLabel}</span>
      </Td>
      <Td>
        <div className="flex items-center gap-2">
          <span className="text-[12px]" style={{ color: "var(--muted)" }}>
            {startStr} – {endStr}
          </span>
          {expired && (
            <span
              className="inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
              style={{ background: "#f1f5f9", color: "#64748b" }}
            >
              หมดอายุ
            </span>
          )}
        </div>
      </Td>
      <Td>
        <button
          type="button"
          role="switch"
          aria-checked={promo.isActive}
          aria-label={promo.isActive ? "ปิดใช้งานโปรโมชัน" : "เปิดใช้งานโปรโมชัน"}
          disabled={busy}
          onClick={onToggle}
          className="relative h-6 w-11 flex-shrink-0 rounded-full transition disabled:opacity-60"
          style={{ background: promo.isActive ? "var(--brand)" : "#cbd5e1" }}
        >
          <span
            aria-hidden="true"
            className="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all"
            style={{ left: promo.isActive ? 22 : 2 }}
          />
        </button>
      </Td>
      <Td className="text-right">
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onEdit}
            aria-label={`แก้ไข ${promo.name}`}
            title="แก้ไข"
            className="grid h-9 w-9 place-items-center rounded-[11px] border"
            style={{ borderColor: "var(--line)", color: "var(--ink)" }}
          >
            <Pencil size={15} strokeWidth={2} />
          </button>
        </div>
      </Td>
    </tr>
  );
}

function DeactivateConfirm({
  target,
  onCancel,
  onConfirm,
}: {
  target: PromotionDTO | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open={target !== null} onClose={onCancel} label="ปิดใช้งานโปรโมชัน">
      <div
        className="w-[min(400px,calc(100vw-32px))] rounded-[22px] bg-white p-5"
        style={{ boxShadow: "var(--shadow)" }}
      >
        <strong className="block text-[15px]">ปิดใช้งานโปรโมชัน?</strong>
        <p className="mt-2 text-[13px] leading-relaxed" style={{ color: "var(--muted)" }}>
          โปรโมชันจะหยุดใช้กับบิลใหม่ทันที ประวัติการขายเดิมไม่เปลี่ยนแปลง
        </p>
        <div className="mt-4 flex justify-end gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            className="h-11 rounded-[12px] border px-4 text-[13.5px] font-semibold"
            style={{ borderColor: "var(--line)", color: "var(--ink)" }}
          >
            ยกเลิก
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="h-11 rounded-[12px] px-5 text-[13.5px] font-bold text-white"
            style={{ background: "#dc2626" }}
          >
            ปิดใช้งาน
          </button>
        </div>
      </div>
    </Modal>
  );
}

function FilterPill({
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
      className="h-9 rounded-full px-3.5 text-[12.5px] font-semibold transition"
      style={
        active
          ? { background: "var(--brand)", color: "#fff" }
          : { background: "#fff", color: "var(--muted)", border: "1px solid var(--line)" }
      }
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
