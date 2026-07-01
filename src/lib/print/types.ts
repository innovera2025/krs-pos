import type { OrderDTO, ShopSettingsDTO } from "@/types";

/**
 * The data a receipt-print backend needs to render/print one receipt
 * (receipt-print-service abstraction).
 *
 *  - `order`        — the just-created (or reprinted) order that drives the
 *                     receipt body (line items, totals, payments, tax block).
 *  - `seller`       — pre-loaded seller identity for the printed header
 *                     (name / branch / phone / POS id). A partial settings
 *                     object, or null when not configured.
 *  - `sizeSettings` — store-level receipt print-size settings used to compute
 *                     the `@page` size for the BROWSER print path. null → the
 *                     browser path falls back to the globals.css 80mm default
 *                     (with a last-chance settings fetch).
 *
 * The browser backend only consumes `sizeSettings` (the receipt DOM is rendered
 * separately by <ReceiptModal>). A future LOCAL ESC/POS AGENT backend serializes
 * the WHOLE payload to build its print job, which is why `order` + `seller`
 * travel with every request even though the browser path ignores them.
 */
export interface ReceiptData {
  order: OrderDTO;
  seller: Partial<ShopSettingsDTO> | null;
  sizeSettings: ShopSettingsDTO | null;
}

/**
 * Swappable receipt-printing backend. The POS confirm flow depends ONLY on this
 * interface, so the underlying mechanism — browser `window.print()` today, a
 * silent local ESC/POS print agent tomorrow — can change WITHOUT touching the
 * checkout / auto-print code (see `getReceiptPrintService`).
 */
export interface ReceiptPrintService {
  /**
   * Print one receipt. RESOLVES when the print has settled — regardless of
   * whether it actually succeeded — so the caller can safely return to a fresh
   * sale. A cancelled, failed, or suppressed print must NOT leave the POS stuck
   * (fire-and-forget safety).
   */
  printReceipt(receipt: ReceiptData): Promise<void>;
}
