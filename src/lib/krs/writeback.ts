// NODE-ONLY. KRS outbound cash-sale write module (krs-sync P2). Imported ONLY by the
// dispatcher (`dispatcher.ts`). NEVER import from a client component,
// `src/auth.config.ts`, or `src/middleware.ts` (it pulls in the `mssql` driver).
//
// ┌─────────────────────────────────────────────────────────────────────────────┐
// │ TRACK A: THIS IS A STUB. It performs NO mssql write of any kind.              │
// │                                                                              │
// │ The real write (RunningNumber claim → SalesInvoiceHdr → SalesInvoiceDtl ×N → │
// │ InventoryFlowHdr → InventoryFlowDtl ×N → TheJournal ×3, all in ONE mssql      │
// │ transaction, all parameterized) is TRACK B — blocked on the vendor constants  │
// │ in writebackConfig.ts (the TODO_FROM_VENDOR values) and a sandbox connection. │
// │ Until those land, writeKrsSale() throws WritebackNotImplementedError so the   │
// │ dispatcher leaves the job for a later attempt. It NEVER guesses a constant and │
// │ NEVER inserts a row. (plan §9, §10)                                           │
// └─────────────────────────────────────────────────────────────────────────────┘
//
// CROSS-ENGINE INVARIANT: this module NEVER imports `@/lib/prisma` and is NEVER called
// inside a Prisma `$transaction`. It opens its own mssql pool on the sandbox config
// (Track B) and always closes it in a `finally`.
//
// Plan: process/features/krs-sync/active/krs-outbound-writeback_PLAN_25-06-26.md §9

import type sql from "mssql";
import type { SalePayload } from "./salePayload";
import {
  KRS_WRITE_CONFIG,
  assertWriteConfigReady,
  WriteConfigNotReadyError,
} from "./writebackConfig";

/** The result of a successful KRS write (stored in SyncJob.response). */
export type KrsWriteResult = {
  /** The generated KRS document/transaction number for the sale. */
  transactionNo: string;
  /** The generated journal document number. */
  journalNo: string;
};

/**
 * Thrown by the Track-A stub to signal "the KRS write is not implemented / not yet
 * configured" — distinct from a transient driver failure. The dispatcher treats this
 * as a NON-retryable-but-not-terminal "leave pending" outcome (it does NOT count an
 * attempt toward the FAILED terminal, and it does NOT insert anything). Once Track B
 * lands and the vendor constants + sandbox are configured, this is never thrown.
 */
export class WritebackNotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WritebackNotImplementedError";
  }
}

/**
 * Re-export so the dispatcher can distinguish a config-gap (vendor constants still
 * TODO_FROM_VENDOR) from a transient failure. A config gap is also "leave pending".
 */
export { WriteConfigNotReadyError };

/**
 * Write one POS cash sale to KRS.
 *
 * TRACK A STUB CONTRACT: this function performs NO mssql write. It validates that the
 * write COULD proceed (vendor config resolved) and then refuses with a clear,
 * non-terminal error, because the actual insert logic is Track B.
 *
 *  1. `assertWriteConfigReady()` throws `WriteConfigNotReadyError` if ANY required
 *     vendor constant is still `TODO_FROM_VENDOR` — i.e. the write is not configured.
 *     This is the production-path gate that guarantees no guessed constant is ever
 *     written (plan §10).
 *  2. If (hypothetically) every constant were resolved, this stub still throws
 *     `WritebackNotImplementedError` because the Track-B insert sequence is not built.
 *     It does NOT open a connection and does NOT insert.
 *
 * When Track B is implemented, the body below is replaced with the real single-mssql-
 * transaction write (RunningNumber + 5 inserts + 3 journal rows), and the parameters
 * are used: `payload` (the snapshot) + `config` (the sandbox pool config).
 *
 * @param _payload The SALE snapshot (consumed by the Track-B write; unused in the stub).
 * @param _config  The sandbox mssql config (consumed by the Track-B write; unused here).
 * @throws WriteConfigNotReadyError | WritebackNotImplementedError — both "leave pending".
 */
export async function writeKrsSale(
  _payload: SalePayload,
  _config: sql.config
): Promise<KrsWriteResult> {
  // (1) Refuse if any vendor constant is still a TODO placeholder — never guess.
  assertWriteConfigReady(KRS_WRITE_CONFIG);

  // (2) Even with a fully-resolved config, the Track-B insert sequence is not built.
  // Throw a clear non-terminal error — NO connection opened, NO row inserted.
  throw new WritebackNotImplementedError(
    "KRS cash-sale writeback is not implemented yet (Track B — blocked on vendor INSERT constants + sandbox connection; see krs-outbound-writeback_PLAN_25-06-26.md §10)."
  );
}
