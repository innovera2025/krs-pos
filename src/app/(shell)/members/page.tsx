"use client";

import { useEffect, useRef, useState } from "react";
import { Search, AlertTriangle, ChevronRight } from "lucide-react";
import { useToast } from "@/components/ToastProvider";
import { useRole } from "@/components/RoleProvider";
import {
  GOLD,
  fmtDate,
  fmtPoints,
  type MemberRow,
} from "@/components/members/memberMeta";
import { MemberLedgerDrawer } from "@/components/members/MemberLedgerDrawer";
import {
  AdjustPointsModal,
  type AdjustPayload,
} from "@/components/members/AdjustPointsModal";
import { LoyaltyReportTab } from "@/components/members/LoyaltyReportTab";
import { RewardsTab } from "@/components/members/RewardsTab";

type LoadState = "loading" | "ready" | "error";

/**
 * /members — loyalty members management (loyalty program, Phase 1B). Open to EVERY
 * signed-in role (view + ledger); the manual points ADJUST is ADMIN-only (gated below
 * by `isAdmin` AND enforced by the `requireAdmin` adjust API).
 *
 * Structure mirrors /promotions: header + จัดการ/รายงาน tab switch, a searchable member
 * table (server `?q=` search on name/phone), a row-click ledger drawer, and a
 * points-report tab. Loyalty accent = gold/amber (distinct from promo mint / tax blue).
 */
export default function MembersPage() {
  return <MembersScreen />;
}

function MembersScreen() {
  const { showToast } = useToast();
  // The adjust affordance renders for admin only (UX). The adjust API is still
  // `requireAdmin`, so a tampered client role cannot write.
  const { role } = useRole();
  const isAdmin = role === "admin";

  const [members, setMembers] = useState<MemberRow[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [search, setSearch] = useState("");
  // Three tabs: member list · ของรางวัล (rewards, ADMIN-only) · points report. The
  // rewards tab pill renders only for an admin (the reward CONFIG surface is ADMIN-gated,
  // matching the requireAdmin write routes).
  const [tab, setTab] = useState<"manage" | "rewards" | "report">("manage");

  // Ledger drawer.
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [drawerRefreshToken, setDrawerRefreshToken] = useState(0);

  // Adjust modal.
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustMember, setAdjustMember] = useState<MemberRow | null>(null);
  const [adjustSubmitting, setAdjustSubmitting] = useState(false);
  const [adjustError, setAdjustError] = useState("");

  // Monotonic token so a slow earlier list fetch never overwrites a newer one.
  const reqIdRef = useRef(0);

  async function loadMembers(q: string) {
    const reqId = ++reqIdRef.current;
    setLoadState("loading");
    try {
      const term = q.trim();
      const url = term ? `/api/members?q=${encodeURIComponent(term)}` : "/api/members";
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as MemberRow[];
      if (reqId !== reqIdRef.current) return;
      setMembers(Array.isArray(data) ? data : []);
      setLoadState("ready");
    } catch {
      if (reqId !== reqIdRef.current) return;
      setLoadState("error");
    }
  }

  // Debounced (server-side) search — re-fetch 250ms after the last keystroke.
  useEffect(() => {
    const t = setTimeout(() => loadMembers(search), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  function openAdjust(member: MemberRow) {
    setAdjustMember(member);
    setAdjustError("");
    setAdjustOpen(true);
  }

  async function submitAdjust(payload: AdjustPayload) {
    if (!adjustMember) return;
    setAdjustSubmitting(true);
    setAdjustError("");
    try {
      const res = await fetch(`/api/members/${adjustMember.id}/adjust`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        let msg = "ปรับแต้มไม่สำเร็จ";
        try {
          const data = await res.json();
          if (data?.code === "POINTS_INSUFFICIENT") msg = "แต้มคงเหลือไม่พอสำหรับการปรับลด";
          else if (data?.code === "NOT_FOUND") msg = "ไม่พบสมาชิก";
          else if (data?.code === "FORBIDDEN") msg = "ต้องเป็นผู้ดูแลระบบ";
          else if (data?.error) msg = data.error;
        } catch {
          /* keep default */
        }
        setAdjustError(msg);
        return;
      }
      setAdjustOpen(false);
      showToast("ปรับแต้มเรียบร้อยแล้ว");
      // Refresh the drawer (new balance + ledger row) and the list (balance/order).
      setDrawerRefreshToken((n) => n + 1);
      await loadMembers(search);
    } catch {
      setAdjustError("ปรับแต้มไม่สำเร็จ");
    } finally {
      setAdjustSubmitting(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-[22px]">
      {/* Header */}
      <header className="flex flex-wrap items-center gap-3.5">
        <div className="flex-1 min-w-[220px]">
          <h1 className="m-0 text-[24px] font-bold leading-[1.08] tracking-tight">
            สมาชิก
          </h1>
          <p className="mt-1 text-[12.5px]" style={{ color: "var(--muted)" }}>
            Members · สมาชิกสะสมแต้มและประวัติแต้ม
          </p>
        </div>
      </header>

      {/* รายชื่อ / ของรางวัล (admin) / รายงาน tab switcher */}
      <div className="flex items-center gap-1.5">
        <FilterPill active={tab === "manage"} onClick={() => setTab("manage")}>
          รายชื่อสมาชิก · Members
        </FilterPill>
        {isAdmin && (
          <FilterPill active={tab === "rewards"} onClick={() => setTab("rewards")}>
            ของรางวัล · Rewards
          </FilterPill>
        )}
        <FilterPill active={tab === "report"} onClick={() => setTab("report")}>
          รายงานแต้ม · Points
        </FilterPill>
      </div>

      {tab === "report" ? (
        <LoyaltyReportTab />
      ) : tab === "rewards" && isAdmin ? (
        <RewardsTab />
      ) : (
        <>
          {/* Search */}
          <div className="flex flex-wrap items-center gap-3">
            <label
              className="flex h-12 flex-1 min-w-[240px] items-center gap-2.5 rounded-[14px] border bg-white px-3.5"
              style={{ borderColor: "var(--line)", boxShadow: "var(--shadow-sm)" }}
            >
              <Search size={18} strokeWidth={2} color="#667085" />
              <span className="sr-only">ค้นหาสมาชิก</span>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="ค้นหาสมาชิก ชื่อ / เบอร์โทร"
                autoComplete="off"
                aria-label="ค้นหาสมาชิก"
                className="min-w-0 flex-1 border-0 text-[14px] font-medium outline-none"
                style={{ color: "var(--ink)" }}
              />
            </label>
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
                กำลังโหลดสมาชิก…
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
                  โหลดสมาชิกไม่สำเร็จ
                </strong>
                <button
                  type="button"
                  onClick={() => loadMembers(search)}
                  className="h-10 rounded-[12px] border px-4 text-[13px] font-semibold"
                  style={{ borderColor: "var(--line)" }}
                >
                  ลองใหม่
                </button>
              </div>
            ) : members.length === 0 ? (
              <div
                className="grid flex-1 place-items-center py-16 text-center text-[13px]"
                style={{ color: "var(--soft)" }}
              >
                {search.trim()
                  ? "ไม่พบสมาชิก · No matching members"
                  : "ยังไม่มีสมาชิก · สมัครสมาชิกได้ที่หน้าขาย"}
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr
                      className="sticky top-0 z-10 text-left"
                      style={{ background: "var(--surface-2)", color: "var(--muted)" }}
                    >
                      <Th>ชื่อสมาชิก</Th>
                      <Th>เบอร์โทร</Th>
                      <Th className="text-right">แต้มคงเหลือ</Th>
                      <Th>สมาชิกตั้งแต่</Th>
                      <Th className="text-right"> </Th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m) => (
                      <MemberTableRow
                        key={m.id}
                        member={m}
                        onOpen={() => setSelectedMemberId(m.id)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {/* Ledger drawer */}
      <MemberLedgerDrawer
        open={selectedMemberId !== null}
        memberId={selectedMemberId}
        isAdmin={isAdmin}
        refreshToken={drawerRefreshToken}
        onClose={() => setSelectedMemberId(null)}
        onRequestAdjust={openAdjust}
      />

      {/* Adjust modal */}
      <AdjustPointsModal
        open={adjustOpen}
        member={adjustMember}
        submitting={adjustSubmitting}
        error={adjustError}
        onClose={() => setAdjustOpen(false)}
        onSubmit={submitAdjust}
      />
    </div>
  );
}

function MemberTableRow({
  member,
  onOpen,
}: {
  member: MemberRow;
  onOpen: () => void;
}) {
  return (
    <tr
      className="cursor-pointer border-t transition hover:bg-[var(--surface-2)]"
      style={{ borderColor: "var(--line)" }}
      onClick={onOpen}
    >
      <Td>
        <span className="font-semibold">{member.name}</span>
      </Td>
      <Td>
        <span className="mono" style={{ color: "var(--muted)" }}>
          {member.phone ?? "—"}
        </span>
      </Td>
      <Td className="text-right">
        <span
          className="mono inline-flex items-center rounded-full px-2.5 py-1 text-[12.5px] font-bold"
          style={{ background: GOLD.bg, color: GOLD.fg }}
        >
          {fmtPoints(member.pointsBalance)} แต้ม
        </span>
      </Td>
      <Td>
        <span style={{ color: "var(--muted)" }}>{fmtDate(member.memberSince)}</span>
      </Td>
      <Td className="text-right">
        <span className="inline-flex justify-end" style={{ color: "var(--soft)" }}>
          <ChevronRight size={16} strokeWidth={2} />
        </span>
      </Td>
    </tr>
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
          ? { background: GOLD.fg, color: "#fff" }
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
