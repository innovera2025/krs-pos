"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { KrsConnectionSettingsDTO } from "@/types";
import { AdminOnly } from "@/components/AdminOnly";
import { useToast } from "@/components/ToastProvider";
import { ConnectionTab } from "@/components/data/ConnectionTab";
import { FieldMappingTab } from "@/components/data/FieldMappingTab";
import { DataFlowTab } from "@/components/data/DataFlowTab";
import { SyncActivityTab } from "@/components/data/SyncActivityTab";
import { LiveDataTab } from "@/components/data/LiveDataTab";
import { LiveStatusPill } from "@/components/data/LiveStatusPill";
import {
  INITIAL_DB_STATE,
  type DbState,
} from "@/components/data/connectionTypes";

type DataTab = "connection" | "mapping" | "flow" | "sync" | "preview";

const TABS: { key: DataTab; label: string; en: string }[] = [
  { key: "connection", label: "เชื่อมต่อ", en: "Connection" },
  { key: "mapping", label: "จับคู่ฟิลด์", en: "Field Mapping" },
  { key: "flow", label: "การไหลของข้อมูล", en: "Data Flow" },
  { key: "sync", label: "บันทึกการซิงค์", en: "Sync Activity" },
  { key: "preview", label: "ตรวจข้อมูล", en: "Live Data" },
];

/**
 * KRS Data Link admin screen (Phase 6b). 4 tabs (Connection / Field Mapping /
 * Data Flow / Live Data) + a tri-state live-status pill. AdminOnly-wrapped (the
 * client demo guard).
 *
 * As of krs-sync P1 the Connection tab is a REAL admin-only MS SQL Server
 * connection (the `mssql` driver, encrypted config + AES-256-GCM password, real
 * test-connection/schema routes) — NOT a simulation. The Live Data tab is a REAL
 * read-only browser over the live KRS schema (GET /api/krs/schema lists every base
 * table; ?table=X returns columns + a TOP 50 sample). As of krs-sync R1 the Data
 * Flow tab is a REAL POS↔KRS stock RECONCILIATION dashboard (GET /api/krs/reconcile
 * compares POS Product.stock against the KRS standard-cost ledger balance; POST
 * /api/krs/sync-stock is the baseline import that SETs POS stock from KRS — it never
 * writes to KRS). The Field Mapping and sync-mode/stock-method state is still pure
 * client React state (decisions B/C/D). Outbound write-back to KRS (R2) is deferred.
 */
export default function DataPage() {
  return (
    <AdminOnly>
      <DataScreen />
    </AdminOnly>
  );
}

function DataScreen() {
  const { showToast } = useToast();
  const [tab, setTab] = useState<DataTab>("connection");

  // Refs to each tab button so Left/Right arrow keys can move focus between tabs
  // (ARIA tablist keyboard pattern). Indexed by TABS order.
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Left/Right arrow navigation across the tablist: wrap around, select + focus.
  function onTabKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const dir = e.key === "ArrowRight" ? 1 : -1;
    const next = (index + dir + TABS.length) % TABS.length;
    setTab(TABS[next].key);
    tabRefs.current[next]?.focus();
  }

  // ---- Connection simulation (client state, decision B/C) ----
  const [db, setDbState] = useState<DbState>(INITIAL_DB_STATE);
  const [testing, setTesting] = useState(false);
  const [stockSync, setStockSync] = useState(true);

  const setDb = useCallback(
    (patch: Partial<DbState>) => setDbState((s) => ({ ...s, ...patch })),
    []
  );

  // Connection test + config load/save are now REAL and owned by ConnectionTab
  // (krs-sync P1): it drives the shared `db`/`testing` state via setDb/setTesting
  // so the header live-status pill stays consistent. The previous simulated
  // testConnection/insertTestRow timers were removed with that change.

  // ---- Page-level auto health-check (krs-sync status UX fix) ----
  //
  // KRS connects PER-OPERATION (no persistent socket): the displayed "connected"
  // means the last health check passed, auto-refreshed. The previous status was
  // ephemeral client state that reset to `disconnected` on every (re)mount and only
  // flipped to connected after a MANUAL Test click — so the pill read "offline" even
  // when KRS was configured and reachable.
  //
  // This effect runs at the DATASCREEN level (NOT inside ConnectionTab, which
  // unmounts on tab switch) so the top LiveStatusPill is correct on ANY tab. On
  // mount it: (1) GETs the saved config; (2) if KRS is configured (passwordSet +
  // host), shows "checking" (testing → pill reads "กำลังเชื่อมต่อ…") and POSTs the
  // saved-config test ({}); (3) sets db.status/latency/host from the result. It then
  // re-checks on a light ~60s cadence so the status stays live + latency fresh. If
  // KRS is NOT configured it leaves the status disconnected and does NOT poll.
  //
  // Race robustness (mirrors the ConnectionTab H1/FIX-2 lesson): the parent-owned
  // setters (`setDb`/`setTesting`) run UNCONDITIONALLY in every exit path so the
  // pill/button never get stuck in "checking"; only `showToast` and the
  // poll-scheduling are gated by the `mounted` ref. The interval is cleared and
  // `mounted` flipped false in cleanup so there's no setState-after-unmount.
  useEffect(() => {
    let mounted = true;
    let intervalId: ReturnType<typeof setInterval> | undefined;
    // In-flight guard so an overlapping interval tick can't double-run a check.
    let checking = false;

    const runHealthCheck = async (): Promise<void> => {
      if (checking) return;
      checking = true;
      // PARENT setters — always run (never gated on `mounted`) so a mount/unmount
      // race can't leave the pill stuck on "checking".
      setTesting(true);
      setDb({ status: "testing" });
      try {
        const res = await fetch("/api/krs/test-connection", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Empty body → test the SAVED config (mirrors the manual Test path).
          body: JSON.stringify({}),
        });
        const result = (await res.json().catch(() => null)) as
          | { connected: boolean; latencyMs: number | null; error: string | null }
          | null;
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const lastCheck = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(
          now.getSeconds()
        )}`;
        if (result?.connected) {
          // Mirror the manual Test success shape.
          setDb({ status: "connected", latency: result.latencyMs ?? 0, lastCheck });
        } else {
          setDb({ status: "disconnected", latency: 0, lastCheck });
        }
      } catch {
        // PARENT setter — always run so the pill never gets stuck (mirrors FIX 2).
        setDb({ status: "disconnected", latency: 0 });
      } finally {
        // PARENT setter — always reset `testing` (the stuck-state root cause).
        setTesting(false);
        checking = false;
      }
    };

    (async () => {
      try {
        const res = await fetch("/api/krs/settings");
        if (!res.ok) throw new Error("load failed");
        const data = (await res.json()) as { settings: KrsConnectionSettingsDTO | null };
        // Only the poll-SCHEDULING is gated by `mounted`; the status setters inside
        // runHealthCheck stay unconditional.
        if (!mounted) return;
        const s = data.settings;
        // Configured = a stored password AND a host (the saved-config test needs both).
        if (!s || !s.passwordSet || !s.host) return; // Not configured → stay disconnected, no poll.
        // Seed `host` (+ port) at the PAGE level so the top LiveStatusPill shows the
        // host suffix on ANY tab — ConnectionTab's own load only runs while that tab
        // is mounted, so on a non-Connection tab `db.host` would otherwise be empty.
        setDb({ host: s.host, port: String(s.port) });
        await runHealthCheck();
        if (!mounted) return;
        // Light periodic re-check (~60s) — keeps status live + latency fresh without
        // hammering the per-operation KRS connection.
        intervalId = setInterval(() => {
          void runHealthCheck();
        }, 60_000);
      } catch {
        // GET failed → KRS config unknown; leave status as-is (disconnected default)
        // and do not poll. No toast (auto-check is silent; manual Test surfaces errors).
      }
    })();

    return () => {
      mounted = false;
      if (intervalId !== undefined) clearInterval(intervalId);
    };
    // setDb/setTesting are stable parent useCallback/useState setters; run once on
    // mount. The deeper status-setting logic intentionally does not depend on render
    // state, so an empty dep array is correct (and keeps the poll on a single timer).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleStockSync = useCallback(() => {
    setStockSync((on) => {
      showToast(on ? "ปิดการซิงค์สต็อกกับบัญชี" : "เปิดการซิงค์สต็อกกับบัญชี · Stock sync on");
      return !on;
    });
  }, [showToast]);

  // The Data Flow tab is now SELF-CONTAINED (krs-sync R1): it fetches its own stock
  // reconciliation from /api/krs/reconcile and runs the baseline import via
  // /api/krs/sync-stock. The page no longer fetches /api/sync-jobs for it. The
  // legacy /api/sync-jobs route + the NavRail failed-count badge are left intact;
  // they are just no longer surfaced in this tab.

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Tab bar + live pill */}
      <div
        className="flex items-center gap-[10px] border-b px-[22px] py-[13px]"
        style={{ background: "#fff", borderColor: "#eef2f6" }}
      >
        <div
          role="tablist"
          aria-label="หมวดการเชื่อมข้อมูล KRS · KRS Data Link sections"
          className="flex gap-1 overflow-x-auto"
        >
          {TABS.map((t, i) => {
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                id={`data-tab-${t.key}`}
                aria-controls={`data-panel-${t.key}`}
                aria-selected={active}
                // Roving tabindex: only the active tab is in the tab order; arrows
                // move between the rest (ARIA tablist keyboard pattern).
                tabIndex={active ? 0 : -1}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                onKeyDown={(e) => onTabKeyDown(e, i)}
                onClick={() => setTab(t.key)}
                className="relative flex flex-shrink-0 cursor-pointer flex-col gap-px px-[15px] pb-3 pt-[9px] transition hover:bg-[#f8fafc]"
                style={{ borderRadius: "9px 9px 0 0" }}
              >
                <span className="text-[13px] font-semibold" style={{ color: "#1e293b" }}>
                  {t.label}
                </span>
                <span className="text-[9.5px]" style={{ color: "var(--soft)" }}>
                  {t.en}
                </span>
                {active ? (
                  <span
                    className="absolute"
                    style={{ left: 8, right: 8, bottom: -1, height: 2.5, background: "#16a34a", borderRadius: 3 }}
                  />
                ) : null}
              </button>
            );
          })}
        </div>
        <div className="flex-1" />
        <LiveStatusPill status={db.status} testing={testing} host={db.host} />
      </div>

      {/* Tab body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-[22px] py-5" style={{ background: "#eef2f6" }}>
        <div
          role="tabpanel"
          id={`data-panel-${tab}`}
          aria-labelledby={`data-tab-${tab}`}
          className="mx-auto"
          style={{ maxWidth: 1100 }}
        >
          {tab === "connection" ? (
            <ConnectionTab
              db={db}
              setDb={setDb}
              testing={testing}
              setTesting={setTesting}
              stockSync={stockSync}
              onToggleStockSync={toggleStockSync}
            />
          ) : null}
          {tab === "mapping" ? <FieldMappingTab /> : null}
          {tab === "flow" ? <DataFlowTab /> : null}
          {tab === "sync" ? <SyncActivityTab /> : null}
          {tab === "preview" ? <LiveDataTab /> : null}
        </div>
      </div>
    </div>
  );
}
