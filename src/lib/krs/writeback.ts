// NODE-ONLY. KRS outbound cash-sale write module (krs-sync P2, Track B). Imported ONLY
// by the dispatcher (`dispatcher.ts`). NEVER import from a client component,
// `src/auth.config.ts`, or `src/middleware.ts` (it pulls in the `mssql` driver).
//
// WHAT THIS DOES (plan §9 + field-analysis §5–§7):
// One confirmed POS cash sale becomes ONE mssql transaction (BEGIN TRAN … COMMIT):
//   1. Atomic RunningNumber claims (race-safe UPDATE … OUTPUT; INSERT row=1 if missing)
//      for SaleInvoiceTrNo, SC{YYMM} voucher, InventoryFlow, OSL{YYMM} voucher, Receipt.
//   2. MainUnits lookup  (SELECT ItemCode, MainUnits FROM dbo.InventoryItem WHERE …).
//   3. GL account resolution (SELECT TOP 1 ACC_CODE … WHERE ACC_GRPNAME=@grp ORDER BY Roworder)
//      for Assets3 (cash), Revenues2 (revenue), Liabilities4 (output VAT).
//   4. INSERT dbo.SalesInvoiceHdr (1 row).
//   5. INSERT dbo.SalesInvoiceDtl (1 row per line).
//   6. INSERT dbo.TheJournal ×3 (D cash=total / C revenue=exVat(total-tax) / C VAT=tax),
//      asserting DR == CR BEFORE commit.
//   7. INSERT dbo.InventoryFlowHdr + dbo.InventoryFlowDtl (Approved=1, IsClosed=0, InOut=-1
//      so dbo.sp_Onhand counts the cut immediately).
//   8. INSERT dbo.SalePurchaseTax (1 row — the SaleVAT/output-VAT tax-log entry;
//      BillAmount = ex-VAT base, VATAmount = output VAT, mirroring SalesInvoiceHdr).
//   9. COMMIT; return the claimed doc numbers.
//
// INVARIANTS (all enforced below):
//   - ONE transaction: every insert + claim + lookup runs on `new sql.Request(tx)`.
//     ANY error → tx.rollback() and a SANITIZED throw (never the raw mssql/config/password).
//   - EVERYTHING parameterized: every value travels via `request.input(name, sql.Type, value)`.
//     NO sale/user value is ever string-interpolated into SQL. (The only interpolations are
//     fixed CONFIG constants used to BUILD the parameterized statements, never user data.)
//   - mssql ONLY: this module NEVER imports `@/lib/prisma` and is NEVER called inside a
//     Prisma `$transaction`. It opens its own pool on the caller-supplied `config` (the
//     dispatcher passes the SANDBOX config) and ALWAYS closes it in a `finally`. It NEVER
//     hardcodes or opens its own connection target.
//   - VAT-INCLUSIVE money: UnitPrice / Amount / Total are the gross POS amounts (the sample
//     proved 10×10 = 100 incl-VAT; UNIT_PRICE_INCL_VAT=true). All money binds as DECIMAL(18,2).
//
// IDEMPOTENCY (burned-anchor design, krs-writeback-idempotency_PLAN_27-06-26.md v3):
// SaleInvoiceTrNo is claimed in a SEPARATE COMMITTED phase-0 tx before the SERIALIZABLE
// phase-1 document tx opens. A phase-1 rollback cannot revert the phase-0 increment.
// checkKrsSaleExists(burnedNo) disambiguates committed vs rolled-back AT THE INSTANT the
// check runs — it is NOT a lock against a concurrently-alive writer committing the same
// TransactionNo after the check returns NOT FOUND. The UNIQUE constraint on
// KRS.SalesInvoiceHdr.TransactionNo (owner/DBA; hard pre-enable gate) is the ONLY server-
// side mechanism that forces such a late duplicate commit to fail. The dispatcher supplies
// opts.onSaleTxnNoBurned to persist the anchor after phase-0 commit (no mssql tx held).
// VoucherNo (SC-YYMM-NNNN, human/tax-facing) stays in-tx and gapless. SaleInvoiceTrNo
// may have rare gaps on crash paths — acceptable for this internal surrogate.
//
// Plan: process/features/krs-sync/active/krs-outbound-writeback_PLAN_25-06-26.md §9
// Field map: process/features/krs-sync/references/krs-writeback-field-analysis_24-06-26.md §5–§7

import sql from "mssql";
import type { SalePayload } from "./salePayload";
import { safeErrorParts } from "./client";
import {
  KRS_WRITE_CONFIG,
  assertWriteConfigReady,
  WriteConfigNotReadyError,
} from "./writebackConfig";

/** The result of a successful KRS write (stored in SyncJob.response). */
export type KrsWriteResult = {
  /** The generated KRS document/transaction number for the sale (SalesInvoiceHdr). */
  transactionNo: string;
  /** The generated journal voucher number (SC-{YYMM}-{NNNN}) — TheJournal. */
  journalNo: string;
  /** The SalesInvoice voucher number (SC-{YYMM}-{NNNN}). */
  saleVoucherNo: string;
  /** The InventoryFlow transaction number. */
  flowTxnNo: string;
  /** The InventoryFlow voucher number (OSL-{YYMM}-{NNNN}). */
  flowVoucherNo: string;
  /** The Receipt running-number claim used as TheJournal.JnlCode. */
  jnlCode: string;
};

/**
 * Options for writeKrsSale. All fields optional. Omitting opts entirely (two-arg call)
 * still burns a fresh SaleInvoiceTrNo anchor in the separate phase-0 committed tx — it
 * just fires no persist callback and does no reuse. Only preClaimedSaleTxnNo skips the
 * burn; omitting onSaleTxnNoBurned means the burned number is never persisted to Postgres
 * (suitable for ad-hoc testing; the dispatcher always supplies it).
 */
export type KrsWriteOpts = {
  /**
   * A SaleInvoiceTrNo already burned (committed in its own phase-0 short tx) by a
   * prior attempt. When supplied, writeKrsSale SKIPS phase 0 (no new burn) and uses
   * this value as SalesInvoiceHdr.TransactionNo in the phase-1 document tx. Must be
   * byte-identical to the value stored in SyncJob.krsClaimedTxnNo. Do NOT supply a
   * new value each retry — that inflates gaps in the internal SaleInvoiceTrNo sequence.
   */
  preClaimedSaleTxnNo?: string;
  /**
   * Called AFTER the phase-0 burn-commit and BEFORE the phase-1 SERIALIZABLE tx opens.
   * No mssql tx is held open during this callback. The dispatcher uses this to persist
   * the burned number to Postgres (SyncJob.krsClaimedTxnNo) so a crash in phase 1 is
   * detectable on reclaim. A throw aborts before any document INSERT is attempted.
   * Also fires on the reuse path (preClaimedSaleTxnNo supplied) with the same value —
   * idempotent re-persist.
   */
  onSaleTxnNoBurned?: (txnNo: string) => Promise<void>;
};

/**
 * Thrown when the write cannot proceed because of a non-transient configuration gap
 * (vendor constants still TODO_FROM_VENDOR). The dispatcher treats this as a
 * "leave pending" outcome (does NOT count a failed attempt, does NOT insert anything).
 * Re-exported so the dispatcher can distinguish it from a transient driver failure.
 */
export { WriteConfigNotReadyError };

/**
 * Thrown when the KRS write detects a data problem that must NOT be retried as-is and
 * must NOT silently corrupt the ERP — e.g. the GL chart of accounts is missing a
 * required account group, or the double-entry journal does not balance. Carries a
 * sanitized message only (never an ERP value beyond the safe identifier it names).
 */
export class KrsWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KrsWriteError";
  }
}

// ───────────────────────────── pure helpers (no I/O — unit-testable) ─────────────────────────────

/** Parse a 2dp Decimal string ("1234.50") into integer satang (123450). Throws on a
 *  non-numeric / non-finite value so a malformed money field never reaches the ERP.
 *  Pure: no I/O. Used for the double-entry balance assertion (integer math — no float). */
export function toSatang(decimalStr: string): number {
  // Accept an optional sign, digits, and up to 2 decimal places. Reject anything else.
  if (!/^-?\d+(\.\d{1,2})?$/.test(decimalStr.trim())) {
    throw new KrsWriteError(`Invalid money value "${decimalStr}"`);
  }
  const [intPart, fracPartRaw = ""] = decimalStr.trim().replace(/^-/, "").split(".");
  const fracPart = (fracPartRaw + "00").slice(0, 2);
  const magnitude = Number(intPart) * 100 + Number(fracPart);
  if (!Number.isFinite(magnitude)) {
    throw new KrsWriteError(`Non-finite money value "${decimalStr}"`);
  }
  return decimalStr.trim().startsWith("-") ? -magnitude : magnitude;
}

/** Derive the KRS {YYMM} token from an ISO-8601 sale instant, in the Asia/Bangkok
 *  zone (the sample "2606" = 2026-06). Pure: no I/O. The token keys the per-month
 *  voucher running-numbers (SC{YYMM} / OSL{YYMM}) and the formatted voucher numbers.
 *  Throws on an unparseable date so a bad snapshot never produces a wrong-period doc. */
export function deriveYYMM(isoDate: string): string {
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) {
    throw new KrsWriteError(`Invalid sale date "${isoDate}"`);
  }
  // Asia/Bangkok is UTC+7 with no DST — a fixed offset is exact and dependency-free.
  const bkk = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  const yy = String(bkk.getUTCFullYear()).slice(-2);
  const mm = String(bkk.getUTCMonth() + 1).padStart(2, "0");
  return `${yy}${mm}`;
}

/** Format a voucher number "{PREFIX}-{YYMM}-{NNNN}" (4-digit zero-padded), e.g.
 *  "SC-2606-0001" / "OSL-2606-0042". Pure: no I/O. The numeric part is the claimed
 *  per-month running number. Throws if the claimed number does not fit 4 digits
 *  (>= 10000) so a silently-truncated voucher number never reaches the ERP. */
export function formatVoucherNo(prefix: string, yymm: string, n: number): string {
  if (!Number.isInteger(n) || n <= 0) {
    throw new KrsWriteError(`Invalid voucher sequence ${n}`);
  }
  if (n > 9999) {
    throw new KrsWriteError(`Voucher sequence ${n} exceeds 4 digits for ${prefix}-${yymm}`);
  }
  return `${prefix}-${yymm}-${String(n).padStart(4, "0")}`;
}

/** The sale's Asia/Bangkok CALENDAR DATE as a date-only JS Date (UTC-midnight of that
 *  calendar day) for the KRS document-date columns (VoucherDate / DueDate / JnlDate /
 *  ApprovedDate / InOutDate). Bound via sql.Date so KRS receives a pure DATE with no
 *  time (the columns are datetime but treated as document dates). Asia/Bangkok (UTC+7,
 *  no DST — a fixed offset is exact and dependency-free) matches deriveYYMM, so a
 *  late-evening sale lands on the correct business day instead of slipping to the UTC
 *  date. Throws on an unparseable value. Pure: no I/O. */
function toBangkokDate(isoDate: string): Date {
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) {
    throw new KrsWriteError(`Invalid sale date "${isoDate}"`);
  }
  const bkk = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  return new Date(Date.UTC(bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate()));
}

/** Bind a 2dp money string as DECIMAL(18,2). mssql accepts a JS number for a DECIMAL
 *  param; we validate the string via toSatang first (rejecting garbage) then divide
 *  back to a 2dp number for the driver. The validation is the gate — toSatang throws
 *  on anything that is not a clean 2dp decimal, so no malformed money is ever bound. */
function money(value: string): number {
  return toSatang(value) / 100;
}

// ───────────────────────────── running-number claim ─────────────────────────────

/**
 * Atomically claim the next value for a RunningNumber key, race-safe via a single
 * `UPDATE … SET Number = Number + 1 OUTPUT inserted.Number WHERE Name = @name`
 * statement (SQL Server returns the post-increment value atomically — no MAX()+1
 * read-then-write race). When the key does not exist yet, INSERT it at 1 and return 1.
 *
 * Runs on the SHARED transaction request set (`new sql.Request(tx)`), so the claim is
 * part of the one sale transaction: a later rollback un-claims every number too. The
 * `@name` key is a BOUND parameter (NVarChar) — never interpolated.
 *
 * @param tx   The open mssql transaction.
 * @param name The RunningNumber.Name key (a CONFIG constant or "{PREFIX}{YYMM}").
 * @returns the claimed integer.
 */
async function claimRunningNumber(tx: sql.Transaction, name: string): Promise<number> {
  // (1) Try the atomic increment; OUTPUT the new value. 0 rows ⇒ the key is new.
  const updated = await new sql.Request(tx)
    .input("name", sql.NVarChar, name)
    .query<{ Number: number }>(
      `UPDATE dbo.RunningNumber WITH (UPDLOCK, ROWLOCK)
          SET Number = Number + 1
       OUTPUT inserted.Number AS Number
        WHERE Name = @name;`
    );
  const row = updated.recordset[0];
  if (row && typeof row.Number === "number") {
    return row.Number;
  }

  // (2) Key absent → seed it at 1 and return 1. Still inside the same transaction so a
  // concurrent first-use of the same key serializes on the row lock / PK.
  await new sql.Request(tx)
    .input("name", sql.NVarChar, name)
    .query(`INSERT INTO dbo.RunningNumber (Name, Number) VALUES (@name, 1);`);
  return 1;
}

// ─── existence check (own pool, NOT in the sale tx — called by dispatcher on reclaim) ──

/**
 * Read-only existence check: returns true when a SalesInvoiceHdr row with the given
 * TransactionNo is present in KRS AT THE INSTANT THE CHECK RUNS. Called ONLY by the
 * dispatcher on a reclaimed job that holds a non-null krsClaimedTxnNo (a previously
 * burned anchor), to determine whether the phase-1 document tx committed or rolled back.
 *
 * CONCURRENCY NOTE: this is NOT a lock. An alive-but-slow dispatcher A can commit the
 * same TransactionNo AFTER this function returns false (not found). The defense against
 * that race is a UNIQUE constraint on KRS.SalesInvoiceHdr.TransactionNo (owner/DBA
 * action; hard pre-enable gate — see plan Residual §5).
 *
 * Uses a THROWAWAY POOL (open → SELECT → close in finally) on the caller-supplied
 * config — NOT inside any sale tx and NOT sharing the in-tx pool.
 *
 * TransactionNo is bound as NVarChar (@txnNo) — never interpolated. Sargable when
 * SalesInvoiceHdr.TransactionNo is NVarChar (confirm at first sandbox run). A timed-out
 * check (REQUEST_TIMEOUT_MS=20_000, sandboxClient.ts:29) is a SAFE retry — it does not
 * bypass or alter KRS state.
 *
 * Errors are sanitized (never the raw mssql driver object or config).
 * Pure SELECT: this function NEVER modifies KRS state.
 */
export async function checkKrsSaleExists(
  saleTxnNo: string,
  config: sql.config
): Promise<boolean> {
  let pool: sql.ConnectionPool | null = null;
  try {
    pool = new sql.ConnectionPool(config);
    await pool.connect();
    const res = await new sql.Request(pool)
      .input("txnNo", sql.NVarChar, saleTxnNo)
      .query<{ Found: number }>(
        `SELECT TOP 1 1 AS Found FROM dbo.SalesInvoiceHdr WHERE TransactionNo = @txnNo;`
      );
    return res.recordset.length > 0;
  } catch (e) {
    const parts = safeErrorParts(e);
    throw new Error(`KRS existence check failed [${parts.code}]: ${parts.message}`);
  } finally {
    if (pool) {
      try { await pool.close(); } catch { /* secondary — result already determined */ }
    }
  }
}

// ───────────────────────────── lookups (read, inside the tx) ─────────────────────────────

/** Resolve a GL account code by AccountHead group name (cash / revenue / VAT), taking
 *  the first by Roworder — `SELECT TOP 1 ACC_CODE FROM dbo.AccountHead WHERE
 *  ACC_GRPNAME = @grp ORDER BY Roworder`. The group name is a BOUND parameter. Throws
 *  `KrsWriteError` if the group has no account (a chart-of-accounts config gap — a data
 *  problem, never silently written as blank). */
async function resolveAccountCode(tx: sql.Transaction, group: string): Promise<string> {
  const res = await new sql.Request(tx)
    .input("grp", sql.NVarChar, group)
    .query<{ ACC_CODE: string }>(
      `SELECT TOP 1 ACC_CODE FROM dbo.AccountHead
        WHERE ACC_GRPNAME = @grp
        ORDER BY Roworder;`
    );
  const code = res.recordset[0]?.ACC_CODE;
  if (typeof code !== "string" || code.length === 0) {
    throw new KrsWriteError(`No AccountHead account for group "${group}"`);
  }
  return code;
}

/** Look up MainUnits for the order's distinct ItemCodes in ONE parameterized
 *  `SELECT ItemCode, MainUnits FROM dbo.InventoryItem WHERE ItemCode IN (…)`. Each
 *  ItemCode is bound as its own NVarChar parameter (@i0, @i1, …) — the IN list is built
 *  from PARAMETER NAMES only, never the values. Returns a Map(itemCode → MainUnits);
 *  an item not found in KRS maps to "" (the write proceeds with a blank unit rather
 *  than failing the whole sale on a missing unit). */
async function lookupMainUnits(
  tx: sql.Transaction,
  itemCodes: string[]
): Promise<Map<string, string>> {
  const distinct = Array.from(new Set(itemCodes));
  const map = new Map<string, string>();
  if (distinct.length === 0) return map;

  // MAIN_UNITS_SOURCE is interpolated as a column IDENTIFIER (not a bound param — column
  // names cannot be parameterized). It is a fixed CONFIG constant today, so this guard is
  // impossible-by-construction insurance: refuse anything that is not a plain SQL
  // identifier rather than ever interpolating an unsafe value into the statement.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(KRS_WRITE_CONFIG.MAIN_UNITS_SOURCE)) {
    throw new KrsWriteError(
      `Invalid MAIN_UNITS_SOURCE identifier "${KRS_WRITE_CONFIG.MAIN_UNITS_SOURCE}"`
    );
  }

  const req = new sql.Request(tx);
  const placeholders: string[] = [];
  distinct.forEach((code, i) => {
    const p = `i${i}`;
    req.input(p, sql.NVarChar, code);
    placeholders.push(`@${p}`);
  });
  const res = await req.query<{ ItemCode: string; MainUnits: string | null }>(
    `SELECT ItemCode, ${KRS_WRITE_CONFIG.MAIN_UNITS_SOURCE} AS MainUnits
       FROM dbo.InventoryItem
      WHERE ItemCode IN (${placeholders.join(", ")});`
  );
  for (const r of res.recordset) {
    map.set(r.ItemCode, typeof r.MainUnits === "string" ? r.MainUnits : "");
  }
  return map;
}

// ───────────────────────────── the write ─────────────────────────────

/**
 * Write one POS cash sale to KRS in a single mssql transaction.
 *
 * Performs the full sequence (RunningNumber claims → MainUnits lookup → GL account
 * resolution → SalesInvoiceHdr → SalesInvoiceDtl ×N → TheJournal ×3 with a DR==CR
 * assertion → InventoryFlowHdr → InventoryFlowDtl ×N) inside ONE BEGIN/COMMIT. Any
 * failure rolls back ALL of it and throws a SANITIZED error.
 *
 * @param payload The SALE snapshot (validated by parseSalePayload upstream).
 * @param config  The mssql config to write against — the dispatcher passes the SANDBOX
 *                config. This module NEVER hardcodes or opens its own target.
 * @returns the claimed KRS document numbers.
 * @throws WriteConfigNotReadyError — a vendor constant is still TODO_FROM_VENDOR (leave pending).
 * @throws KrsWriteError — a data/config problem (missing GL account, journal imbalance, bad money).
 * @throws Error — a SANITIZED transient driver/transaction failure (retryable).
 */
export async function writeKrsSale(
  payload: SalePayload,
  config: sql.config,
  opts?: KrsWriteOpts
): Promise<KrsWriteResult> {
  // (1) Refuse if any vendor constant is still a TODO placeholder — never guess. This
  // runs BEFORE any connection is opened or any number is claimed.
  assertWriteConfigReady(KRS_WRITE_CONFIG);

  const cfg = KRS_WRITE_CONFIG;

  // (2) Snapshot balance gate (integer satang — no float). Asserted up-front so a
  // malformed/unbalanced snapshot is rejected before opening a connection. The POS is
  // VAT-INCLUSIVE: subtotal = gross line totals (incl VAT, before the bill discount);
  // total = subtotal − discount (both incl VAT); tax is EXTRACTED from total
  // (round(total × 7/107)). So the snapshot identity is total == subtotal − discount,
  // NOT total == subtotal + tax. The ex-VAT base = total − tax is what KRS records as
  // SubTotalAmnt / VATForValue and as the revenue journal line.
  const totalSatang = toSatang(payload.total);
  const subtotalSatang = toSatang(payload.subtotal);
  const taxSatang = toSatang(payload.tax);
  const discountSatang = toSatang(payload.discount);
  if (totalSatang !== subtotalSatang - discountSatang) {
    throw new KrsWriteError(
      `Snapshot imbalance: total ${payload.total} != subtotal ${payload.subtotal} - discount ${payload.discount}`
    );
  }
  // Ex-VAT base = what KRS calls SubTotalAmnt / VATForValue (vendor sample: Total=100, SubTotalAmnt=93.46=total-tax).
  const exVatSatang = totalSatang - taxSatang;
  // Defense-in-depth before any live ERP post: revenue (ex-VAT) and VAT must be non-negative.
  // Unreachable from the current VAT-inclusive checkout (tax = round(total×7/107) ≤ total), but a
  // corrupt/legacy snapshot with tax > total would otherwise post a negative revenue journal line.
  if (taxSatang < 0 || exVatSatang < 0) {
    throw new KrsWriteError(
      `Invalid VAT split: tax ${payload.tax} exceeds total ${payload.total} (ex-VAT base < 0)`
    );
  }

  // (3) Derive the per-month tokens and the date columns (pure — no I/O).
  const yymm = deriveYYMM(payload.createdAt);
  const saleDate = toBangkokDate(payload.createdAt);

  let pool: sql.ConnectionPool | null = null;
  let burnTx: sql.Transaction | null = null;   // phase-0 short tx (READ COMMITTED)
  let burnCommitted = false;
  let tx: sql.Transaction | null = null;        // phase-1 document tx (SERIALIZABLE)
  let committed = false;
  try {
    pool = new sql.ConnectionPool(config);
    await pool.connect();

    // ── Phase 0: Burn the SaleInvoiceTrNo anchor ──────────────────────────────
    // A SEPARATE, IMMEDIATELY-COMMITTED tx (READ COMMITTED — sufficient for a
    // single-row counter UPDATE). Once committed, the increment is permanent: a later
    // rollback of the phase-1 SERIALIZABLE doc tx cannot revert it.
    //
    // SAFETY SCOPE: the burned anchor disambiguates committed vs rolled-back AT THE
    // INSTANT checkKrsSaleExists runs. It does NOT prevent an alive-but-slow concurrent
    // writer from committing the same TransactionNo after the existence check returns NOT
    // FOUND. The UNIQUE constraint on KRS.SalesInvoiceHdr.TransactionNo (hard pre-enable
    // gate, see Residual §5) is the only server-side protection against that race.
    //
    // REUSE PATH (preClaimedSaleTxnNo supplied): a prior attempt already burned this
    // number. Skip phase 0 and reuse it — do NOT burn a new one (inflates gaps).
    let saleTxnNo: string;
    if (opts?.preClaimedSaleTxnNo != null) {
      saleTxnNo = opts.preClaimedSaleTxnNo;
    } else {
      burnTx = new sql.Transaction(pool);
      await burnTx.begin();   // READ COMMITTED — sufficient for a counter UPDATE
      const saleTxnSeq = await claimRunningNumber(burnTx, cfg.RUNNING_NUMBER_NAME_INVOICE);
      await burnTx.commit();
      burnCommitted = true;
      saleTxnNo = String(saleTxnSeq);
    }

    // ── Phase 0b: Persist the burned anchor to Postgres ───────────────────────
    // Fires AFTER burn-commit, BEFORE the phase-1 SERIALIZABLE tx opens.
    // NO mssql tx is held open during this Postgres write.
    await opts?.onSaleTxnNoBurned?.(saleTxnNo);

    // ── Phase 1: SERIALIZABLE document tx ─────────────────────────────────────
    // Claims the remaining 4 running numbers + all INSERTs in one atomic tx.
    // A rollback releases these 4 in-tx claims (human-facing VoucherNo stays gapless).
    // SaleInvoiceTrNo is NOT claimed here — it came from the burned phase-0 anchor.
    tx = new sql.Transaction(pool);
    await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

    // ── Step 1: atomic RunningNumber claims (4 in-tx counters only) ───────────
    const saleVoucherSeq = await claimRunningNumber(
      tx,
      `${cfg.RUNNING_NUMBER_VOUCHER_PREFIX}${yymm}`
    );
    const flowTxnSeq  = await claimRunningNumber(tx, cfg.RUNNING_NUMBER_NAME_INVFLOW);
    const flowVoucherSeq = await claimRunningNumber(
      tx,
      `${cfg.INV_VOUCHER_PREFIX}${yymm}`
    );
    const jnlSeq = await claimRunningNumber(tx, cfg.RUNNING_NUMBER_NAME_RECEIPT);

    // saleTxnNo is the burned phase-0 anchor (set above). DO NOT re-declare it here.
    const flowTxnNo    = String(flowTxnSeq);
    const jnlCode      = String(jnlSeq);
    const saleVoucherNo = formatVoucherNo(
      cfg.RUNNING_NUMBER_VOUCHER_PREFIX,
      yymm,
      saleVoucherSeq
    );
    const flowVoucherNo = formatVoucherNo(cfg.INV_VOUCHER_PREFIX, yymm, flowVoucherSeq);

    // ── Step 2: MainUnits lookup (one query for the whole order) ──
    const unitsMap = await lookupMainUnits(
      tx,
      payload.items.map((it) => it.itemCode)
    );

    // ── Step 3: GL account resolution (cash / revenue / VAT) ──
    const cashAccount = await resolveAccountCode(tx, cfg.ACCOUNT_HEAD_CASH_GROUP);
    const revenueAccount = await resolveAccountCode(tx, cfg.ACCOUNT_HEAD_REVENUE_GROUP);
    const vatAccount = await resolveAccountCode(tx, cfg.ACCOUNT_HEAD_VAT_GROUP);

    // ── Step 4: INSERT SalesInvoiceHdr (confirmed insert column subset, §6) ──
    const custCode = payload.customerCode ?? cfg.WALK_IN_CUST_CODE;
    const custName = payload.customerName ?? cfg.WALK_IN_CUST_NAME;
    const custAddress = payload.customerAddress ?? "";
    await new sql.Request(tx)
      .input("TransactionNo", sql.NVarChar, saleTxnNo)
      .input("InvoiceType", sql.NVarChar, cfg.INVOICE_TYPE)
      .input("SaleType", sql.NVarChar, cfg.SALE_TYPE)
      .input("ItemType", sql.NVarChar, cfg.ITEM_TYPE)
      .input("TransactionTypeI", sql.Int, cfg.TRANSACTION_TYPE_I)
      .input("TransactionTypeT", sql.Int, cfg.TRANSACTION_TYPE_T)
      .input("CompanyCode", sql.NVarChar, cfg.COMPANY_CODE)
      .input("VoucherNo", sql.NVarChar, saleVoucherNo)
      .input("VoucherDate", sql.Date, saleDate)
      .input("DocuType", sql.NVarChar, cfg.DOCU_TYPE)
      .input("CustOrSuppCode", sql.NVarChar, custCode)
      .input("CustOrSuppName", sql.NVarChar, custName)
      .input("Address", sql.NVarChar, custAddress)
      .input("DeliveryAddress", sql.NVarChar, custAddress)
      .input("DueDate", sql.Date, saleDate)
      .input("IsVAT", sql.Int, cfg.IS_VAT)
      .input("IsClosed", sql.Int, cfg.IS_CLOSED)
      .input("IsPaid", sql.Int, cfg.IS_PAID)
      .input("Currency", sql.NVarChar, cfg.JOURNAL_CURRENCY)
      .input("ExchangeRate", sql.Decimal(18, 6), 1)
      .input("AccountsDescription", sql.NVarChar, cfg.ACCOUNTS_DESCRIPTION)
      .input("TotalAmount", sql.Decimal(18, 2), money(payload.total))
      .input("SubTotalAmnt", sql.Decimal(18, 2), exVatSatang / 100)
      .input("DepositAmount", sql.Decimal(18, 2), 0)
      .input("VATForValue", sql.Decimal(18, 2), exVatSatang / 100)
      .input("VATPercent", sql.Decimal(18, 2), cfg.VAT_PERCENT)
      .input("VATAmount", sql.Decimal(18, 2), money(payload.tax))
      .input("AmountDue", sql.Decimal(18, 2), money(payload.total))
      .input("AmountDueBht", sql.Decimal(18, 2), money(payload.total))
      .input("TotalDR", sql.Decimal(18, 2), money(payload.total))
      .input("CashValue", sql.Decimal(18, 2), money(payload.total))
      .input("TotalCR", sql.Decimal(18, 2), money(payload.total))
      .input("BranchCode", sql.NVarChar, payload.branchCode)
      .input("BranchName", sql.NVarChar, payload.branchName)
      .input("EntryBy", sql.NVarChar, payload.cashierName)
      .query(
        `INSERT INTO dbo.SalesInvoiceHdr
           (TransactionNo, InvoiceType, SaleType, ItemType, TransactionTypeI, TransactionTypeT,
            CompanyCode, VoucherNo, VoucherDate, DocuType, CustOrSuppCode, CustOrSuppName,
            Address, DeliveryAddress, DueDate, IsVAT, IsClosed, IsPaid, Currency, ExchangeRate,
            AccountsDescription, TotalAmount, SubTotalAmnt, DepositAmount, VATForValue, VATPercent,
            VATAmount, AmountDue, AmountDueBht, TotalDR, CashValue, TotalCR, BranchCode, BranchName,
            EntryBy, EntryDate)
         VALUES
           (@TransactionNo, @InvoiceType, @SaleType, @ItemType, @TransactionTypeI, @TransactionTypeT,
            @CompanyCode, @VoucherNo, @VoucherDate, @DocuType, @CustOrSuppCode, @CustOrSuppName,
            @Address, @DeliveryAddress, @DueDate, @IsVAT, @IsClosed, @IsPaid, @Currency, @ExchangeRate,
            @AccountsDescription, @TotalAmount, @SubTotalAmnt, @DepositAmount, @VATForValue, @VATPercent,
            @VATAmount, @AmountDue, @AmountDueBht, @TotalDR, @CashValue, @TotalCR, @BranchCode, @BranchName,
            @EntryBy, GETDATE());`
      );

    // ── Step 5: INSERT SalesInvoiceDtl (1 row per line, §6 column subset) ──
    for (let i = 0; i < payload.items.length; i++) {
      const item = payload.items[i];
      const mainUnits = unitsMap.get(item.itemCode) ?? "";
      await new sql.Request(tx)
        .input("TransactionNo", sql.NVarChar, saleTxnNo)
        .input("ItemOrder", sql.Int, i + 1)
        .input("ItemCode", sql.NVarChar, item.itemCode)
        .input("Description", sql.NVarChar, item.description)
        .input("MainQuantity", sql.Decimal(18, 2), item.quantity)
        .input("MainUnits", sql.NVarChar, mainUnits)
        .input("AccountCode", sql.NVarChar, cfg.DTL_ACCOUNT_CODE)
        .input("Currency", sql.NVarChar, cfg.JOURNAL_CURRENCY)
        .input("UnitPrice", sql.Decimal(18, 2), money(item.unitPrice))
        // TODO(line-discount): payload.items[].lineDiscount IS captured in the snapshot but
        // posted as 0 here (current cash-sale-no-per-line-discount assumption). Wire it
        // into DiscountPercent/DiscountAmount before enabling discounted sales.
        .input("DiscountPercent", sql.Decimal(18, 2), 0)
        .input("DiscountAmount", sql.Decimal(18, 2), 0)
        .input("Amount", sql.Decimal(18, 2), money(item.lineTotal))
        .query(
          `INSERT INTO dbo.SalesInvoiceDtl
             (TransactionNo, ItemOrder, ItemCode, Description, MainQuantity, MainUnits,
              AccountCode, Currency, UnitPrice, DiscountPercent, DiscountAmount, Amount)
           VALUES
             (@TransactionNo, @ItemOrder, @ItemCode, @Description, @MainQuantity, @MainUnits,
              @AccountCode, @Currency, @UnitPrice, @DiscountPercent, @DiscountAmount, @Amount);`
        );
    }

    // ── Step 6: INSERT TheJournal ×3 (D cash=total / C revenue=exVat(total−tax) / C VAT=tax) ──
    // The snapshot balance was asserted up-front (totalSatang == subtotal − discount).
    // We re-assert the DR/CR split here as the final gate immediately before posting
    // (tautologically true since exVat = total − tax, so exVat + tax == total).
    const drSatang = totalSatang;
    const crSatang = exVatSatang + taxSatang;
    if (drSatang !== crSatang) {
      throw new KrsWriteError(
        `Journal imbalance before post: DR ${payload.total} != CR exVat(${(exVatSatang / 100).toFixed(2)})+tax(${payload.tax})`
      );
    }
    const exVatStr = (exVatSatang / 100).toFixed(2);
    const journalRows: Array<{ drcr: "D" | "C"; account: string; amount: string }> = [
      { drcr: "D", account: cashAccount, amount: payload.total },
      { drcr: "C", account: revenueAccount, amount: exVatStr },
      { drcr: "C", account: vatAccount, amount: payload.tax },
    ];
    for (const jr of journalRows) {
      await new sql.Request(tx)
        .input("JnlName", sql.NVarChar, cfg.JOURNAL_JNL_NAME)
        .input("JnlCode", sql.NVarChar, jnlCode)
        .input("TransactionTypeI", sql.Int, cfg.JOURNAL_TRANSACTION_TYPE_I)
        .input("TransactionTypeT", sql.Int, cfg.JOURNAL_TRANSACTION_TYPE_T)
        .input("CompanyCode", sql.NVarChar, cfg.COMPANY_CODE)
        .input("Department", sql.NVarChar, cfg.JOURNAL_DEPARTMENT)
        .input("GLAccount", sql.NVarChar, jr.account)
        .input("JnlDate", sql.Date, saleDate)
        .input("Description", sql.NVarChar, cfg.JOURNAL_DESCRIPTION)
        .input("DrCr", sql.NVarChar, jr.drcr)
        .input("Currency", sql.NVarChar, cfg.JOURNAL_CURRENCY)
        .input("Amount", sql.Decimal(18, 2), money(jr.amount))
        .input("AmountBht", sql.Decimal(18, 2), money(jr.amount))
        .input("SourceType", sql.NVarChar, cfg.JOURNAL_SOURCE_TYPE)
        .input("SourceNo", sql.NVarChar, saleTxnNo)
        .input("VoucherNo", sql.NVarChar, saleVoucherNo)
        .input("JournalNo", sql.NVarChar, saleVoucherNo)
        .input("ActualInvoiceNo", sql.NVarChar, saleVoucherNo)
        // Branch/Warehouse Phase 4: TheJournal scopes to the cashier's branch (from the
        // snapshot), not the fixed cfg.JOURNAL_BRANCH_CODE/NAME. The payload defaults to
        // HQ ("00000"/"สำนักงานใหญ่") for an unassigned cashier, matching the old constants.
        .input("BranchCode", sql.NVarChar, payload.branchCode)
        .input("BranchName", sql.NVarChar, payload.branchName)
        .query(
          `INSERT INTO dbo.TheJournal
             (JnlName, JnlCode, TransactionTypeI, TransactionTypeT, CompanyCode, Department,
              GLAccount, JnlDate, Description, DrCr, Currency, Amount, AmountBht, SourceType,
              SourceNo, VoucherNo, JournalNo, ActualInvoiceNo, BranchCode, BranchName)
           VALUES
             (@JnlName, @JnlCode, @TransactionTypeI, @TransactionTypeT, @CompanyCode, @Department,
              @GLAccount, @JnlDate, @Description, @DrCr, @Currency, @Amount, @AmountBht, @SourceType,
              @SourceNo, @VoucherNo, @JournalNo, @ActualInvoiceNo, @BranchCode, @BranchName);`
        );
    }

    // ── Step 7a: INSERT InventoryFlowHdr (confirmed insert column subset, §7) ──
    await new sql.Request(tx)
      .input("TransactionNo", sql.NVarChar, flowTxnNo)
      .input("IsStock", sql.Int, cfg.INV_IS_STOCK)
      .input("TransactionType", sql.Int, cfg.INV_TRANSACTION_TYPE)
      .input("Approved", sql.Int, cfg.INV_APPROVED)
      .input("ApprovedBy", sql.NVarChar, payload.cashierName)
      .input("ApprovedDate", sql.Date, saleDate)
      .input("IsAssetForm", sql.Int, cfg.INV_IS_ASSET_FORM)
      .input("IsClosed", sql.Int, cfg.INV_IS_CLOSED)
      .input("InOutDate", sql.Date, saleDate)
      .input("InOut", sql.Int, cfg.IN_OUT)
      .input("ReasonIndex", sql.Int, cfg.INV_REASON_INDEX)
      .input("ReasonName", sql.NVarChar, cfg.INV_REASON_NAME)
      .input("CompanyCode", sql.NVarChar, cfg.COMPANY_CODE)
      .input("DeptCode", sql.NVarChar, cfg.INV_DEPT_CODE)
      .input("Department", sql.NVarChar, cfg.INV_DEPARTMENT_NAME)
      .input("VoucherNo", sql.NVarChar, flowVoucherNo)
      .input("EntryBy", sql.NVarChar, payload.cashierName)
      .query(
        `INSERT INTO dbo.InventoryFlowHdr
           (TransactionNo, IsStock, TransactionType, Approved, ApprovedBy, ApprovedDate,
            IsAssetForm, IsClosed, InOutDate, InOut, ReasonIndex, ReasonName, CompanyCode,
            DeptCode, Department, VoucherNo, EntryBy, EntryDate)
         VALUES
           (@TransactionNo, @IsStock, @TransactionType, @Approved, @ApprovedBy, @ApprovedDate,
            @IsAssetForm, @IsClosed, @InOutDate, @InOut, @ReasonIndex, @ReasonName, @CompanyCode,
            @DeptCode, @Department, @VoucherNo, @EntryBy, GETDATE());`
      );

    // ── Step 7b: INSERT InventoryFlowDtl (1 row per line, §7 column subset) ──
    // Approved=1 + IsClosed=0 are the EXACT gate sp_Onhand reads — both come from CONFIG
    // and are asserted here so a wrong constant fails LOUDLY (the cut wouldn't count).
    if (cfg.INV_APPROVED !== 1 || cfg.INV_IS_CLOSED !== 0) {
      throw new KrsWriteError(
        `InventoryFlow gate misconfigured: Approved=${cfg.INV_APPROVED}, IsClosed=${cfg.INV_IS_CLOSED} (sp_Onhand needs 1/0)`
      );
    }
    for (let i = 0; i < payload.items.length; i++) {
      const item = payload.items[i];
      const mainUnits = unitsMap.get(item.itemCode) ?? "";
      await new sql.Request(tx)
        .input("TransactionNo", sql.NVarChar, flowTxnNo)
        .input("Number", sql.Int, i + 1)
        .input("TransactionType", sql.Int, cfg.INV_TRANSACTION_TYPE)
        .input("IsAssetForm", sql.Int, cfg.INV_IS_ASSET_FORM)
        .input("IsStock", sql.Int, cfg.INV_IS_STOCK)
        .input("IsClosed", sql.Int, cfg.INV_IS_CLOSED)
        .input("Approved", sql.Int, cfg.INV_APPROVED)
        .input("InOutDate", sql.Date, saleDate)
        .input("InOut", sql.Int, cfg.IN_OUT)
        .input("ReasonIndex", sql.Int, cfg.INV_REASON_INDEX)
        .input("ReasonName", sql.NVarChar, cfg.INV_REASON_NAME)
        .input("CompanyCode", sql.NVarChar, cfg.COMPANY_CODE)
        // Branch/Warehouse Phase 4: the stock-cut targets the cashier's WarehouseCode
        // (from the snapshot), not the fixed cfg.WAREHOUSE. Defaults to HQ "WH01" for an
        // unassigned cashier, matching the old constant. DeptCode (Department, below) is
        // CONFIRMED SHARED across warehouses ('WHE') → it stays cfg.INV_DEPT_CODE.
        .input("Warehouse", sql.NVarChar, payload.warehouseCode)
        .input("Department", sql.NVarChar, cfg.INV_DEPT_CODE)
        .input("VoucherNo", sql.NVarChar, flowVoucherNo)
        .input("ItemCode", sql.NVarChar, item.itemCode)
        .input("Description", sql.NVarChar, item.description)
        .input("SOTrNo", sql.Int, 0)
        .input("PONo", sql.NVarChar, "")
        .input("MainQuantity", sql.Decimal(18, 2), item.quantity)
        .input("MainUnits", sql.NVarChar, mainUnits)
        .query(
          `INSERT INTO dbo.InventoryFlowDtl
             (TransactionNo, Number, TransactionType, IsAssetForm, IsStock, IsClosed, Approved,
              InOutDate, InOut, ReasonIndex, ReasonName, CompanyCode, Warehouse, Department,
              VoucherNo, ItemCode, Description, SOTrNo, PONo, MainQuantity, MainUnits)
           VALUES
             (@TransactionNo, @Number, @TransactionType, @IsAssetForm, @IsStock, @IsClosed, @Approved,
              @InOutDate, @InOut, @ReasonIndex, @ReasonName, @CompanyCode, @Warehouse, @Department,
              @VoucherNo, @ItemCode, @Description, @SOTrNo, @PONo, @MainQuantity, @MainUnits);`
        );
    }

    // ── Step 7c: INSERT dbo.SalePurchaseTax (SaleVAT — VAT/tax log) ──
    // The output-VAT tax-log row for this cash sale. BillAmount = the ex-VAT base
    // (= SalesInvoiceHdr.SubTotalAmnt), VATAmount = the output VAT (= Hdr.VATAmount) —
    // it mirrors the Hdr's SubTotalAmnt/VATAmount split. No new RunningNumber is claimed:
    // VoucherTrNo reuses saleTxnNo (the SaleInvoiceTrNo anchor) and VoucherNo reuses
    // saleVoucherNo (SC-{YYMM}-{NNNN}). Roworder is identity (omitted); MyCode is optional
    // (left null). A failure here rolls back the whole tx — correct (no partial KRS write).
    await new sql.Request(tx)
      .input("IsPurchaseTax", sql.Int, cfg.SALEVAT_IS_PURCHASE_TAX) // tinyint NOT NULL
      .input("Type", sql.NVarChar, cfg.SALEVAT_TYPE) // nvarchar(30) NOT NULL
      .input("VoucherTrNo", sql.Decimal(18, 0), Number(saleTxnNo)) // decimal NOT NULL (= SaleInvoiceTrNo)
      .input("IsUndueVAT", sql.Int, cfg.SALEVAT_IS_UNDUE_VAT) // tinyint
      .input("IsFreeVAT", sql.Int, cfg.SALEVAT_IS_FREE_VAT) // tinyint
      .input("CompanyCode", sql.NVarChar, cfg.COMPANY_CODE)
      .input("CustOrSuppCode", sql.NVarChar, custCode)
      .input("CustOrSuppName", sql.NVarChar, custName)
      .input("VoucherDate", sql.Date, saleDate)
      .input("VoucherNo", sql.NVarChar, saleVoucherNo)
      .input("ActualInvoiceDate", sql.Date, saleDate)
      .input("ActualInvoiceNo", sql.NVarChar, saleVoucherNo) // nvarchar(50) NOT NULL
      .input("Description", sql.NVarChar, cfg.ACCOUNTS_DESCRIPTION)
      .input("BillAmount", sql.Decimal(18, 2), exVatSatang / 100) // ex-VAT base (matches SubTotalAmnt)
      .input("VATAmount", sql.Decimal(18, 2), money(payload.tax))
      .input("TaxFil", sql.Int, cfg.SALEVAT_TAX_FIL) // tinyint
      .input("VATPercent", sql.Decimal(18, 2), cfg.VAT_PERCENT)
      .input("BranchCode", sql.NVarChar, payload.branchCode)
      .input("BranchName", sql.NVarChar, payload.branchName)
      .query(
        `INSERT INTO dbo.SalePurchaseTax
           (IsPurchaseTax, Type, VoucherTrNo, IsUndueVAT, IsFreeVAT, CompanyCode, CustOrSuppCode, CustOrSuppName,
            VoucherDate, VoucherNo, ActualInvoiceDate, ActualInvoiceNo, Description, BillAmount, VATAmount, TaxFil,
            VATPercent, BranchCode, BranchName)
         VALUES
           (@IsPurchaseTax, @Type, @VoucherTrNo, @IsUndueVAT, @IsFreeVAT, @CompanyCode, @CustOrSuppCode, @CustOrSuppName,
            @VoucherDate, @VoucherNo, @ActualInvoiceDate, @ActualInvoiceNo, @Description, @BillAmount, @VATAmount, @TaxFil,
            @VATPercent, @BranchCode, @BranchName);`
      );

    // ── Step 8: COMMIT ──
    await tx.commit();
    committed = true;

    return {
      transactionNo: saleTxnNo,
      journalNo: saleVoucherNo,
      saleVoucherNo,
      flowTxnNo,
      flowVoucherNo,
      jnlCode,
    };
  } catch (e) {
    // Roll back burn tx only if it started but did not commit (phase-0 failure).
    if (burnTx && !burnCommitted) {
      try { await burnTx.rollback(); } catch { /* secondary */ }
    }
    // Roll back document tx if it started but did not commit (phase-1 failure).
    if (tx && !committed) {
      try { await tx.rollback(); } catch { /* secondary */ }
    }
    if (e instanceof WriteConfigNotReadyError || e instanceof KrsWriteError) throw e;
    const parts = safeErrorParts(e);
    throw new Error(`KRS write failed [${parts.code}]: ${parts.message}`);
  } finally {
    if (pool) {
      try {
        await pool.close();
      } catch {
        // Closing a pool that never fully opened can throw; result already determined.
      }
    }
  }
}
