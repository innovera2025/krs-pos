import { printReceiptWithSize } from "@/lib/receiptPrint";
import type { ReceiptData, ReceiptPrintService } from "./types";

/**
 * BrowserPrintService — the CURRENT browser print mechanism, encapsulated behind
 * the swappable `ReceiptPrintService` interface (receipt-print-service
 * abstraction).
 *
 * It reproduces the POS auto-print effect EXACTLY:
 *   1. rAF-wait (bounded to ~60 frames) for the screen-hidden `.print-receipt`
 *      paper to mount. The caller renders it via <ReceiptModal open={...}
 *      autoPrint />; this service only needs that element in the DOM.
 *   2. Once mounted, call `printReceiptWithSize(receipt.sizeSettings)` — the same
 *      inject-@page-size + `window.print()` path the manual/reprint flows use.
 *   3. RESOLVE on `afterprint`, with a ~5s timeout fallback so a suppressed or
 *      cancelled print still returns the caller to a usable state.
 *
 * Fire-and-forget-safe: the sale is already recorded before printing, so a
 * cancelled/failed/suppressed print — or the paper never mounting within the
 * frame budget — still resolves (never hangs), letting the POS reset to a new
 * sale. NET behavior is identical to the former inline effect.
 */

/** rAF budget to wait for the `.print-receipt` paper to mount (~1s of frames). */
const MAX_FRAMES = 60;

/** `afterprint` fallback (ms): resolve even if the event never fires (kiosk). */
const AFTERPRINT_FALLBACK_MS = 5000;

export class BrowserPrintService implements ReceiptPrintService {
  printReceipt(receipt: ReceiptData): Promise<void> {
    // SSR / non-DOM guard: nothing to print → resolve immediately so callers
    // never hang waiting on a promise that can't settle.
    if (typeof window === "undefined" || typeof document === "undefined") {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      let done = false;
      let frames = 0;
      let fallbackTimer = 0;

      // Resolve once and stop listening. Idempotent (guarded by `done`) — the
      // FIRST of `afterprint` / the 5s fallback wins, mirroring the old finish().
      const finish = () => {
        if (done) return;
        done = true;
        window.removeEventListener("afterprint", finish);
        window.clearTimeout(fallbackTimer);
        resolve();
      };

      // Print once the paper is actually in the DOM; retry next frame until then.
      const tryPrint = () => {
        if (done) return;
        const paperReady = document.querySelector(".print-receipt") !== null;
        if (!paperReady) {
          if (frames < MAX_FRAMES) {
            frames += 1;
            requestAnimationFrame(tryPrint);
          }
          // Paper never mounted within budget: skip printing (the sale is
          // recorded). finish() still resolves via the fallback timer below.
          return;
        }
        // Inject the admin-configured @page size and print. Fire-and-forget —
        // the result is intentionally ignored; failures still resolve via finish.
        void printReceiptWithSize(receipt.sizeSettings);
      };

      window.addEventListener("afterprint", finish);
      fallbackTimer = window.setTimeout(finish, AFTERPRINT_FALLBACK_MS);
      requestAnimationFrame(tryPrint);
    });
  }
}
