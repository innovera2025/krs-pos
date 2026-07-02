import type { LocalFetchInit } from "./localFetch";
import type { ReceiptData, ReceiptPrintService } from "./types";

/**
 * PrintAgentService — FUTURE silent-print backend (documented, NOT wired by
 * default; see `getReceiptPrintService`).
 *
 * Targets a LOCAL PRINT AGENT: a tiny HTTP bridge running on the cashier machine
 * (default `http://localhost:9100/print-receipt`) that receives the receipt
 * payload as JSON and drives a thermal printer via raw ESC/POS — so the receipt
 * prints with NO browser print dialog. That is the whole point of this backend:
 * today's `window.print()` path (BrowserPrintService) pops a Chrome dialog
 * unless Chrome is launched with `--kiosk-printing`; the local agent removes the
 * dialog entirely.
 *
 * Enable later by returning this from `getReceiptPrintService()` — e.g. gated on
 * a detected localhost agent, a ShopSettings flag, or an env var. The POS confirm
 * flow does NOT change: it depends only on `ReceiptPrintService`.
 */

/** Default local ESC/POS bridge endpoint (TEXT/JSON receipt payload). */
const DEFAULT_ENDPOINT = "http://localhost:9100/print-receipt";

/**
 * Default local ESC/POS bridge endpoint for the IMAGE receipt path
 * (pos-receipt-image): the browser rasterizes the receipt DOM (incl. Thai) to a
 * PNG and POSTs it here; the agent prints it as a raster (no printer font, so
 * Thai always prints correctly). Same host/port as {@link DEFAULT_ENDPOINT}.
 */
const DEFAULT_IMAGE_ENDPOINT = "http://localhost:9100/print-image";

/** Default POST timeout (ms). The agent is on localhost, so keep it short. */
const DEFAULT_TIMEOUT_MS = 4000;

export interface PrintAgentOptions {
  /** Print-agent endpoint. Defaults to the local ESC/POS bridge. */
  endpoint?: string;
  /**
   * Image print-agent endpoint (pos-receipt-image). Defaults to the local
   * ESC/POS bridge's `/print-image`. The browser POSTs a rendered receipt PNG
   * here so Thai (rasterized by the browser) always prints correctly.
   */
  imageEndpoint?: string;
  /** Abort the POST after this many ms (the agent is local → short). */
  timeoutMs?: number;
  /**
   * When true, a network/agent failure RESOLVES instead of rejecting, so a dead
   * agent never blocks the cashier from starting a new sale. Defaults to false
   * (throw) so the caller can decide whether to surface the error or fall back
   * to the browser path.
   */
  failOpen?: boolean;
}

export class PrintAgentService implements ReceiptPrintService {
  private readonly endpoint: string;
  private readonly imageEndpoint: string;
  private readonly timeoutMs: number;
  private readonly failOpen: boolean;

  constructor(options: PrintAgentOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.imageEndpoint = options.imageEndpoint ?? DEFAULT_IMAGE_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.failOpen = options.failOpen ?? false;
  }

  async printReceipt(receipt: ReceiptData): Promise<void> {
    // No fetch in this environment (SSR without a polyfill) — nothing to do.
    if (typeof fetch === "undefined") {
      if (this.failOpen) return;
      throw new Error(
        "PrintAgentService: fetch is unavailable in this environment"
      );
    }

    // Bound the request so a hung/missing agent can't stall checkout.
    const controller =
      typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer =
      controller !== null && typeof setTimeout !== "undefined"
        ? setTimeout(() => controller.abort(), this.timeoutMs)
        : null;

    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The local agent renders the ESC/POS job from this payload.
        body: JSON.stringify(receipt),
        signal: controller?.signal,
        // Chrome Local Network Access: opt in to the loopback agent so a public
        // HTTPS page is allowed to POST to http://localhost:9100 over HTTP.
        targetAddressSpace: "private",
      } as LocalFetchInit);
      if (!res.ok) {
        throw new Error(`PrintAgentService: agent responded ${res.status}`);
      }
    } catch (err) {
      // Network error, timeout/abort, or non-OK status.
      if (this.failOpen) return;
      throw err instanceof Error
        ? err
        : new Error("PrintAgentService: print request failed");
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /**
   * IMAGE receipt path (pos-receipt-image): POST a base64 PNG (black content on a
   * WHITE background, ~576 px wide = 80mm printable width) to the agent's
   * `/print-image` endpoint. The agent decodes it, thresholds to 1-bit, and prints
   * it as an ESC/POS raster — needing NO printer font, so Thai (rendered by the
   * browser) always prints correctly.
   *
   * Mirrors {@link printReceipt}'s guards/timeout/fail-open semantics exactly: a
   * missing fetch, a hung/dead agent, or a non-OK status RESOLVES when
   * `failOpen` is set, so a broken image print can never wedge checkout.
   *
   * @param imagePngBase64 Base64 PNG WITHOUT the `data:image/png;base64,` prefix.
   */
  async printReceiptImage(imagePngBase64: string): Promise<void> {
    // No fetch in this environment (SSR without a polyfill) — nothing to do.
    if (typeof fetch === "undefined") {
      if (this.failOpen) return;
      throw new Error(
        "PrintAgentService: fetch is unavailable in this environment"
      );
    }

    // Bound the request so a hung/missing agent can't stall checkout.
    const controller =
      typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer =
      controller !== null && typeof setTimeout !== "undefined"
        ? setTimeout(() => controller.abort(), this.timeoutMs)
        : null;

    try {
      const res = await fetch(this.imageEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The agent decodes this PNG and prints it as an ESC/POS raster.
        body: JSON.stringify({ imagePngBase64 }),
        signal: controller?.signal,
        // Chrome Local Network Access: opt in to the loopback agent so a public
        // HTTPS page is allowed to POST to http://localhost:9100 over HTTP.
        targetAddressSpace: "private",
      } as LocalFetchInit);
      if (!res.ok) {
        throw new Error(`PrintAgentService: agent responded ${res.status}`);
      }
    } catch (err) {
      // Network error, timeout/abort, or non-OK status.
      if (this.failOpen) return;
      throw err instanceof Error
        ? err
        : new Error("PrintAgentService: image print request failed");
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
}
