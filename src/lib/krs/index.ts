// NODE-ONLY. Public exports for the KRS sync library (krs-sync P1). Re-exports the
// pooled mssql client (connection/test/introspection) and the AES-256-GCM crypto
// util. Do NOT import from a client component, `src/auth.config.ts`, or
// `src/middleware.ts` — these modules pull in the `mssql` driver / Node `crypto`
// and the Prisma singleton.

export {
  buildConnectionConfig,
  testConnection,
  testConnectionWithInput,
  introspectSchema,
} from "./client";
export type {
  KrsConnectionInput,
  KrsColumn,
  TestConnectionResult,
} from "./client";
export { encrypt, decrypt, KrsKeyError } from "./crypto";
