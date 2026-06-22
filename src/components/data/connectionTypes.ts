/**
 * Shared client-state types for the KRS Connection tab.
 *
 * As of krs-sync P1 the connection is REAL: the tab loads its config from
 * GET /api/krs/settings on mount, persists via PATCH, and tests via
 * POST /api/krs/test-connection. The engine is fixed to SQL Server (the POS now
 * targets a KRS MS SQL Server, default port 1433). The defaults below are EMPTY /
 * disconnected — the form is populated by the server on mount, and the status is
 * "disconnected" until the first real Test Connection.
 */

/** Tri-state connection status. "disconnected" is the initial/unknown state. */
export type DbStatus = "connected" | "disconnected" | "testing";

/** Sync mode option (Field Mapping → SyncMode section). `daily` is the default. */
export type SyncMode = "realtime" | "daily" | "manual";

/** Stock accounting method (Field Mapping → StockMethod). `perpetual` default. */
export type StockMethod = "perpetual" | "periodic";

/**
 * The KRS connection config + live stats held on /data. `engine` is the read-only
 * DISPLAY string ("SQL Server"); the DB stores the canonical "SQLSERVER". The
 * password is never held here — only `passwordSet` (true when the server has a
 * stored encrypted password) drives the masked-input placeholder.
 */
export type DbState = {
  engine: string; // "SQL Server" — read-only display (DB stores "SQLSERVER")
  host: string;
  port: string;
  name: string;
  user: string;
  ssl: boolean;
  /** Trust a self-signed KRS cert when SSL is on (on-prem-friendly default true).
   *  Only meaningful when `ssl` is true. */
  trustServerCert: boolean;
  /** True when the server has a stored (encrypted) password — drives the masked
   *  password placeholder. The plaintext/ciphertext is never sent to the client. */
  passwordSet: boolean;
  /** Saved sync mode (realtime | daily | manual), loaded from / saved to the DB. */
  syncMode: SyncMode;
  status: DbStatus;
  latency: number; // ms
  lastCheck: string; // HH:MM:SS display string
  inserted: number; // session INSERT counter (test rows)
  lastInsert: string | null; // last test-insert timestamp display string
};

/** The initial connection state — empty + disconnected until GET populates it. */
export const INITIAL_DB_STATE: DbState = {
  engine: "SQL Server",
  host: "",
  port: "1433",
  name: "",
  user: "",
  ssl: true,
  trustServerCert: true,
  passwordSet: false,
  syncMode: "realtime",
  status: "disconnected",
  latency: 0,
  lastCheck: "",
  inserted: 0,
  lastInsert: null,
};
