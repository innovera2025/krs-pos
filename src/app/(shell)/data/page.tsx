"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SyncJobDTO } from "@/types";
import { AdminOnly } from "@/components/AdminOnly";
import { useToast } from "@/components/ToastProvider";
import { ConnectionTab } from "@/components/data/ConnectionTab";
import { FieldMappingTab } from "@/components/data/FieldMappingTab";
import { DataFlowTab } from "@/components/data/DataFlowTab";
import { LiveDataTab } from "@/components/data/LiveDataTab";
import { LiveStatusPill } from "@/components/data/LiveStatusPill";
import {
  INITIAL_DB_STATE,
  type DbState,
  type SyncMode,
  type StockMethod,
} from "@/components/data/connectionTypes";

type DataTab = "connection" | "mapping" | "flow" | "preview";

const TABS: { key: DataTab; label: string; en: string }[] = [
  { key: "connection", label: "เชื่อมต่อ", en: "Connection" },
  { key: "mapping", label: "จับคู่ฟิลด์", en: "Field Mapping" },
  { key: "flow", label: "การไหลของข้อมูล", en: "Data Flow" },
  { key: "preview", label: "ตรวจข้อมูล", en: "Live Data" },
];

/**
 * KRS Data Link admin screen (Phase 6b). 4 tabs (Connection / Field Mapping /
 * Data Flow / Live Data) + a tri-state live-status pill. AdminOnly-wrapped (the
 * client demo guard).
 *
 * As of krs-sync P1 the Connection tab is a REAL admin-only MS SQL Server
 * connection (the `mssql` driver, encrypted config + AES-256-GCM password, real
 * test-connection/introspection routes) — NOT a simulation. The Field Mapping and
 * sync-mode/stock-method state is still pure client React state (decisions B/C/D),
 * and only the Data Flow SyncJob CRUD touches the server; those sync tabs remain
 * SIMULATED (the real outbox/sync pipeline is P2/P3).
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
  const [syncMode, setSyncMode] = useState<SyncMode>("daily");
  const [stockMethod, setStockMethod] = useState<StockMethod>("perpetual");

  const setDb = useCallback(
    (patch: Partial<DbState>) => setDbState((s) => ({ ...s, ...patch })),
    []
  );

  // Connection test + config load/save are now REAL and owned by ConnectionTab
  // (krs-sync P1): it drives the shared `db`/`testing` state via setDb/setTesting
  // so the header live-status pill stays consistent. The previous simulated
  // testConnection/insertTestRow timers were removed with that change.

  const toggleStockSync = useCallback(() => {
    setStockSync((on) => {
      showToast(on ? "ปิดการซิงค์สต็อกกับบัญชี" : "เปิดการซิงค์สต็อกกับบัญชี · Stock sync on");
      return !on;
    });
  }, [showToast]);

  const onSyncMode = useCallback(
    (m: SyncMode) => {
      setSyncMode(m);
      const labels: Record<SyncMode, string> = {
        realtime: "รายบิลทันที",
        daily: "สรุปรายวัน",
        manual: "แมนนวล",
      };
      showToast(`เปลี่ยนโหมดซิงค์เป็น ${labels[m]}`);
    },
    [showToast]
  );

  const onStockMethod = useCallback(
    (m: StockMethod) => {
      setStockMethod(m);
      showToast(
        `วิธีลงบัญชีสต็อก: ${
          m === "perpetual" ? "ต่อเนื่อง (ลง COGS ทุกบิล)" : "เป็นงวด (ปรับมูลค่าตอนปิดรอบ)"
        }`
      );
    },
    [showToast]
  );

  // ---- Sync jobs (server-backed) ----
  const [jobs, setJobs] = useState<SyncJobDTO[]>([]);
  const [loading, setLoading] = useState(true);
  // Tri-state error flag (matches the loading/empty/error pattern on /pos /products
  // /sales): a failed GET /api/sync-jobs surfaces a clear message in the Data Flow
  // table instead of a silent empty state.
  const [jobsError, setJobsError] = useState(false);

  const fetchJobs = useCallback(async () => {
    setJobsError(false);
    try {
      const res = await fetch("/api/sync-jobs");
      if (!res.ok) throw new Error("fetch failed");
      const data = (await res.json()) as SyncJobDTO[];
      setJobs(data);
    } catch {
      // Surface the failure (the Data Flow table renders an error state). Keep any
      // previously loaded list so a transient refetch error after data already
      // loaded does not blank the table.
      setJobsError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchJobs();
  }, [fetchJobs]);

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
          {tab === "mapping" ? (
            <FieldMappingTab
              syncMode={syncMode}
              onSyncMode={onSyncMode}
              stockMethod={stockMethod}
              onStockMethod={onStockMethod}
            />
          ) : null}
          {tab === "flow" ? (
            <DataFlowTab jobs={jobs} loading={loading} error={jobsError} onRefetch={fetchJobs} />
          ) : null}
          {tab === "preview" ? (
            <LiveDataTab jobs={jobs} insertedCount={db.inserted} lastInsert={db.lastInsert} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
