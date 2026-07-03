import { BrowserPrintService } from "./browserPrintService";
import type { LocalFetchInit } from "./localFetch";
import { PrintAgentService } from "./printAgentService";
import type { ReceiptPrintService } from "./types";

// Public surface of the receipt-print-service abstraction.
export type { ReceiptData, ReceiptPrintService } from "./types";
export { BrowserPrintService } from "./browserPrintService";
export { PrintAgentService, type PrintAgentOptions } from "./printAgentService";
// Agent IMAGE-print path (pos-receipt-image): browser-rasterized receipt PNG →
// local agent /print-image, so Thai always prints correctly (raster, no font).
export {
  captureAndPrintReceiptImage,
  renderElementToPngBase64,
  RECEIPT_IMAGE_WIDTH_PX,
} from "./receiptImage";

/**
 * Health endpoint of the LOCAL print agent (same host/port as the ESC/POS
 * bridge, `/print-receipt`). A plain string constant — the web app never imports
 * anything from the agent package.
 */
const HEALTH_ENDPOINT = "http://localhost:9100/health";

/**
 * Detection ping timeout (ms). Chrome/Edge send a Private Network Access OPTIONS
 * preflight before the GET, so this budget must cover BOTH the preflight and the
 * GET round-trip. 1500 ms is comfortably over a localhost round-trip; a miss
 * (agent absent) simply times out and falls back to the browser path.
 */
const DETECTION_TIMEOUT_MS = 1500;

/**
 * Print-time (`fresh: true`) probe timeout (ms). Longer than the mount probe ON
 * PURPOSE: the fresh probe fires right after checkout, when a weak shop PC is
 * busy re-rendering the 2000+ product grid (especially after a barcode-scan
 * sale clears the search filter). A busy main thread delays processing the
 * /health response past the timer, so a short timeout falsely aborts a fetch
 * that actually succeeded — observed live: "detect: NO agent — AbortError"
 * one line after "detect: agent FOUND" → wrong window.print fallback.
 */
const FRESH_DETECTION_TIMEOUT_MS = 3500;

/**
 * Last SETTLED probe result. Used to rescue a TIMED-OUT fresh probe: an abort
 * on a busy main thread says nothing about the agent (see
 * FRESH_DETECTION_TIMEOUT_MS above), so if the agent was seen alive by the most
 * recent completed probe, keep trusting it. A genuine refusal (connection
 * refused / CORS / non-2xx) still records `false` and wins.
 */
let _lastSettledResult: boolean | null = null;

/**
 * POST timeout (ms) for the ACTIVE agent print. The agent is on localhost, so
 * keep it short — a hung/dead agent must NEVER wedge checkout. Combined with
 * `failOpen: true` (a failed POST RESOLVES) and the call site resetting on both
 * resolve and reject, a broken agent can only cause a missing receipt, never a
 * stuck POS.
 */
const AGENT_PRINT_TIMEOUT_MS = 4000;

/**
 * Module-level cache of the LATEST detection ping. Holds the in-flight OR
 * settled promise so every caller (the POS mount effect, and the per-checkout
 * `resolveReceiptPrintService`) shares ONE `/health` round-trip per probe and
 * we never re-ping implicitly. Replaced only by a `{ fresh: true }` re-probe
 * (checkout print time) or a full page reload.
 */
let _detectPromise: Promise<boolean> | null = null;

/**
 * Detect whether the local print agent is reachable. Pings `GET /health` with a
 * bounded {@link DETECTION_TIMEOUT_MS} AbortController timeout and resolves
 * `true` only when the agent answers with a 2xx. ANY other outcome — timeout,
 * connection refused, CORS / PNA block, non-OK status, missing fetch, SSR —
 * resolves `false` (fail-open to the browser path).
 *
 * NEVER throws or rejects. The result is memoised in {@link _detectPromise} so
 * repeated calls within one page load reuse the latest probe. Pass
 * `{ fresh: true }` to start a NEW probe (e.g. at print time, so an agent
 * started/stopped after page load is seen); the new probe REPLACES the cache
 * before it settles, so concurrent callers share it and later cached reads see
 * the latest result.
 */
export async function detectPrintAgent(options?: {
  fresh?: boolean;
}): Promise<boolean> {
  if (!options?.fresh && _detectPromise) return _detectPromise;
  const timeoutMs = options?.fresh
    ? FRESH_DETECTION_TIMEOUT_MS
    : DETECTION_TIMEOUT_MS;
  _detectPromise = (async (): Promise<boolean> => {
    // SSR / no-fetch environment: the localhost agent is unreachable here.
    if (typeof window === "undefined" || typeof fetch === "undefined") {
      return false;
    }
    const controller =
      typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer =
      controller !== null && typeof setTimeout !== "undefined"
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null;
    try {
      const res = await fetch(HEALTH_ENDPOINT, {
        method: "GET",
        signal: controller?.signal,
        // Chrome Local Network Access: localhost is address space "loopback"
        // ("private"/"local" = LAN and gets BLOCKED here — see localFetch.ts).
        targetAddressSpace: "loopback",
      } as LocalFetchInit);
      // Breadcrumb for remote print-debugging (see receiptImage.ts `mark`).
      console.info(`[krs-print] detect: ${res.ok ? "agent FOUND" : `agent answered ${res.status}`}`);
      _lastSettledResult = res.ok === true;
      return res.ok === true;
    } catch (err) {
      const isAbort =
        (err instanceof DOMException || err instanceof Error) &&
        err.name === "AbortError";
      // A timed-out probe on a busy main thread is NOT evidence the agent is
      // gone — if the last completed probe saw it alive, keep trusting that
      // instead of dropping into the window.print fallback (which pops the
      // Chrome print dialog). Genuine refusals (connection refused, CORS,
      // non-2xx) take the `false` path below and overwrite the memory.
      if (isAbort && _lastSettledResult === true) {
        console.info(
          "[krs-print] detect: probe timed out on a busy thread — keeping last known GOOD result (agent assumed present)"
        );
        return true;
      }
      console.info(
        `[krs-print] detect: NO agent — ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`
      );
      if (!isAbort) _lastSettledResult = false;
      return false;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  })();
  return _detectPromise;
}

/**
 * Resolve the ACTIVE receipt-print backend for THIS checkout: the silent local
 * ESC/POS {@link PrintAgentService} when {@link detectPrintAgent} reports the
 * agent is present, otherwise the {@link BrowserPrintService} fallback.
 *
 * NEVER rejects — detection is fail-open, so any failure yields the browser
 * backend. Detection is cached, so calling this per checkout costs no extra
 * network round-trip after the first probe. The returned agent instance is
 * configured with `failOpen: true` and a short {@link AGENT_PRINT_TIMEOUT_MS}
 * timeout so a dead/hung agent can never block the cashier from a new sale.
 */
export async function resolveReceiptPrintService(): Promise<ReceiptPrintService> {
  const agentAvailable = await detectPrintAgent();
  return agentAvailable
    ? new PrintAgentService({
        failOpen: true,
        timeoutMs: AGENT_PRINT_TIMEOUT_MS,
      })
    : new BrowserPrintService();
}

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
