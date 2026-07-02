import { PrintAgentService } from "./printAgentService";

/**
 * Agent IMAGE-print path (pos-receipt-image).
 *
 * The thermal print agent's TEXT path (`/print-receipt`) depends on the printer's
 * built-in Thai code table, which is firmware-specific and unreliable on cheap
 * ESC/POS clones. This module sidesteps that entirely: it rasterizes the SAME
 * on-screen `.print-receipt` DOM in the BROWSER — where Thai is drawn with the
 * app's own web font, so the glyphs are always correct — into a PNG, then POSTs
 * that PNG to the agent's `/print-image` endpoint. The agent prints it as an
 * ESC/POS raster (dots, no font), so Thai always prints correctly on any printer.
 *
 * Everything here is FAIL-OPEN: SSR, a missing element, an html2canvas failure,
 * or a dead/slow agent all RESOLVE (never throw), so a broken image print can only
 * ever cause a MISSING receipt — never a wedged checkout. The sale is already
 * recorded before any of this runs.
 */

/**
 * Target raster width in device pixels. 576 px = the standard 80mm printable
 * width (72mm) on an ESC/POS printer at 203 dpi, so the printed image lands at
 * ~1:1 on the paper. The `.print-receipt` DOM is ~330 CSS px wide, so html2canvas
 * is scaled up to hit this width (see {@link renderElementToPngBase64}).
 */
export const RECEIPT_IMAGE_WIDTH_PX = 576;

/** Default selector for the receipt paper mounted by <ReceiptModal captureMode/>. */
const RECEIPT_SELECTOR = ".print-receipt";

/** rAF budget to wait for the receipt paper to mount (~1s of frames at 60fps). */
const MAX_FRAMES = 60;

/**
 * Image POST timeout (ms). Larger than the text path's because the agent decodes
 * the PNG, thresholds it, and spools a raster — still bounded so a hung/dead agent
 * can never wedge checkout (combined with fail-open + reset-on-settle at the call
 * site).
 */
const IMAGE_PRINT_TIMEOUT_MS = 8000;

/**
 * rAF-wait until `selector` is present in the DOM (the receipt paper is mounted by
 * the parent one render after `open` flips). Resolves the element, or `null` if it
 * never mounts within the frame budget.
 */
function waitForElement(
  selector: string,
  maxFrames: number
): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    let frames = 0;
    const tick = () => {
      const el = document.querySelector<HTMLElement>(selector);
      if (el) {
        resolve(el);
        return;
      }
      if (frames >= maxFrames) {
        resolve(null);
        return;
      }
      frames += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * Render a DOM element to a base64 PNG (WITHOUT the `data:image/png;base64,`
 * prefix) on a WHITE background, scaled so the output is ~{@link targetWidthPx}
 * wide. Client-only: html2canvas is dynamically imported so it never lands in the
 * server bundle, and any failure (SSR, render error) RESOLVES to `null`.
 */
export async function renderElementToPngBase64(
  element: HTMLElement,
  targetWidthPx = RECEIPT_IMAGE_WIDTH_PX
): Promise<string | null> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return null;
  }
  try {
    // Dynamic import keeps html2canvas out of the SSR/server graph.
    const html2canvas = (await import("html2canvas")).default;

    // Wait for the app's web fonts (IBM Plex Sans/Mono Thai) so Thai renders as
    // real glyphs — not a fallback box — before we rasterize. Best-effort.
    if (
      typeof document.fonts !== "undefined" &&
      typeof document.fonts.ready?.then === "function"
    ) {
      try {
        await document.fonts.ready;
      } catch {
        /* ignore — proceed with whatever fonts are available */
      }
    }

    // Scale the ~330px CSS-wide receipt up to the 576px raster target.
    const rect = element.getBoundingClientRect();
    const cssWidth = rect.width || element.offsetWidth || 330;
    const scale = cssWidth > 0 ? targetWidthPx / cssWidth : 1;

    const canvas = await html2canvas(element, {
      backgroundColor: "#ffffff",
      scale,
      logging: false,
      useCORS: true,
    });

    const dataUrl = canvas.toDataURL("image/png");
    const comma = dataUrl.indexOf(",");
    return comma >= 0 ? dataUrl.slice(comma + 1) : null;
  } catch {
    return null;
  }
}

/**
 * The full agent IMAGE-print path: wait for the receipt paper, rasterize it to a
 * PNG, and POST it to the local agent's `/print-image` endpoint.
 *
 * ALWAYS RESOLVES (fail-open): a paper that never mounts, a render failure, or a
 * dead/hung agent are all swallowed. The caller wires `backToNewSale` to both
 * resolve and reject so the POS always returns to a fresh sale.
 */
export async function captureAndPrintReceiptImage(
  opts: {
    selector?: string;
    targetWidthPx?: number;
    timeoutMs?: number;
    maxFrames?: number;
  } = {}
): Promise<void> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }
  const selector = opts.selector ?? RECEIPT_SELECTOR;
  const targetWidthPx = opts.targetWidthPx ?? RECEIPT_IMAGE_WIDTH_PX;
  const timeoutMs = opts.timeoutMs ?? IMAGE_PRINT_TIMEOUT_MS;
  const maxFrames = opts.maxFrames ?? MAX_FRAMES;

  try {
    const element = await waitForElement(selector, maxFrames);
    // Paper never mounted within budget: skip printing (the sale is recorded).
    if (!element) return;

    const pngBase64 = await renderElementToPngBase64(element, targetWidthPx);
    // Render failed: skip printing, fail-open.
    if (!pngBase64) return;

    const agent = new PrintAgentService({ failOpen: true, timeoutMs });
    await agent.printReceiptImage(pngBase64);
  } catch {
    // Never throw — a broken image print must not wedge checkout.
  }
}
