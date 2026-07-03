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

/** Cap on `document.fonts.ready` — a font that never settles must not wedge print. */
const FONTS_READY_TIMEOUT_MS = 3000;

/** Cap on the html2canvas dynamic import — a stalled chunk fetch must not wedge print. */
const IMPORT_TIMEOUT_MS = 8000;

/**
 * Console breadcrumb for remote print-debugging: every step of the capture →
 * render → POST chain logs one line, so a screenshot of the DevTools console
 * shows exactly where a silent print died. info-level (not error) — these are
 * expected-flow markers, not failures.
 */
function mark(step: string): void {
  if (typeof console !== "undefined") console.info(`[krs-print] ${step}`);
}

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
    // Dynamic import keeps html2canvas out of the SSR/server graph. Raced
    // against a timeout — a stalled chunk fetch pends forever otherwise.
    mark("html2canvas: loading");
    const mod = await Promise.race([
      import("html2canvas"),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), IMPORT_TIMEOUT_MS)
      ),
    ]);
    if (!mod) {
      mark("html2canvas: LOAD TIMEOUT — skip print");
      return null;
    }
    const html2canvas = mod.default;

    // Wait for the app's web fonts (IBM Plex Sans/Mono Thai) so Thai renders as
    // real glyphs — not a fallback box — before we rasterize. Best-effort AND
    // time-capped: `document.fonts.ready` never settling must not wedge print.
    if (
      typeof document.fonts !== "undefined" &&
      typeof document.fonts.ready?.then === "function"
    ) {
      mark("fonts: waiting");
      await Promise.race([
        document.fonts.ready.catch(() => undefined),
        new Promise<void>((resolve) =>
          setTimeout(resolve, FONTS_READY_TIMEOUT_MS)
        ),
      ]);
    }
    mark("fonts: done");

    // Scale the ~330px CSS-wide receipt up to the 576px raster target.
    const rect = element.getBoundingClientRect();
    const cssWidth = rect.width || element.offsetWidth || 330;
    const scale = cssWidth > 0 ? targetWidthPx / cssWidth : 1;

    mark(`render: start (css ${Math.round(cssWidth)}px, scale ${scale.toFixed(2)})`);
    const t0 = performance.now();
    const canvas = await html2canvas(element, {
      backgroundColor: "#ffffff",
      scale,
      logging: false,
      useCORS: true,
    });
    mark(
      `render: done ${canvas.width}x${canvas.height} in ${Math.round(performance.now() - t0)}ms`
    );

    const dataUrl = canvas.toDataURL("image/png");
    const comma = dataUrl.indexOf(",");
    return comma >= 0 ? dataUrl.slice(comma + 1) : null;
  } catch (err) {
    mark(`render: FAILED — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * The full agent IMAGE-print path: wait for the receipt paper, rasterize it to a
 * PNG, and POST it to the local agent's `/print-image` endpoint.
 *
 * ALWAYS RESOLVES (fail-open): a paper that never mounts, a render failure, or a
 * dead/hung agent are all swallowed. Resolves `true` only when the agent
 * ACCEPTED the print job — `false` on any skipped/failed step, so the caller
 * can tell the cashier the receipt did NOT print (and still reset to a fresh
 * sale either way).
 */
export async function captureAndPrintReceiptImage(
  opts: {
    selector?: string;
    targetWidthPx?: number;
    timeoutMs?: number;
    maxFrames?: number;
  } = {}
): Promise<boolean> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return false;
  }
  const selector = opts.selector ?? RECEIPT_SELECTOR;
  const targetWidthPx = opts.targetWidthPx ?? RECEIPT_IMAGE_WIDTH_PX;
  const timeoutMs = opts.timeoutMs ?? IMAGE_PRINT_TIMEOUT_MS;
  const maxFrames = opts.maxFrames ?? MAX_FRAMES;

  try {
    mark("capture: start");
    const element = await waitForElement(selector, maxFrames);
    // Paper never mounted within budget: skip printing (the sale is recorded).
    if (!element) {
      mark("capture: paper never mounted — skip print");
      return false;
    }

    const pngBase64 = await renderElementToPngBase64(element, targetWidthPx);
    // Render failed: skip printing, fail-open.
    if (!pngBase64) return false;

    // failOpen:false here ON PURPOSE: this whole function is the fail-open
    // boundary (try/catch below), and we need the throw to know the job was NOT
    // accepted so the caller can show "print failed" instead of silence.
    mark("post: sending to agent");
    const agent = new PrintAgentService({ failOpen: false, timeoutMs });
    await agent.printReceiptImage(pngBase64);
    mark("post: agent accepted the job");
    return true;
  } catch (err) {
    // Never throw — a broken image print must not wedge checkout.
    mark(`post: FAILED — ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
