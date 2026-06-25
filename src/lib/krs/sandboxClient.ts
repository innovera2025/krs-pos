// NODE-ONLY. Builds the SANDBOX MS SQL Server `mssql` config for the KRS outbound
// write-back (krs-sync P2). Imported ONLY by the Track-B write module (`writeback.ts`)
// and — indirectly via the dispatcher — the dispatch route. NEVER import from a client
// component, `src/auth.config.ts`, or `src/middleware.ts` (it pulls in the `mssql`
// driver).
//
// WHY SEPARATE FROM client.ts: the production inbound KRS connection lives in the
// `KrsConnectionSettings` DB row and is built by `buildConnectionConfig()` in
// client.ts. The OUTBOUND write MUST target a SEPARATE sandbox connection (P0 spec
// mandate) so a verification run can never write to production KRS. This module reads
// the `KRS_SANDBOX_*` env vars DIRECTLY and shares NOTHING with the prod path.
//
// TRACK A: this is config plumbing ONLY. `buildSandboxConfig()` returns a config or
// null — it does NOT open a connection. No live mssql connection is made anywhere in
// Track A.
//
// SECRET HYGIENE: the sandbox password is plaintext in the env (sandbox, not prod) but
// is STILL never logged — it lives only inside the returned `sql.config` consumed by
// the write module's pool (mirrors client.ts's discipline).

import sql from "mssql";
import { env } from "@/lib/env";

/** Pool sizing + timeouts (mirrors client.ts). POOL_MIN=0: throwaway per-dispatch
 *  pools (open → write → close in a `finally`), so no idle sandbox session is held. */
const POOL_MIN = 0;
const POOL_MAX = 4;
const CONNECT_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 20_000;

/** Default SQL Server port when KRS_SANDBOX_PORT is unset. */
const DEFAULT_SANDBOX_PORT = 1433;

/**
 * Build an `mssql` config from the `KRS_SANDBOX_*` env vars, or return `null` when the
 * sandbox is not configured (any of host/db/user/pass empty). Returning null lets the
 * write module refuse cleanly ("sandbox not configured") instead of throwing a driver
 * error. Pure: reads env + constructs an object; NO connection is opened.
 *
 * `ssl` maps to `options.encrypt`; `trustServerCertificate` honors KRS_SANDBOX_TRUST_CERT
 * when encryption is on (on-prem-friendly self-signed certs), forced on when off
 * (matching mssql's behavior for an unencrypted connection) — identical semantics to
 * client.ts's `toConfig`.
 */
export function buildSandboxConfig(): sql.config | null {
  const host = (env.KRS_SANDBOX_HOST ?? "").trim();
  const database = (env.KRS_SANDBOX_DB ?? "").trim();
  const user = (env.KRS_SANDBOX_USER ?? "").trim();
  const password = env.KRS_SANDBOX_PASS ?? "";

  // All four core parameters are required for a usable connection. Any missing → the
  // sandbox is not configured (the common Track-A / flag-off state).
  if (host === "" || database === "" || user === "" || password === "") {
    return null;
  }

  const port = (() => {
    const raw = (env.KRS_SANDBOX_PORT ?? "").trim();
    if (raw === "") return DEFAULT_SANDBOX_PORT;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 && n <= 65535 ? n : DEFAULT_SANDBOX_PORT;
  })();

  const ssl = env.KRS_SANDBOX_SSL !== "false"; // default true
  const trustServerCert = env.KRS_SANDBOX_TRUST_CERT !== "false"; // default true

  return {
    server: host,
    port,
    database,
    user,
    password,
    options: {
      encrypt: ssl,
      trustServerCertificate: ssl ? trustServerCert : true,
    },
    pool: { min: POOL_MIN, max: POOL_MAX },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    requestTimeout: REQUEST_TIMEOUT_MS,
  };
}

/** Whether the sandbox connection is configured (host/db/user/pass all present).
 *  A cheap boolean the dispatcher can check without building the full config. */
export function isSandboxConfigured(): boolean {
  return buildSandboxConfig() !== null;
}
