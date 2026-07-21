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
  // Membership + loyalty (loyalty program, Phase 1A) — carried in the CustomerDTO so
  // the picker / POS surfaces know a customer is a member and can show their balance
  // (the POS chip wiring itself is Phase 1B).
  isMember: true,
  pointsBalance: true,
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
 * Membership flag (loyalty program, Phase 1A). Optional; defaults to false so a
 * plain tax-customer create/edit is unchanged. When true, the customer is enrolled
 * as a loyalty member — which REQUIRES a phone (the member key). The phone
 * requirement is enforced by a `.superRefine` on the POST schema (full create
 * context) and, for PATCH (where the existing phone may not be re-sent), by the
 * route against the effective phone.
 */
const isMemberSchema = z.boolean().optional().default(false);

/**
 * POST /api/customers body — create. `name` required; `taxId`/`address`/`phone`
 * optional (null when absent); `buyerBranchCode` defaults to "00000". `isMember`
 * enrolls the customer as a loyalty member — and when true, `phone` is REQUIRED
 * (members need a phone key), enforced by the `.superRefine` below.
 */
export const CustomerPostBodySchema = z
  .object({
    name: nameSchema,
    taxId: taxIdSchema,
    address: addressSchema,
    phone: phoneSchema,
    buyerBranchCode: buyerBranchCodeSchema,
    isMember: isMemberSchema,
  })
  .superRefine((data, ctx) => {
    // A member must have a phone (the loyalty member key). `phoneSchema` has already
    // transformed an empty/whitespace phone to null, so a null here = no phone.
    if (data.isMember === true && data.phone == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["phone"],
        message: "สมาชิกต้องระบุเบอร์โทร",
      });
    }
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
  // Enroll/unenroll flag (loyalty program, Phase 1A). Optional (omitted = leave the
  // flag unchanged). The "member requires a phone" rule can't be checked in the
  // schema here (the existing phone may not be re-sent), so the PATCH route enforces
  // it against the EFFECTIVE phone (patch value or the stored value).
  isMember: z.boolean().optional(),
});

export type CustomerPatchBody = z.infer<typeof CustomerPatchBodySchema>;

/**
 * Classify a Prisma error from a Customer write into WHICH unique constraint it
 * violated, so the routes can return a specific 409:
 *  - "MEMBER_PHONE": the PARTIAL unique index `Customer_phone_member_key` (another
 *    member already uses this phone). That index is created via RAW SQL in the
 *    add_loyalty migration, so Prisma does not know it as a schema `@unique` — a
 *    violation may surface either as a `P2002` carrying the index name in
 *    `meta.target`, or as a raw DB error (SQLSTATE 23505) whose message contains the
 *    constraint name. Both shapes are matched here by the constraint name.
 *  - "TAXID": the schema `@unique` on `Customer.taxId` (`Customer_taxId_key`) — the
 *    only other unique on the table, so any remaining `P2002` is the taxId.
 *  - null: not a Customer unique-constraint violation.
 */
export function classifyCustomerUniqueError(
  err: unknown
): "MEMBER_PHONE" | "TAXID" | null {
  const MEMBER_PHONE_INDEX = "Customer_phone_member_key";
  // Raw DB error (or any error) whose message carries the partial-index name.
  const message = err instanceof Error ? err.message : "";
  if (message.includes(MEMBER_PHONE_INDEX)) return "MEMBER_PHONE";

  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002"
  ) {
    const target = err.meta?.target;
    const targetStr = Array.isArray(target)
      ? target.join(",")
      : typeof target === "string"
        ? target
        : "";
    if (targetStr.includes(MEMBER_PHONE_INDEX) || targetStr.includes("phone")) {
      return "MEMBER_PHONE";
    }
    // The only other unique on Customer is taxId.
    return "TAXID";
  }
  return null;
}
