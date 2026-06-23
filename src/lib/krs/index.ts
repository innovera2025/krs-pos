// NODE-ONLY. Public exports for the KRS sync library (krs-sync P1). Re-exports the
// pooled mssql client (connection/test/introspection) and the AES-256-GCM crypto
// util. Do NOT import from a client component, `src/auth.config.ts`, or
// `src/middleware.ts` — these modules pull in the `mssql` driver / Node `crypto`
// and the Prisma singleton.

export {
  buildConnectionConfig,
  testConnection,
  testConnectionWithInput,
  listKrsTables,
  getKrsTableDetail,
} from "./client";
export type {
  KrsConnectionInput,
  KrsColumn,
  KrsTableSummary,
  KrsTableDetail,
  KrsTableDetailResult,
  KrsSampleRow,
  TestConnectionResult,
} from "./client";
// Inbound product pull (krs-sync): KRS read + POS upsert. Exported here so the
// one-time import script can reuse the SAME functions the /api/krs/pull-products
// route uses.
export { fetchKrsProducts } from "./products";
export type { KrsProductRecord } from "./products";
export { importKrsProducts } from "./importProducts";
export type { ImportProductsResult } from "./importProducts";
// Inbound stock reconciliation + baseline import (krs-sync R1): KRS read-only
// current-stock fetch. Exported here so the reconcile + sync-stock routes share the
// SAME read.
export { fetchKrsStockBalances } from "./stock";
export type { KrsStockBalance } from "./stock";
export { encrypt, decrypt, KrsKeyError } from "./crypto";
