import { Prisma } from "@prisma/client";
import { z } from "zod";

/**
 * Customer request schemas (NODE-ONLY — do not import from a client/edge module).
 *
 * Phase 4 tax-invoice 4c (Customer CRUD). These validate SHAPE + TYPE at the
 * JSON-parse boundary for POST /api/customers (create) and PATCH
 * /api/customers/[id] (partial edit). The route handlers keep their
 * domain-specific responses (P2002 taxId → 409 TAXID_TAKEN, P2025 → 404
 * NOT_FOUND) AFTER a successful parse.
 *
 * Field rules (mirror the Customer columns in prisma/schema.prisma):
 *   - name             required, trimmed-non-empty, ≤ 200.
 *   - taxId            optional; if present it must be EXACTLY 13 digits — the
 *                      Thai §86/4 buyer TIN format (delivers the deferred buyer-TIN
 *                      format validation). Empty/whitespace normalizes to null so
 *                      the unique-index allows many NULLs (walk-in members).
 *   - address          optional, trimmed, ≤ 300; empty → null.
 *   - phone            optional, trimmed, ≤ 30; empty → null.
 *   - buyerBranchCode  optional; if present it must be EXACTLY 5 digits (the RD
 *                      branch code — "00000" = สำนักงานใหญ่). Defaults to "00000".
 */

/**
 * The narrowed Customer projection shared by GET (list), POST (create), and
 * PATCH (edit) so every customer route returns the SAME shape the picker already
 * consumes (CustomerDTO). Single source of truth (was copy-pasted in both
 * /api/customers route handlers). Plain `satisfies` object — Node-safe, no
 * client/edge import. The password-free analogue of USER_PUBLIC_SELECT: Customer
 * has no secret column, but pinning the select keeps the wire shape stable.
 */
export const CUSTOMER_PUBLIC_SELECT = {
  id: true,
  name: true,
  taxId: true,
  phone: true,
  address: true,
  // Buyer RD branch designation (Phase 4) — part of the CustomerDTO shape so a
  // picked/created customer carries it for the full §86/4 tax invoice.
  buyerBranchCode: true,
  branchId: true,
} satisfies Prisma.CustomerSelect;

/** Thai buyer TIN: exactly 13 digits (§86/4(2)). */
const TAXID_RE = /^\d{13}$/;
/** RD branch designation: exactly 5 digits ("00000" = head office). */
const BRANCH_CODE_RE = /^\d{5}$/;

/**
 * Required customer name — trimmed, non-empty, capped at 200. `transform → pipe`
 * mirrors the product schema so a whitespace-only name is rejected, not stored.
 */
const nameSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1, "กรุณากรอกชื่อลูกค้า").max(200, "ชื่อลูกค้ายาวเกินไป"));

/**
 * Optional buyer TIN. Accepts a 13-digit string, or null/undefined/"" (member
 * with no tax id). Trimmed before the format check; empty → null so the unique
 * `taxId` index stays sparse (Postgres allows many NULLs).
 */
const taxIdSchema = z
  .string()
  .nullish()
  .transform((v) => (typeof v === "string" ? v.trim() : ""))
  .pipe(
    z
      .string()
      .regex(TAXID_RE, "เลขผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก")
      .or(z.literal(""))
  )
  .transform((v) => (v.length > 0 ? v : null));

/** Optional address — trimmed, ≤ 300; empty → null. */
const addressSchema = z
  .string()
  .max(300, "ที่อยู่ยาวเกินไป")
  .nullish()
  .transform((v) => {
    const t = typeof v === "string" ? v.trim() : "";
    return t.length > 0 ? t : null;
  });

/** Optional phone — trimmed, ≤ 30; empty → null. */
const phoneSchema = z
  .string()
  .max(30, "เบอร์โทรยาวเกินไป")
  .nullish()
  .transform((v) => {
    const t = typeof v === "string" ? v.trim() : "";
    return t.length > 0 ? t : null;
  });

/**
 * Optional RD branch code — 5 digits if present, else "00000". Trimmed; an empty
 * value normalizes to the head-office default so the column never goes blank.
 */
const buyerBranchCodeSchema = z
  .string()
  .nullish()
  .transform((v) => (typeof v === "string" ? v.trim() : ""))
  .pipe(
    z
      .string()
      .regex(BRANCH_CODE_RE, "รหัสสาขาต้องเป็นตัวเลข 5 หลัก")
      .or(z.literal(""))
  )
  .transform((v) => (v.length > 0 ? v : "00000"));

/**
 * POST /api/customers body — create. `name` required; `taxId`/`address`/`phone`
 * optional (null when absent); `buyerBranchCode` defaults to "00000".
 */
export const CustomerPostBodySchema = z.object({
  name: nameSchema,
  taxId: taxIdSchema,
  address: addressSchema,
  phone: phoneSchema,
  buyerBranchCode: buyerBranchCodeSchema,
});

export type CustomerPostBody = z.infer<typeof CustomerPostBodySchema>;

/**
 * PATCH /api/customers/[id] body — partial edit. Every field optional; only the
 * provided keys are touched. `taxId` accepts a 13-digit string, "", or null to
 * clear; `address`/`phone` accept "" / null to clear; `buyerBranchCode` (when
 * provided) is 5 digits or "" → "00000".
 *
 * `.partial()` over a shared shape would re-run the inner defaulting transforms,
 * so the patch fields are declared explicitly with `.optional()` to keep
 * "field omitted = untouched" distinct from "field cleared".
 */
export const CustomerPatchBodySchema = z.object({
  name: nameSchema.optional(),
  taxId: taxIdSchema.optional(),
  address: addressSchema.optional(),
  phone: phoneSchema.optional(),
  buyerBranchCode: buyerBranchCodeSchema.optional(),
});

export type CustomerPatchBody = z.infer<typeof CustomerPatchBodySchema>;
