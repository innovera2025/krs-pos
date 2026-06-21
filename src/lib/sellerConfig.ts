/**
 * Seller identity for the Thai full tax invoice (ใบกำกับภาษีแบบเต็มรูป, §86/4).
 *
 * Owner decision D2: seller identity lives in ENV (no DB model). The five
 * `SELLER_*` vars are OPTIONAL at boot (see src/lib/env.ts) so a deploy that
 * never issues a tax invoice — and CI/e2e — still boots. This module is the
 * single read point that turns those env vars into a typed seller block and
 * enforces the §86/4 mandatory particulars at ISSUE time.
 *
 * Two surfaces:
 *  - `getSellerConfig()` — the resolved seller block (with HQ branch defaults).
 *    Returns `null` when a MANDATORY particular (TIN / name / address) is unset.
 *    The request-tax route uses this null to refuse minting (422
 *    SELLER_NOT_CONFIGURED) BEFORE consuming a tax-invoice number.
 *  - `SellerConfig` — the type the A4 TaxInvoiceDocument renders from.
 *
 * NODE-ONLY: imports `@/lib/env`, which is a Node-runtime module. Use it from
 * route handlers / server components only (the TaxInvoiceDocument is rendered
 * server-side via its props, so it does NOT import this directly).
 */
import { env } from "@/lib/env";

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
};

/** The default head-office branch code (สำนักงานใหญ่) when SELLER_BRANCH_CODE is unset. */
const HQ_BRANCH_CODE = "00000";
/** The default head-office label when SELLER_BRANCH_LABEL is unset. */
const HQ_BRANCH_LABEL = "สำนักงานใหญ่";

/**
 * Resolve the seller identity from env. Returns `null` when ANY of the three
 * mandatory §86/4 particulars (TIN, name, address) is unset — the caller treats
 * that as "seller not configured" and refuses to issue a tax invoice. Branch
 * code/label fall back to HQ defaults (a missing branch designation is not a
 * compliance blocker — head office is the safe single-branch default).
 */
export function getSellerConfig(): SellerConfig | null {
  const taxId = env.SELLER_TAX_ID;
  const name = env.SELLER_NAME;
  const address = env.SELLER_ADDRESS;

  // The three mandatory particulars must ALL be present (env.ts already
  // validated TIN shape = 13 digits when set). A missing one → not configured.
  if (!taxId || !name || !address) {
    return null;
  }

  const branchCode = env.SELLER_BRANCH_CODE ?? HQ_BRANCH_CODE;
  // Default the label from the code: HQ code → HQ label, else "สาขาที่ NNNNN".
  const branchLabel =
    env.SELLER_BRANCH_LABEL ??
    (branchCode === HQ_BRANCH_CODE
      ? HQ_BRANCH_LABEL
      : `สาขาที่ ${branchCode}`);

  return { name, address, taxId, branchCode, branchLabel };
}
