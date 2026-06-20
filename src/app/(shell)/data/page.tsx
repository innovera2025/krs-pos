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
 * client demo guard). The connection/mapping/mode state is pure client React state
 * (decisions B/C/D); only the Data Flow SyncJob CRUD touches the server. The KRS
 * transport is SIMULATED throughout — there is no real MySQL/SSL connection.
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

  // Holds the pending 1100ms testConnection timer. testConnection is an onClick
  // handler, so React never consumes a returned cleanup; we clear it explicitly on
  // unmount (below) to avoid a deferred setState/toast firing on the next route.
  const testTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // testConnection: status → testing immediately; after 1100ms → connected with a
  // random latency (9–31) + fresh lastCheck. Pure client; no DB.
  const testConnection = useCallback(() => {
    if (testing) return;
    if (testTimerRef.current) clearTimeout(testTimerRef.current);
    setTesting(true);
    setDbState((s) => ({ ...s, status: "testing" }));
    showToast(`กำลังทดสอบการเชื่อมต่อ ${db.host}...`);
    testTimerRef.current = setTimeout(() => {
      const latency = Math.floor(Math.random() * 23 + 9); // 9–31
      const pad = (n: number) => String(n).padStart(2, "0");
      const lastCheck = `14:${pad(Math.floor(Math.random() * 60))}:${pad(
        Math.floor(Math.random() * 60)
      )}`;
      testTimerRef.current = null;
      setTesting(false);
      setDbState((s) => ({ ...s, status: "connected", latency, lastCheck }));
      showToast(`เชื่อมต่อสำเร็จ · ${db.engine} @ ${db.host} (${latency}ms)`);
    }, 1100);
  }, [testing, db.host, db.engine, showToast]);

  // Clear any pending testConnection timer on unmount so the deferred
  // setTesting/setDbState/showToast never fires after the screen is gone (e.g. an
  // admin→seller role flip → AdminOnly redirect, or a NavRail nav click within ~1.1s).
  useEffect(() => {
    return () => {
      if (testTimerRef.current) clearTimeout(testTimerRef.current);
    };
  }, []);

  // insertTestRow: bump the session counter + lastInsert ts (NO DB write). Feeds
  // the green "just inserted" row in the Live Data sales table.
  const insertTestRow = useCallback(() => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts = `2026-06-16 14:${pad(now.getSeconds())}:${pad(
      Math.floor(Math.random() * 60)
    )}`;
    setDbState((s) => ({ ...s, inserted: s.inserted + 1, lastInsert: ts }));
    showToast(`INSERT 1 row → ${db.name}.sales · สำเร็จ (1 row affected)`);
  }, [db.name, showToast]);

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

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/sync-jobs");
      if (!res.ok) throw new Error("fetch failed");
      const data = (await res.json()) as SyncJobDTO[];
      setJobs(data);
    } catch {
      // leave the existing list; the table shows its empty/loaded state.
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
        <div className="flex gap-1">
          {TABS.map((t) => {
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => setTab(t.key)}
                className="relative flex cursor-pointer flex-col gap-px px-[15px] pb-3 pt-[9px] transition hover:bg-[#f8fafc]"
                style={{ borderRadius: "9px 9px 0 0" }}
              >
                <span className="text-[13px] font-semibold" style={{ color: "#1e293b" }}>
                  {t.label}
                </span>
                <span className="text-[9.5px]" style={{ color: "#94a3b8" }}>
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
        <div className="mx-auto" style={{ maxWidth: 1100 }}>
          {tab === "connection" ? (
            <ConnectionTab
              db={db}
              setDb={setDb}
              testing={testing}
              onTestConnection={testConnection}
              onInsertTestRow={insertTestRow}
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
            <DataFlowTab jobs={jobs} loading={loading} onRefetch={fetchJobs} />
          ) : null}
          {tab === "preview" ? (
            <LiveDataTab jobs={jobs} insertedCount={db.inserted} lastInsert={db.lastInsert} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
