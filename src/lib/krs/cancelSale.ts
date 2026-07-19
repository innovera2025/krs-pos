// NODE-ONLY. KRS VOID write module (krs-void-writeback). Cancels a previously-synced
// cash sale via the vendor-confirmed 4-UPDATE soft-close pattern (19-07-26, verbatim —
// see krs-void-writeback_PLAN_19-07-26.md header). Imported ONLY by the dispatcher.
// NEVER import from a client component, `src/auth.config.ts`, or `src/middleware.ts`
// (it pulls in the `mssql` driver).
//
// THE 4 UPDATES (vendor-confirmed, verbatim):
//   UPDATE dbo.SalesInvoiceHdr  SET IsClosed = 1                         WHERE VoucherNo = @sc;
//   UPDATE dbo.SalePurchaseTax  SET IsClosed = 0                         WHERE VoucherNo = @sc;  -- asymmetric, vendor-confirm pending
//   UPDATE dbo.TheJournal       SET IsClosed = 1                         WHERE VoucherNo = @sc;  -- 3 rows expected
//   UPDATE dbo.InventoryFlowHdr SET IsClosed = 1, IsClosedBy = @by, IsClosedDate = GETDATE() WHERE VoucherNo = @osl;
// @sc = the sale's SC-{YYMM}-{NNNN} voucher (SalesInvoiceHdr/TheJournal/SalePurchaseTax
// VoucherNo). @osl = the sale's OSL-{YYMM}-{NNNN} InventoryFlow voucher.
//
// DOCUMENT RESOLUTION: PosBillNo lookup against SalesInvoiceHdr/InventoryFlowHdr is
// PRIMARY (works for any bill sold after the 16/17-07-26 PosBillNo columns landed:
// writeback.ts:633,767). payload.saleRef is the FALLBACK for a pre-16-07 bill with no
// PosBillNo in KRS. If NEITHER resolves both VoucherNo values, this throws a
// KrsWriteError (an operator/manual case, never a silent no-op). The pure decision
// logic lives in cancelSaleResolve.ts (unit-tested there).
//
// IDEMPOTENCY: unlike writeKrsSale, this needs NO burned anchor and NO reclaim check.
// All 4 UPDATEs are naturally idempotent — re-running the WHOLE thing against an
// already-IsClosed=1/0 row is a harmless no-op UPDATE (it matches the same row and sets
// the same value), not a duplicate INSERT. A crash mid-tx just rolls back; the next
// dispatch attempt re-resolves the documents and re-runs cleanly. No NEEDS_RECONCILE
// routing is needed for VOID (see plan Invariants #1/#3).
//
// STRICT vs WARN: SalesInvoiceHdr (must hit >=1 row) and InventoryFlowHdr (must hit
// >=1 row) are the two documents that actually gate "is this bill closed / is the
// stock reopened" — a miss there throws and rolls back ALL 4 updates (never leave KRS
// half-closed). TheJournal (expected 3) and SalePurchaseTax (expected 1) mismatches are
// WARN-only: logged + returned in the counts, never fatal (see plan Invariants).
//
// Plan: process/features/krs-sync/active/krs-void-writeback_PLAN_19-07-26.md §5

import sql from "mssql";
import { type VoidPayload } from "./voidPayload";
import { resolveCancelVouchers } from "./cancelSaleResolve";
import { safeErrorParts } from "./client";
import { KrsWriteError } from "./writeback";
import { logger } from "@/lib/logger";

/** PosBillNo is nvarchar(30) on the KRS side (writeback.ts:633) — match the lookup key
 *  width and truncate the orderNumber defensively (same as the SALE write). */
const POS_BILL_NO_MAX = 30;
/** Defensive cap for InventoryFlowHdr.IsClosedBy — the POS username should be short, but
 *  truncate so a runaway value never overflows the KRS column. */
const IS_CLOSED_BY_MAX = 100;

/** The result of a successful KRS cancel — stored in SyncJob.response for traceability.
 *  `journalRowsUpdated`/`taxRowsUpdated` are the WARN-only counts (not asserted). */
export type CancelSaleResult = {
  saleVoucherNo: string;
  flowVoucherNo: string;
  hdrRowsUpdated: number;
  flowRowsUpdated: number;
  journalRowsUpdated: number;
  taxRowsUpdated: number;
};

/**
 * Cancel one previously-synced POS cash sale in KRS via the vendor's 4-UPDATE
 * soft-close, inside ONE mssql transaction. Resolves the SC/OSL VoucherNos by PosBillNo
 * (primary) with the payload.saleRef fallback, then runs the 4 UPDATEs. Any failure
 * rolls back ALL 4 and throws a SANITIZED error.
 *
 * @param payload The VOID snapshot (validated by parseVoidPayload upstream).
 * @param config  The mssql config to write against — the dispatcher passes the SANDBOX config.
 * @returns the resolved vouchers + the per-table rowcounts.
 * @throws KrsWriteError — documents unresolvable, or a strict-table rowcount hit 0.
 * @throws Error — a SANITIZED transient driver/transaction failure (retryable).
 */
export async function cancelSaleInKrs(
  payload: VoidPayload,
  config: sql.config
): Promise<CancelSaleResult> {
  let pool: sql.ConnectionPool | null = null;
  let tx: sql.Transaction | null = null;
  let committed = false;
  try {
    pool = new sql.ConnectionPool(config);
    await pool.connect();

    const posBillNo = payload.orderNumber.slice(0, POS_BILL_NO_MAX);

    // === DOC RESOLUTION (PosBillNo lookup PRIMARY, saleRef FALLBACK) ===
    // ORDER BY TransactionNo DESC and take the newest; a PosBillNo mapping to more than
    // one document is not expected — log it (defensive) but proceed with the newest.
    const hdrLookup = await new sql.Request(pool)
      .input("ref", sql.NVarChar(POS_BILL_NO_MAX), posBillNo)
      .query<{ TransactionNo: string; VoucherNo: string }>(
        `SELECT TransactionNo, VoucherNo FROM dbo.SalesInvoiceHdr WHERE PosBillNo = @ref ORDER BY TransactionNo DESC;`
      );
    const flowLookup = await new sql.Request(pool)
      .input("ref", sql.NVarChar(POS_BILL_NO_MAX), posBillNo)
      .query<{ TransactionNo: string; VoucherNo: string }>(
        `SELECT TransactionNo, VoucherNo FROM dbo.InventoryFlowHdr WHERE PosBillNo = @ref ORDER BY TransactionNo DESC;`
      );

    if (hdrLookup.recordset.length > 1) {
      logger.warn(
        { krsCancel: { orderNumber: payload.orderNumber, table: "SalesInvoiceHdr", matched: hdrLookup.recordset.length } },
        "KRS cancel: multiple SalesInvoiceHdr rows for PosBillNo — using newest by TransactionNo"
      );
    }
    if (flowLookup.recordset.length > 1) {
      logger.warn(
        { krsCancel: { orderNumber: payload.orderNumber, table: "InventoryFlowHdr", matched: flowLookup.recordset.length } },
        "KRS cancel: multiple InventoryFlowHdr rows for PosBillNo — using newest by TransactionNo"
      );
    }

    const resolution = resolveCancelVouchers(
      hdrLookup.recordset[0]?.VoucherNo,
      flowLookup.recordset[0]?.VoucherNo,
      payload.saleRef,
      payload.orderNumber
    );
    if (!resolution.ok) {
      // Job FAILED with a clear error naming the bill (pre-16-07 bill with no PosBillNo
      // AND no saleRef fallback) — an operator/manual case, never a silent no-op.
      throw new KrsWriteError(resolution.reason);
    }
    const { saleVoucherNo, flowVoucherNo } = resolution;
    if (resolution.saleVoucherMismatch || resolution.flowVoucherMismatch) {
      logger.warn(
        {
          krsCancel: {
            orderNumber: payload.orderNumber,
            saleVoucherMismatch: resolution.saleVoucherMismatch,
            flowVoucherMismatch: resolution.flowVoucherMismatch,
          },
        },
        "KRS cancel: live PosBillNo lookup voucher disagrees with stored saleRef — live lookup wins"
      );
    }

    const closedBy = payload.requestedBy.slice(0, IS_CLOSED_BY_MAX);

    // === THE 4 UPDATES (one tx; READ COMMITTED — idempotent UPDATEs, no claim race) ===
    tx = new sql.Transaction(pool);
    await tx.begin();

    const hdrRes = await new sql.Request(tx)
      .input("sc", sql.NVarChar, saleVoucherNo)
      .query(`UPDATE dbo.SalesInvoiceHdr SET IsClosed = 1 WHERE VoucherNo = @sc;`);

    // Vendor-confirmed asymmetry (IsClosed = 0, NOT 1) — implemented verbatim; do not "fix".
    const taxRes = await new sql.Request(tx)
      .input("sc", sql.NVarChar, saleVoucherNo)
      .query(`UPDATE dbo.SalePurchaseTax SET IsClosed = 0 WHERE VoucherNo = @sc;`);

    const jnlRes = await new sql.Request(tx)
      .input("sc", sql.NVarChar, saleVoucherNo)
      .query(`UPDATE dbo.TheJournal SET IsClosed = 1 WHERE VoucherNo = @sc;`);

    const flowRes = await new sql.Request(tx)
      .input("osl", sql.NVarChar, flowVoucherNo)
      .input("by", sql.NVarChar(IS_CLOSED_BY_MAX), closedBy)
      .query(
        `UPDATE dbo.InventoryFlowHdr
            SET IsClosed = 1, IsClosedBy = @by, IsClosedDate = GETDATE()
          WHERE VoucherNo = @osl;`
      );

    const hdrRowsUpdated = hdrRes.rowsAffected[0] ?? 0;
    const flowRowsUpdated = flowRes.rowsAffected[0] ?? 0;
    const journalRowsUpdated = jnlRes.rowsAffected[0] ?? 0;
    const taxRowsUpdated = taxRes.rowsAffected[0] ?? 0;

    // STRICT: the two documents that gate "closed / stock reopened". A miss throws and
    // rolls back ALL 4 updates (never leave KRS half-closed).
    if (hdrRowsUpdated < 1) {
      throw new KrsWriteError(
        `SalesInvoiceHdr cancel matched 0 rows for VoucherNo=${saleVoucherNo} (expected >=1)`
      );
    }
    if (flowRowsUpdated < 1) {
      throw new KrsWriteError(
        `InventoryFlowHdr cancel matched 0 rows for VoucherNo=${flowVoucherNo} (expected >=1)`
      );
    }

    // WARN-only: TheJournal (expected 3) / SalePurchaseTax (expected 1). Logged + carried
    // in the returned counts (the dispatcher stores them in SyncJob.response); NEVER fatal.
    if (journalRowsUpdated !== 3) {
      logger.warn(
        { krsCancel: { orderNumber: payload.orderNumber, saleVoucherNo, journalRowsUpdated, expected: 3 } },
        "KRS cancel: TheJournal close hit an unexpected rowcount (expected 3) — proceeding"
      );
    }
    if (taxRowsUpdated !== 1) {
      logger.warn(
        { krsCancel: { orderNumber: payload.orderNumber, saleVoucherNo, taxRowsUpdated, expected: 1 } },
        "KRS cancel: SalePurchaseTax close hit an unexpected rowcount (expected 1) — proceeding"
      );
    }

    await tx.commit();
    committed = true;

    return {
      saleVoucherNo,
      flowVoucherNo,
      hdrRowsUpdated,
      flowRowsUpdated,
      journalRowsUpdated,
      taxRowsUpdated,
    };
  } catch (e) {
    if (tx && !committed) {
      try {
        await tx.rollback();
      } catch {
        /* secondary — the primary error is what matters */
      }
    }
    if (e instanceof KrsWriteError) throw e;
    const parts = safeErrorParts(e);
    throw new Error(`KRS cancel failed [${parts.code}]: ${parts.message}`);
  } finally {
    if (pool) {
      try {
        await pool.close();
      } catch {
        /* secondary — closing a never-fully-opened pool can throw */
      }
    }
  }
}
