"use client";

import { useEffect, useMemo, useState } from "react";
import { Search, Plus, AlertTriangle, Pencil, Gift } from "lucide-react";
import { useToast } from "@/components/ToastProvider";
import { Modal } from "@/components/Modal";
import {
  GOLD,
  fmtPoints,
  rewardGiftLabel,
  type RewardDTO,
} from "@/components/members/rewardMeta";
import {
  RewardFormModal,
  type RewardFormPayload,
} from "@/components/members/RewardFormModal";

type LoadState = "loading" | "ready" | "error";

/**
 * "ของรางวัล" (rewards catalog) tab on the /members screen (loyalty program, Phase 3A —
 * CONFIG side only). ADMIN-only: the parent (/members) renders this tab only for an admin,
 * and every mutation route is `requireAdmin`. Structure mirrors the /promotions manage tab
 * (header create button + searchable table + form modal + activate/deactivate toggle with
 * a deactivate confirm). Loyalty accent = GOLD (points figures), distinct from promo mint.
 *
 * This is the config surface ONLY — the POS redeem flow + receipt line that CONSUME these
 * rewards are Phase 3B and are intentionally not wired here.
 */
export function RewardsTab() {
  const { showToast } = useToast();

  const [rewards, setRewards] = useState<RewardDTO[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [search, setSearch] = useState("");

  // Add/edit modal.
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<RewardDTO | null>(null);
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [formError, setFormError] = useState("");

  // Deactivate confirm dialog.
  const [confirmTarget, setConfirmTarget] = useState<RewardDTO | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function loadRewards() {
    setLoadState("loading");
    try {
      const res = await fetch("/api/rewards");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as RewardDTO[];
      setRewards(Array.isArray(data) ? data : []);
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }

  useEffect(() => {
    loadRewards();
  }, []);

  // Client-side search (reward name / gift product name).
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rewards;
    return rewards.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.product?.name ?? "").toLowerCase().includes(q)
    );
  }, [rewards, search]);

  // ---- add / edit ----
  function openAdd() {
    setEditing(null);
    setFormError("");
    setFormOpen(true);
  }

  function openEdit(reward: RewardDTO) {
    setEditing(reward);
    setFormError("");
    setFormOpen(true);
  }

  async function submitForm(values: RewardFormPayload) {
    setFormSubmitting(true);
    setFormError("");
    try {
      const isEdit = editing !== null;
      const url = isEdit ? `/api/rewards/${editing.id}` : "/api/rewards";
      const method = isEdit ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!res.ok) {
        let msg = "บันทึกของรางวัลไม่สำเร็จ";
        try {
          const data = await res.json();
          if (data?.code === "UNKNOWN_PRODUCT") msg = "ไม่พบสินค้า หรือสินค้าถูกปิดการขาย";
          else if (data?.code === "FORBIDDEN") msg = "ต้องเป็นผู้ดูแลระบบ";
          else if (data?.error) msg = data.error;
        } catch {
          /* keep default */
        }
        setFormError(msg);
        return;
      }
      setFormOpen(false);
      showToast(isEdit ? "บันทึกการแก้ไขแล้ว" : "เพิ่มของรางวัลแล้ว");
      await loadRewards();
    } catch {
      setFormError("บันทึกของรางวัลไม่สำเร็จ");
    } finally {
      setFormSubmitting(false);
    }
  }

  // ---- activate / deactivate ----
  async function setActive(reward: RewardDTO, next: boolean) {
    setBusyId(reward.id);
    try {
      const res = await fetch(`/api/rewards/${reward.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRewards((prev) =>
        prev.map((r) => (r.id === reward.id ? { ...r, isActive: next } : r))
      );
      showToast(next ? "เปิดใช้งานของรางวัลแล้ว" : "ปิดใช้งานของรางวัลแล้ว");
    } catch {
      showToast("อัปเดตสถานะไม่สำเร็จ");
    } finally {
      setBusyId(null);
    }
  }

  function onToggle(reward: RewardDTO) {
    // Deactivation removes it from the POS redeem list → confirm first. Activation is
    // instant.
    if (reward.isActive) setConfirmTarget(reward);
    else setActive(reward, true);
  }

  return (
    <>
      {/* Search + create */}
      <div className="flex flex-wrap items-center gap-3">
        <label
          className="flex h-12 flex-1 min-w-[240px] items-center gap-2.5 rounded-[14px] border bg-white px-3.5"
          style={{ borderColor: "var(--line)", boxShadow: "var(--shadow-sm)" }}
        >
          <Search size={18} strokeWidth={2} color="#667085" />
          <span className="sr-only">ค้นหาของรางวัล</span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="ค้นหาของรางวัล ชื่อ / สินค้า"
            autoComplete="off"
            aria-label="ค้นหาของรางวัล"
            className="min-w-0 flex-1 border-0 text-[14px] font-medium outline-none"
            style={{ color: "var(--ink)" }}
          />
        </label>

        <button
          type="button"
          onClick={openAdd}
          className="flex h-11 items-center gap-2 rounded-[14px] px-4 text-[13.5px] font-bold text-white"
          style={{ background: GOLD.fg, boxShadow: "var(--shadow-sm)" }}
        >
          <Plus size={17} strokeWidth={2.5} /> เพิ่มของรางวัล
        </button>
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
            กำลังโหลดของรางวัล…
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
              โหลดของรางวัลไม่สำเร็จ
            </strong>
            <button
              type="button"
              onClick={loadRewards}
              className="h-10 rounded-[12px] border px-4 text-[13px] font-semibold"
              style={{ borderColor: "var(--line)" }}
            >
              ลองใหม่
            </button>
          </div>
        ) : rewards.length === 0 ? (
          <div
            className="grid flex-1 place-items-center py-16 text-center text-[13px]"
            style={{ color: "var(--soft)" }}
          >
            ยังไม่มีของรางวัล · กด “เพิ่มของรางวัล” เพื่อเริ่มต้น
          </div>
        ) : filtered.length === 0 ? (
          <div
            className="grid flex-1 place-items-center py-16 text-center text-[13px]"
            style={{ color: "var(--soft)" }}
          >
            ไม่พบของรางวัล · No matching rewards
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr
                  className="sticky top-0 z-10 text-left"
                  style={{ background: "var(--surface-2)", color: "var(--muted)" }}
                >
                  <Th>ของรางวัล</Th>
                  <Th>สินค้าที่แจก</Th>
                  <Th className="text-right">แต้มที่ใช้</Th>
                  <Th>สถานะ</Th>
                  <Th className="text-right">จัดการ</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <RewardRow
                    key={r.id}
                    reward={r}
                    busy={busyId === r.id}
                    onToggle={() => onToggle(r)}
                    onEdit={() => openEdit(r)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <RewardFormModal
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
  );
}

function RewardRow({
  reward,
  busy,
  onToggle,
  onEdit,
}: {
  reward: RewardDTO;
  busy: boolean;
  onToggle: () => void;
  onEdit: () => void;
}) {
  const missingProduct = reward.product === null;
  return (
    <tr className="border-t" style={{ borderColor: "var(--line)" }}>
      <Td>
        <span className="inline-flex items-center gap-2 font-semibold">
          <span
            className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-[9px]"
            style={{ background: GOLD.bg, color: GOLD.fg }}
          >
            <Gift size={15} strokeWidth={2} />
          </span>
          {reward.name}
        </span>
      </Td>
      <Td>
        <span
          style={{ color: missingProduct ? "#b42318" : "var(--muted)" }}
        >
          {rewardGiftLabel(reward)}
        </span>
      </Td>
      <Td className="text-right">
        <span
          className="mono inline-flex items-center rounded-full px-2.5 py-1 text-[12.5px] font-bold"
          style={{ background: GOLD.bg, color: GOLD.fg }}
        >
          {fmtPoints(reward.pointsCost)} แต้ม
        </span>
      </Td>
      <Td>
        <button
          type="button"
          role="switch"
          aria-checked={reward.isActive}
          aria-label={reward.isActive ? "ปิดใช้งานของรางวัล" : "เปิดใช้งานของรางวัล"}
          disabled={busy}
          onClick={onToggle}
          className="relative h-6 w-11 flex-shrink-0 rounded-full transition disabled:opacity-60"
          style={{ background: reward.isActive ? GOLD.fg : "#cbd5e1" }}
        >
          <span
            aria-hidden="true"
            className="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all"
            style={{ left: reward.isActive ? 22 : 2 }}
          />
        </button>
      </Td>
      <Td className="text-right">
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onEdit}
            aria-label={`แก้ไข ${reward.name}`}
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
  target: RewardDTO | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open={target !== null} onClose={onCancel} label="ปิดใช้งานของรางวัล">
      <div
        className="w-[min(400px,calc(100vw-32px))] rounded-[22px] bg-white p-5"
        style={{ boxShadow: "var(--shadow)" }}
      >
        <strong className="block text-[15px]">ปิดใช้งานของรางวัล?</strong>
        <p className="mt-2 text-[13px] leading-relaxed" style={{ color: "var(--muted)" }}>
          ของรางวัลจะหายจากรายการแลกที่หน้าขายทันที การแลกเดิมไม่เปลี่ยนแปลง
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
