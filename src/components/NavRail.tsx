"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  Store,
  PanelLeft,
  ReceiptText,
  Clock3,
  DatabaseZap,
  Package,
  UsersRound,
  FileText,
  LogOut,
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
 * Items are filtered by the SESSION role (rolegate-seller-vs-admin) via
 * `canAccess`. A seller sees only pos/sales/shift; an admin (ADMIN or MANAGER)
 * sees all 7. The bottom slot is now a real LOGOUT button (the former DEMO role
 * toggle is removed — the role comes from the Auth.js session).
 *
 * ⚠️ The client role filter is UX only. The real enforcement is server-side:
 * middleware (`authorized`) redirects unauthorized navigations and the API
 * `requireUser`/`requireAdmin` guards reject unauthorized requests. A seller can
 * no longer reach an admin route by URL (middleware bounces them to /pos).
 *
 * The red failed-job badge on the `data` item (display-sidebar-failed-badge-source)
 * is sourced (Phase 6b) from GET /api/sync-jobs/failed-count — a single
 * COUNT(status=FAILED). It is fetched once on mount, starting at 0 so there is no
 * layout shift and a fetch failure leaves the badge hidden (the rail must never
 * break a navigation). Because the rail lives in the persistent (shell) layout and
 * never remounts on intra-shell nav, it also re-fetches whenever DataFlowTab
 * dispatches a `krs:sync-jobs-changed` window event (after retry/skip/pull/insert),
 * so the badge clears once the true FAILED count drops to 0.
 */
export function NavRail() {
  const pathname = usePathname();
  const router = useRouter();
  const { role, userName } = useRole();

  // Failed-sync-job count for the `data` badge (display-sidebar-failed-badge-
  // source). Init 0 → no layout shift; errors are swallowed (the rail must never
  // break navigation). Re-fetched on mount and whenever DataFlowTab dispatches
  // `krs:sync-jobs-changed`, so the badge clears after a retry/skip.
  const [failedJobCount, setFailedJobCount] = useState(0);
  useEffect(() => {
    let mounted = true;
    // A still-mounted check avoids a setState-after-unmount warning if a fetch
    // resolves after the rail (theoretically) unmounts.
    const loadFailedCount = () => {
      fetch("/api/sync-jobs/failed-count")
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { count?: number } | null) => {
          if (mounted && data && typeof data.count === "number") {
            setFailedJobCount(data.count);
          }
        })
        .catch(() => {
          /* ignore — leave the badge hidden on error */
        });
    };
    loadFailedCount();
    window.addEventListener("krs:sync-jobs-changed", loadFailedCount);
    return () => {
      mounted = false;
      window.removeEventListener("krs:sync-jobs-changed", loadFailedCount);
    };
  }, []);

  const visibleItems = NAV_ITEMS.filter((item) => canAccess(item.key, role));

  return (
    <nav
      aria-label="Primary navigation"
      // The rail width lives in the `.nav-rail` CSS class (globals.css) — NOT an
      // inline `width` — so a `@media (max-width: 900px)` rule can override it on
      // tablet (inline styles beat media queries; a class does not). Desktop stays
      // 76px exactly.
      className="nav-rail"
      style={{
        flexShrink: 0,
        background: "linear-gradient(180deg,#0c3026,#071a16)",
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
              color: active ? "#ffffff" : "#a0bfb5",
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

      {/* Real logout (replaces the former DEMO role toggle). Shows the logged-in
          user's name (when available) above the sign-out button. */}
      <LogoutButton role={role} userName={userName} />
    </nav>
  );
}

function LogoutButton({
  role,
  userName,
}: {
  role: "admin" | "seller";
  userName: string | null;
}) {
  // Thai-first role label for the small caption under the user name.
  const roleLabel = role === "admin" ? "ผู้ดูแล" : "ผู้ขาย";

  return (
    <div
      style={{
        marginTop: "auto",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        paddingBottom: 4,
      }}
    >
      {/* Logged-in identity (truncated). Hidden from a11y duplication via title. */}
      {userName && (
        <div
          title={`${userName} · ${roleLabel}`}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 1,
            maxWidth: 64,
          }}
        >
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: "#d5fff0",
              lineHeight: 1.1,
              maxWidth: 64,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {userName}
          </span>
          <span
            style={{
              fontSize: 8,
              fontWeight: 600,
              letterSpacing: ".06em",
              color: "#5f8a7c",
            }}
          >
            {roleLabel}
          </span>
        </div>
      )}

      <button
        type="button"
        onClick={() => signOut({ callbackUrl: "/login" })}
        title="ออกจากระบบ · Sign out"
        aria-label="ออกจากระบบ · Sign out"
        style={{
          width: 52,
          height: 52,
          borderRadius: 16,
          border: 0,
          cursor: "pointer",
          display: "grid",
          placeItems: "center",
          transition: ".16s",
          background: "rgba(255,255,255,.05)",
          color: "#a0bfb5",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "rgba(239,68,68,.18)";
          e.currentTarget.style.color = "#ffd9d9";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "rgba(255,255,255,.05)";
          e.currentTarget.style.color = "#a0bfb5";
        }}
      >
        <LogOut size={22} strokeWidth={2} />
      </button>
    </div>
  );
}
