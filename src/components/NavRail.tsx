"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  Store,
  PanelLeft,
  ReceiptText,
  Clock3,
  DatabaseZap,
  Package,
  UsersRound,
  FileText,
  UserCog,
  type LucideIcon,
} from "lucide-react";
import { useRole } from "@/components/RoleProvider";
import { canAccess } from "@/lib/roleAccess";

type NavItem = {
  key: string;
  /** Visible/tooltip label (Thai-first per Taste microcopy). */
  label: string;
  /** Short English label — satisfies domain-nav-en-and-titles-mismatch. */
  labelEn: string;
  route: string;
  icon: LucideIcon;
  /** When true, this item can show the red failed-job badge dot. */
  badge?: boolean;
};

const NAV_ITEMS: NavItem[] = [
  { key: "pos", label: "ขายหน้าร้าน", labelEn: "POS Checkout", route: "/pos", icon: PanelLeft },
  { key: "sales", label: "ประวัติการขาย", labelEn: "Sales History", route: "/sales", icon: ReceiptText },
  { key: "shift", label: "ปิดรอบขาย", labelEn: "Shift Close", route: "/shift", icon: Clock3 },
  { key: "data", label: "การเชื่อมข้อมูล", labelEn: "KRS Data Link", route: "/data", icon: DatabaseZap, badge: true },
  { key: "products", label: "สินค้า/สต็อก", labelEn: "Products", route: "/products", icon: Package },
  { key: "users", label: "จัดการผู้ใช้", labelEn: "Users & Roles", route: "/users", icon: UsersRound },
  { key: "docs", label: "เอกสารดีไซน์", labelEn: "Design Spec", route: "/docs", icon: FileText },
];

/**
 * Forest-gradient left rail navigation (nav-sidebar).
 *
 * Phase 4: items are now filtered by the DEMO role (rolegate-seller-vs-admin) via
 * `canAccess`. A seller sees only pos/sales/shift; an admin sees all 7. The bottom
 * role toggle (action-set-role-seller / action-set-role-admin) flips the demo role.
 *
 * ⚠️ The role filter is a CLIENT DEMO, not security. The server does not enforce
 * roles and a seller can still reach an admin route by URL. Real enforcement
 * (session role + route middleware) = production-readiness.
 *
 * The red failed-job badge on the `data` item (display-sidebar-failed-badge-source)
 * is wired in Phase 6; for now the count is 0 and the dot is hidden.
 */
export function NavRail() {
  const pathname = usePathname();
  const router = useRouter();
  const { role, setRole } = useRole();

  // Phase 6 will source this from the real failed-sync-job count.
  const failedJobCount = 0;

  const visibleItems = NAV_ITEMS.filter((item) => canAccess(item.key, role));

  return (
    <nav
      aria-label="Primary navigation"
      style={{
        width: 76,
        flexShrink: 0,
        background: "linear-gradient(180deg,#0c3026,#071a16)",
        padding: "14px 10px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 12,
        color: "#d5fff0",
      }}
    >
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: 16,
          background: "linear-gradient(135deg,#23c884,#0b8060)",
          display: "grid",
          placeItems: "center",
          boxShadow: "0 16px 30px rgba(31,169,113,.25)",
        }}
      >
        <Store size={24} strokeWidth={2} color="#ffffff" />
      </div>

      {visibleItems.map((item) => {
        const Icon = item.icon;
        const active =
          pathname === item.route || pathname.startsWith(item.route + "/");
        const showBadge = item.badge && failedJobCount > 0;

        return (
          <button
            key={item.key}
            type="button"
            title={`${item.label} · ${item.labelEn}`}
            aria-label={`${item.label} (${item.labelEn})`}
            aria-current={active ? "page" : undefined}
            onClick={() => router.push(item.route)}
            style={{
              width: 52,
              height: 52,
              borderRadius: 16,
              display: "grid",
              placeItems: "center",
              position: "relative",
              cursor: "pointer",
              border: 0,
              transition: ".16s",
              background: active ? "rgba(255,255,255,.12)" : "transparent",
              color: active ? "#ffffff" : "#82a89c",
              boxShadow: active ? "inset 3px 0 0 #2ade96" : "none",
            }}
          >
            <Icon size={22} strokeWidth={2} />
            {showBadge && (
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  top: 10,
                  right: 10,
                  width: 9,
                  height: 9,
                  borderRadius: 99,
                  background: "#ef4444",
                  border: "2px solid #0a211a",
                }}
              />
            )}
          </button>
        );
      })}

      {/* DEMO role toggle (action-set-role-seller / action-set-role-admin).
          ⚠️ Not security — flips the client-only demo role. */}
      <RoleToggle role={role} onSetRole={setRole} />
    </nav>
  );
}

function RoleToggle({
  role,
  onSetRole,
}: {
  role: "admin" | "seller";
  onSetRole: (r: "admin" | "seller") => void;
}) {
  const isAdmin = role === "admin";

  return (
    <div
      style={{
        marginTop: "auto",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
      }}
    >
      {/* DEMO marker — makes the non-security nature visible in the UI. */}
      <span
        aria-hidden="true"
        title="โหมดสาธิต — สลับบทบาท (ไม่ใช่ระบบความปลอดภัยจริง)"
        style={{
          fontSize: 8,
          fontWeight: 700,
          letterSpacing: ".08em",
          color: "#5f8a7c",
          background: "rgba(255,255,255,.06)",
          borderRadius: 6,
          padding: "2px 5px",
        }}
      >
        DEMO
      </span>

      <div
        role="group"
        aria-label="สลับบทบาท (เดโม) · Demo role switch — not real security"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          padding: 5,
          borderRadius: 14,
          background: "rgba(255,255,255,.05)",
        }}
      >
        <button
          type="button"
          onClick={() => onSetRole("seller")}
          aria-pressed={!isAdmin}
          title="ผู้ขาย (เดโม) · Seller (demo)"
          aria-label="สลับเป็นบทบาทผู้ขาย (เดโม)"
          style={{
            width: 44,
            height: 40,
            borderRadius: 10,
            border: 0,
            cursor: "pointer",
            display: "grid",
            placeItems: "center",
            fontSize: 9,
            fontWeight: 700,
            lineHeight: 1.1,
            transition: ".16s",
            background: !isAdmin ? "rgba(35,200,132,.22)" : "transparent",
            color: !isAdmin ? "#ffffff" : "#82a89c",
            boxShadow: !isAdmin ? "inset 0 0 0 1px rgba(42,222,150,.5)" : "none",
          }}
        >
          <UsersRound size={16} strokeWidth={2} />
          <span style={{ marginTop: 2 }}>ผู้ขาย</span>
        </button>
        <button
          type="button"
          onClick={() => onSetRole("admin")}
          aria-pressed={isAdmin}
          title="ผู้ดูแล (เดโม) · Admin (demo)"
          aria-label="สลับเป็นบทบาทผู้ดูแล (เดโม)"
          style={{
            width: 44,
            height: 40,
            borderRadius: 10,
            border: 0,
            cursor: "pointer",
            display: "grid",
            placeItems: "center",
            fontSize: 9,
            fontWeight: 700,
            lineHeight: 1.1,
            transition: ".16s",
            background: isAdmin ? "rgba(35,200,132,.22)" : "transparent",
            color: isAdmin ? "#ffffff" : "#82a89c",
            boxShadow: isAdmin ? "inset 0 0 0 1px rgba(42,222,150,.5)" : "none",
          }}
        >
          <UserCog size={16} strokeWidth={2} />
          <span style={{ marginTop: 2 }}>Admin</span>
        </button>
      </div>
    </div>
  );
}
