import { BrowserPrintService } from "./browserPrintService";
import type { ReceiptPrintService } from "./types";

// Public surface of the receipt-print-service abstraction.
export type { ReceiptData, ReceiptPrintService } from "./types";
export { BrowserPrintService } from "./browserPrintService";
export { PrintAgentService, type PrintAgentOptions } from "./printAgentService";

/**
 * Factory for the ACTIVE receipt-print backend.
 *
 * TODAY: always the browser mechanism (`window.print()` via BrowserPrintService)
 * — so the user-visible print behavior is unchanged.
 *
 * LATER (one-line swap): return a `PrintAgentService` to print SILENTLY through
 * the local ESC/POS agent — no browser dialog. For example:
 *
 *   // Always use the local agent:
 *   return new PrintAgentService();
 *
 *   // Or opt in via a detected agent / setting / env flag:
 *   // if (process.env.NEXT_PUBLIC_RECEIPT_PRINT_AGENT === "1") {
 *   //   return new PrintAgentService();
 *   // }
 *   // return new BrowserPrintService();
 *
 * The POS confirm / auto-print flow NEVER changes because it depends only on the
 * `ReceiptPrintService` interface returned here.
 */
export function getReceiptPrintService(): ReceiptPrintService {
  return new BrowserPrintService();
}
