/**
 * Shared client-state types for the KRS connection simulation (decision B/C).
 * The Connection tab keeps host/port/db/user/ssl/status + session counters in pure
 * React state (no server persistence — real KRS config = production-readiness).
 */

/** Tri-state connection status (the engine never reaches a real DB). */
export type DbStatus = "connected" | "disconnected" | "testing";

/** Sync mode option (Field Mapping → SyncMode section). `daily` is the default. */
export type SyncMode = "realtime" | "daily" | "manual";

/** Stock accounting method (Field Mapping → StockMethod). `perpetual` default. */
export type StockMethod = "perpetual" | "periodic";

/**
 * The simulated KRS connection config + live stats held on /data. Defaults mirror
 * the Simple POS source-of-truth (203.0.113.45:3306 / krs_pos / krs_app / SSL on).
 */
export type DbState = {
  engine: string; // "MySQL" — read-only in the UI
  host: string;
  port: string;
  name: string;
  user: string;
  ssl: boolean;
  status: DbStatus;
  latency: number; // ms
  lastCheck: string; // HH:MM:SS display string
  inserted: number; // session INSERT counter (test rows)
  lastInsert: string | null; // last test-insert timestamp display string
};

/** The initial connection state (Simple POS defaults). */
export const INITIAL_DB_STATE: DbState = {
  engine: "MySQL",
  host: "203.0.113.45",
  port: "3306",
  name: "krs_pos",
  user: "krs_app",
  ssl: true,
  status: "connected",
  latency: 18,
  lastCheck: "14:24:50",
  inserted: 0,
  lastInsert: null,
};
