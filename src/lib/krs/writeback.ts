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
//   6. INSERT dbo.TheJournal ×3 (D cash=total / C revenue=subtotal / C VAT=tax),
//      asserting DR == CR BEFORE commit.
//   7. INSERT dbo.InventoryFlowHdr + dbo.InventoryFlowDtl (Approved=1, IsClosed=0, InOut=-1
//      so dbo.sp_Onhand counts the cut immediately).
//   8. COMMIT; return the claimed doc numbers.
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
// IDEMPOTENCY CAVEAT (flagged for security review): the SIMPLIFIED KRS inserts confirmed by
// the vendor (field-analysis §6/§7) have NO idempotency column — SalesInvoiceHdr.Remarks is
// NOT in the confirmed insert set, so there is no anchor to dedup on at the KRS side, and a
// pre-insert "SELECT … WHERE Remarks = ?" would query a column the insert never populates.
// Exactly-once therefore relies ENTIRELY on the dispatcher: each SyncJob is dispatched once
// (atomic FOR UPDATE SKIP LOCKED claim + idempotencyKey SYNCED dedup), and the job is marked
// SYNCED only AFTER this function returns (COMMIT succeeded). RESIDUAL RISK: a crash in the
// window between the mssql COMMIT and the Postgres mark-SYNCED leaves the job lock-held; after
// the 10-minute stale-lock window it is re-claimable and would DOUBLE-WRITE (a second sale +
// stock cut in KRS), because nothing in KRS rejects the duplicate. Mitigations to consider in
// review: (a) add an idempotency anchor column to the KRS insert set if the vendor exposes one,
// or (b) shrink the crash window / use a 2-phase mark. This is documented, not silently ignored.
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

/** Parse a sale ISO instant to a JS Date for the date columns (VoucherDate / DueDate /
 *  InOutDate). Throws on an unparseable value. Pure: no I/O. */
function toDate(isoDate: string): Date {
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) {
    throw new KrsWriteError(`Invalid sale date "${isoDate}"`);
  }
  return d;
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
  config: sql.config
): Promise<KrsWriteResult> {
  // (1) Refuse if any vendor constant is still a TODO placeholder — never guess. This
  // runs BEFORE any connection is opened or any number is claimed.
  assertWriteConfigReady(KRS_WRITE_CONFIG);

  const cfg = KRS_WRITE_CONFIG;

  // (2) Double-entry balance gate (integer satang — no float). Asserted up-front so a
  // malformed/unbalanced snapshot is rejected before opening a connection. The journal
  // posts D total / C subtotal / C tax; total MUST equal subtotal + tax exactly.
  const totalSatang = toSatang(payload.total);
  const subtotalSatang = toSatang(payload.subtotal);
  const taxSatang = toSatang(payload.tax);
  if (totalSatang !== subtotalSatang + taxSatang) {
    throw new KrsWriteError(
      `Journal imbalance: total ${payload.total} != subtotal ${payload.subtotal} + tax ${payload.tax}`
    );
  }

  // (3) Derive the per-month tokens and the date columns (pure — no I/O).
  const yymm = deriveYYMM(payload.createdAt);
  const saleDate = toDate(payload.createdAt);

  let pool: sql.ConnectionPool | null = null;
  let tx: sql.Transaction | null = null;
  let committed = false;
  try {
    pool = new sql.ConnectionPool(config);
    await pool.connect();

    tx = new sql.Transaction(pool);
    // SERIALIZABLE: the running-number claims + inserts are one logical document; the
    // strictest isolation matches the vendor's "in-progress txn must finish or it
    // blocks" concurrency note (field-analysis §6) and prevents phantom doubles.
    await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

    // ── Step 1: atomic RunningNumber claims (all inside the tx) ──
    const saleTxnSeq = await claimRunningNumber(tx, cfg.RUNNING_NUMBER_NAME_INVOICE);
    const saleVoucherSeq = await claimRunningNumber(
      tx,
      `${cfg.RUNNING_NUMBER_VOUCHER_PREFIX}${yymm}`
    );
    const flowTxnSeq = await claimRunningNumber(tx, cfg.RUNNING_NUMBER_NAME_INVFLOW);
    const flowVoucherSeq = await claimRunningNumber(
      tx,
      `${cfg.INV_VOUCHER_PREFIX}${yymm}`
    );
    const jnlSeq = await claimRunningNumber(tx, cfg.RUNNING_NUMBER_NAME_RECEIPT);

    // TransactionNo values are the raw claimed sequences (KRS keys documents by them).
    const saleTxnNo = String(saleTxnSeq);
    const flowTxnNo = String(flowTxnSeq);
    const jnlCode = String(jnlSeq);
    // Formatted voucher numbers "{PREFIX}-{YYMM}-{NNNN}".
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
      .input("VoucherDate", sql.DateTime, saleDate)
      .input("DocuType", sql.NVarChar, cfg.DOCU_TYPE)
      .input("CustOrSuppCode", sql.NVarChar, custCode)
      .input("CustOrSuppName", sql.NVarChar, custName)
      .input("Address", sql.NVarChar, custAddress)
      .input("DeliveryAddress", sql.NVarChar, custAddress)
      .input("DueDate", sql.DateTime, saleDate)
      .input("IsVAT", sql.Int, cfg.IS_VAT)
      .input("IsClosed", sql.Int, cfg.IS_CLOSED)
      .input("IsPaid", sql.Int, cfg.IS_PAID)
      .input("Currency", sql.NVarChar, cfg.JOURNAL_CURRENCY)
      .input("ExchangeRate", sql.Decimal(18, 6), 1)
      .input("AccountsDescription", sql.NVarChar, cfg.ACCOUNTS_DESCRIPTION)
      .input("TotalAmount", sql.Decimal(18, 2), money(payload.total))
      .input("SubTotalAmnt", sql.Decimal(18, 2), money(payload.subtotal))
      .input("DepositAmount", sql.Decimal(18, 2), 0)
      .input("VATForValue", sql.Decimal(18, 2), money(payload.subtotal))
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

    // ── Step 6: INSERT TheJournal ×3 (D cash=total / C revenue=subtotal / C VAT=tax) ──
    // The double-entry balance was asserted up-front (totalSatang == subtotal + tax).
    // We re-assert the DR/CR split here as the final gate immediately before posting.
    const drSatang = totalSatang;
    const crSatang = subtotalSatang + taxSatang;
    if (drSatang !== crSatang) {
      throw new KrsWriteError(
        `Journal imbalance before post: DR ${payload.total} != CR ${payload.subtotal}+${payload.tax}`
      );
    }
    const journalRows: Array<{ drcr: "D" | "C"; account: string; amount: string }> = [
      { drcr: "D", account: cashAccount, amount: payload.total },
      { drcr: "C", account: revenueAccount, amount: payload.subtotal },
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
        .input("JnlDate", sql.DateTime, saleDate)
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
        .input("BranchCode", sql.NVarChar, cfg.JOURNAL_BRANCH_CODE)
        .input("BranchName", sql.NVarChar, cfg.JOURNAL_BRANCH_NAME)
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
      .input("ApprovedDate", sql.DateTime, saleDate)
      .input("IsAssetForm", sql.Int, cfg.INV_IS_ASSET_FORM)
      .input("IsClosed", sql.Int, cfg.INV_IS_CLOSED)
      .input("InOutDate", sql.DateTime, saleDate)
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
        .input("InOutDate", sql.DateTime, saleDate)
        .input("InOut", sql.Int, cfg.IN_OUT)
        .input("ReasonIndex", sql.Int, cfg.INV_REASON_INDEX)
        .input("ReasonName", sql.NVarChar, cfg.INV_REASON_NAME)
        .input("CompanyCode", sql.NVarChar, cfg.COMPANY_CODE)
        .input("Warehouse", sql.NVarChar, cfg.WAREHOUSE)
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
    // Roll back the whole document on ANY failure. A rollback can itself throw (e.g. the
    // connection dropped); swallow that secondary error so the ORIGINAL cause surfaces.
    if (tx && !committed) {
      try {
        await tx.rollback();
      } catch {
        // The original error below is the real cause; a rollback fault is secondary.
      }
    }
    // Re-throw the typed "leave pending" / "data problem" errors unchanged so the
    // dispatcher can branch on them. Everything else is a transient driver/tx fault →
    // SANITIZE it (never the raw mssql/config/password) and re-throw a plain Error.
    if (e instanceof WriteConfigNotReadyError || e instanceof KrsWriteError) {
      throw e;
    }
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
