import { z } from "zod";

/**
 * Order request schemas (NODE-ONLY — do not import from client/edge).
 *
 * ⚠️ ORDERS POST = WRAP, NOT REPLACE (owner decision D1). This schema validates
 * ONLY the SHAPE/TYPE of the request at the JSON-parse boundary. ALL money/domain
 * logic stays in the route, untouched and AFTER this parse:
 *   - server satang recompute (computeOrderTotals) from DB prices
 *   - PAYMENT_MISMATCH exact satang comparison
 *   - MAX_PAYMENT_LINES = 20 cap (kept MANUAL → 422 TOO_MANY_PAYMENTS, decision D4;
 *     deliberately NOT z.array().max(20), which would emit a 400 too_big)
 *   - the >2dp discountValue precision guard (kept MANUAL post-parse)
 *   - payment method validity (kept MANUAL via isPaymentType → 422 BAD_METHOD; the
 *     schema only checks `method` is a string)
 *   - idempotencyKey normalization, ORDER_NUMBER minting, cashier-from-session,
 *     amountPaid-from-lines, change computation, P2002/P2025 handling, error codes.
 *
 * Fields the server INTENTIONALLY ignores (subtotal/discount/tax/total/amountPaid/
 * change/cashierId) are NOT in the schema; Zod's default object mode strips unknown
 * keys, so a client-sent value for any of them is dropped (anti-tamper preserved).
 */

const lineItemSchema = z.object({
  productId: z.string().min(1),
  // Quantity range/integer/Int4 are re-checked in the route (BAD_ITEM); here we
  // only assert it is a number so a structurally wrong item is rejected early.
  quantity: z.number(),
  // Optional per-line discount in integer satang; the route validates non-negative
  // integer (BAD_ITEM) and clamps it into the recompute.
  lineDiscountSatang: z.number().optional(),
});

const paymentLineSchema = z.object({
  // method stays a STRING here — the route validates it against PaymentType via
  // isPaymentType (→ 422 BAD_METHOD), preserving the existing code/status.
  method: z.string(),
  // amount in baht; the route converts to satang and validates positivity/range.
  amount: z.number(),
  reference: z.string().nullish(),
});

/**
 * POST /api/orders body — SHAPE ONLY. NO .max() on paymentLines (decision D4), NO
 * 2dp refinement on discountValue (kept manual). Empty arrays pass Zod (the route
 * returns NO_ITEMS / NO_PAYMENT with its existing codes/statuses).
 */
export const OrderPostBodySchema = z.object({
  // NO .max() on items (same rationale as paymentLines/D4): the cap is the route's
  // MANUAL guard (items.length > MAX_ITEMS → 422 TOO_MANY_ITEMS). A Zod .max() here
  // would fire FIRST and shadow that coded guard with a generic 400 VALIDATION, so
  // shape-only here; the manual guard is the single authoritative cap.
  items: z.array(lineItemSchema),
  paymentLines: z.array(paymentLineSchema).optional(),
  discountType: z.enum(["amount", "percent"]).optional(),
  discountValue: z.number().optional(),
  // NO .max() on customerId for the same reason — the route length-checks it and
  // returns the coded 400 BAD_CUSTOMER; a Zod cap would shadow it with VALIDATION.
  customerId: z.string().nullish(),
  taxRequested: z.boolean().optional(),
  // Loyalty redemption (loyalty program, Phase 2). SHAPE ONLY — a number; the route
  // validates non-negative integer / Int4 range (→ 400 BAD_REDEEM) and recomputes the
  // ฿ value server-side. MUST be declared here: z.object() strips unknown keys, so an
  // undeclared redeemPoints would be silently dropped and never applied.
  redeemPoints: z.number().optional(),
  // Reward redemption (loyalty program, Phase 3B). SHAPE ONLY — an array of reward ids
  // (0..N) the member is redeeming for a free product unit each. NO .max() / element
  // refinement here (mirrors items/paymentLines, decision D4): the route owns the MANUAL
  // coded guards (cap length, non-empty strings, dedupe → 422) so a Zod cap never shadows
  // them with a generic VALIDATION. MUST be declared — z.object() strips unknown keys, so
  // an undeclared redeemRewardIds would be silently dropped and never applied.
  redeemRewardIds: z.array(z.string()).optional(),
  idempotencyKey: z.string().nullish(),
});

export type OrderPostBody = z.infer<typeof OrderPostBodySchema>;

/** PATCH /api/orders/[id] — action shape only; the route keeps RBAC + state-machine.
 *  `refund` was removed (krs-void-writeback, 19-07-26 owner decision — the shop has no
 *  refunds); historical REFUNDED orders keep their badge, but no new refund can be
 *  created, so the Zod enum now rejects {action:"refund"} with 400 BAD_ACTION. */
export const OrderPatchBodySchema = z.object({
  action: z.enum(["void", "request-tax"], {
    message: "action must be 'void' or 'request-tax'",
  }),
});

export type OrderPatchBody = z.infer<typeof OrderPatchBodySchema>;
