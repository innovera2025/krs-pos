import { z } from "zod";

/**
 * Stock-movement request schema (NODE-ONLY — do not import from client/edge).
 *
 * WRAP style: validate SHAPE only. This route is already hardened (§1: Complete) —
 * the handler keeps its qty integer/positive/Int4 guard (BAD_QTY), reference ≤ 200
 * cap (BAD_REFERENCE), and P2025 → PRODUCT_NOT_FOUND mapping after parse. Zod here
 * just rejects a structurally wrong body (e.g. missing productId, qty not a number)
 * before the manual domain guards run.
 */
export const StockMovementPostBodySchema = z.object({
  productId: z.string().min(1, "Missing productId"),
  qty: z.number({ message: "จำนวนรับเข้าต้องเป็นจำนวนเต็มบวก" }),
  // SHAPE ONLY — no .max() here. The route's manual ≤ 200 guard (→ 400 BAD_REFERENCE)
  // is the single source of truth for the length cap; a .max() here would shadow it
  // with a generic VALIDATION code (contract drift). Kept .nullish() shape-only.
  reference: z.string().nullish(),
});

export type StockMovementPostBody = z.infer<typeof StockMovementPostBodySchema>;
