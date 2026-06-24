/**
 * Seller identity for the Thai full tax invoice (ใบกำกับภาษีแบบเต็มรูป, §86/4).
 *
 * Owner decision (seller-company-settings, supersedes D2): seller identity is now
 * DB-PRIMARY. The admin edits these fields from /settings; they persist on the
 * `ShopSettings` singleton. The legacy `SELLER_*` ENV vars (still OPTIONAL at boot,
 * see src/lib/env.ts) are kept as a PER-FIELD FALLBACK (Decision D1 = KEEP) so an
 * existing ENV-based deploy keeps working with zero downtime and CI/e2e (which may
 * have no DB row) can still boot and issue invoices.
 *
 * Resolution order PER FIELD: DB value (non-null, non-empty after trim) wins; else
 * the matching `SELLER_*` ENV var; else (for branch only) an HQ default. This
 * module is the single read point that turns those sources into a typed seller
 * block and enforces the §86/4 mandatory particulars at ISSUE time.
 *
 * Two surfaces:
 *  - `getSellerConfig()` — ASYNC. The resolved seller block (with HQ branch
 *    defaults). Returns `null` when a MANDATORY particular (TIN / name / address)
 *    is unset after the DB-then-ENV chain. The request-tax route uses this null to
 *    refuse minting (422 SELLER_NOT_CONFIGURED) BEFORE consuming a tax-invoice
 *    number. `phone` / `posId` are receipt-only and NEVER affect the null decision.
 *  - `SellerConfig` — the type the A4 TaxInvoiceDocument renders from (it does NOT
 *    render phone/posId; those are thermal-receipt-only).
 *
 * NODE-ONLY: imports `@/lib/env` and `@/lib/prisma`, both Node-runtime modules.
 * Use it from route handlers / server components only (the TaxInvoiceDocument is
 * rendered server-side via its props, so it does NOT import this directly).
 */
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";

export type SellerConfig = {
  /** Registered legal name (§86/4 mandatory). */
  name: string;
  /** Full registered address (§86/4 mandatory). */
  address: string;
  /** 13-digit Revenue-Department TIN (§86/4 mandatory). */
  taxId: string;
  /** 5-digit RD branch code — "00000" = head office. Defaults to HQ. */
  branchCode: string;
  /** Human branch label (e.g. "สำนักงานใหญ่"). Defaults from the code. */
  branchLabel: string;
  /** Contact phone — receipt-only, NOT §86/4 mandatory (no ENV fallback). */
  phone?: string;
  /** POS terminal ID — receipt-only, NOT §86/4 mandatory (no ENV fallback). */
  posId?: string;
};

/** The single ShopSettings row id (singleton). */
const SINGLETON_ID = "singleton";
/** The default head-office branch code (สำนักงานใหญ่) when none is set anywhere. */
const HQ_BRANCH_CODE = "00000";
/** The default head-office label when no branch label is set anywhere. */
const HQ_BRANCH_LABEL = "สำนักงานใหญ่";

/** Trim a possibly-null DB string to a non-empty value, or null. */
function clean(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/**
 * Resolve the seller identity, DB-first with per-field ENV fallback. Returns
 * `null` when ANY of the three mandatory §86/4 particulars (TIN, name, address) is
 * unset after the chain — the caller treats that as "seller not configured" and
 * refuses to issue a tax invoice. Branch code/label fall back to HQ defaults (a
 * missing branch designation is not a compliance blocker — head office is the safe
 * single-branch default). `phone` / `posId` are receipt-only and never affect the
 * null-return decision.
 */
export async function getSellerConfig(): Promise<SellerConfig | null> {
  // DB-first read of the singleton's seller columns. A missing row (fresh, never
  // upserted) yields null → every field falls back to ENV, preserving the prior
  // ENV-only behavior exactly.
  const row = await prisma.shopSettings.findUnique({
    where: { id: SINGLETON_ID },
    select: {
      sellerName: true,
      sellerTaxId: true,
      sellerAddress: true,
      sellerPhone: true,
      sellerPosId: true,
      sellerBranchCode: true,
      sellerBranchLabel: true,
    },
  });

  // Per-field resolution: DB value wins when non-null/non-empty; else ENV.
  const name = clean(row?.sellerName) ?? env.SELLER_NAME ?? null;
  const taxId = clean(row?.sellerTaxId) ?? env.SELLER_TAX_ID ?? null;
  const address = clean(row?.sellerAddress) ?? env.SELLER_ADDRESS ?? null;

  // The three mandatory particulars must ALL be present (env.ts already validated
  // TIN shape = 13 digits when set; the PATCH schema does the same for DB writes).
  // A missing one → not configured.
  if (!name || !taxId || !address) {
    return null;
  }

  const branchCode =
    clean(row?.sellerBranchCode) ?? env.SELLER_BRANCH_CODE ?? HQ_BRANCH_CODE;
  // Default the label from the code: HQ code → HQ label, else "สาขาที่ NNNNN".
  const branchLabel =
    clean(row?.sellerBranchLabel) ??
    env.SELLER_BRANCH_LABEL ??
    (branchCode === HQ_BRANCH_CODE ? HQ_BRANCH_LABEL : `สาขาที่ ${branchCode}`);

  // Receipt-only optional fields (no ENV fallback — they are new). undefined when
  // unset so they cleanly omit from the JSON / receipt header.
  const phone = clean(row?.sellerPhone) ?? undefined;
  const posId = clean(row?.sellerPosId) ?? undefined;

  return { name, address, taxId, branchCode, branchLabel, phone, posId };
}
