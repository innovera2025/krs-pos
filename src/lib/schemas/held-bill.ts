import { z } from "zod";

/**
 * Held-bill (พักบิล) request schema (NODE-ONLY — do not import from a client/edge
 * module). Validates SHAPE + TYPE at the JSON-parse boundary for POST /api/held-bills.
 *
 * ⚠️ SNAPSHOT, NOT AUTHORITY. The cartJson the cashier parks is a DISPLAY/RESTORE
 * snapshot only — checkout STILL recomputes all money/stock server-side from live DB
 * prices when the bill is resumed and paid. This schema therefore only asserts the
 * snapshot is well-formed; `productPrice` is accepted as a free string (the Decimal wire
 * format) and is never used as a price source.
 *
 * Field rules:
 *   - label          required, trimmed-non-empty, ≤ 100 ("HH:MM · {N} รายการ").
 *   - cartJson.items at least one line; each carries the restore essentials (productId
 *                    cuid, positive-int quantity, non-negative-int lineDiscountSatang)
 *                    plus the captured product name/price/sku for list display.
 *   - cartJson.customer  nullable object mirroring the CustomerDTO restore fields, or
 *                        null (walk-in).
 *   - customerId     cuid or null (denormalized alongside the snapshot; plain TEXT, no FK).
 *   - discountType   "amount" | "percent".
 *   - discountValue  ≥ 0 (raw bill-discount input, restored verbatim on resume).
 *   - taxRequested   boolean.
 *   - totalSatang    ≥ 0 integer (bill total captured at park time, for list display).
 */

const heldBillItemSchema = z.object({
  productId: z.string().cuid(),
  quantity: z.number().int().positive(),
  lineDiscountSatang: z.number().int().min(0),
  productName: z.string(),
  productPrice: z.string(),
  productSku: z.string(),
});

const heldBillCustomerSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    taxId: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    address: z.string().nullable().optional(),
    buyerBranchCode: z.string(),
    branchId: z.string(),
  })
  .nullable();

export const HeldBillPostBodySchema = z.object({
  label: z.string().trim().min(1).max(100),
  cartJson: z.object({
    items: z.array(heldBillItemSchema).min(1),
    customer: heldBillCustomerSchema,
  }),
  customerId: z.string().cuid().nullable(),
  discountType: z.enum(["amount", "percent"]),
  discountValue: z.number().min(0),
  taxRequested: z.boolean(),
  totalSatang: z.number().int().min(0),
});

export type HeldBillPostBody = z.infer<typeof HeldBillPostBodySchema>;
