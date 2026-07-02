import { BrowserPrintService } from "./browserPrintService";
import { PrintAgentService } from "./printAgentService";
import type { ReceiptPrintService } from "./types";

// Public surface of the receipt-print-service abstraction.
export type { ReceiptData, ReceiptPrintService } from "./types";
export { BrowserPrintService } from "./browserPrintService";
export { PrintAgentService, type PrintAgentOptions } from "./printAgentService";

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
 * POST timeout (ms) for the ACTIVE agent print. The agent is on localhost, so
 * keep it short — a hung/dead agent must NEVER wedge checkout. Combined with
 * `failOpen: true` (a failed POST RESOLVES) and the call site resetting on both
 * resolve and reject, a broken agent can only cause a missing receipt, never a
 * stuck POS.
 */
const AGENT_PRINT_TIMEOUT_MS = 4000;

/**
 * Module-level cache of the SINGLE detection ping per page load. Holds the
 * in-flight OR settled promise so every caller (the POS mount effect, and the
 * per-checkout `resolveReceiptPrintService`) shares ONE `/health` round-trip and
 * we never re-ping. Reset only by a full page reload.
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
 * repeated calls within one page load reuse the first probe (single detection
 * per load).
 */
export async function detectPrintAgent(): Promise<boolean> {
  if (_detectPromise) return _detectPromise;
  _detectPromise = (async (): Promise<boolean> => {
    // SSR / no-fetch environment: the localhost agent is unreachable here.
    if (typeof window === "undefined" || typeof fetch === "undefined") {
      return false;
    }
    const controller =
      typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer =
      controller !== null && typeof setTimeout !== "undefined"
        ? setTimeout(() => controller.abort(), DETECTION_TIMEOUT_MS)
        : null;
    try {
      const res = await fetch(HEALTH_ENDPOINT, {
        method: "GET",
        signal: controller?.signal,
      });
      return res.ok === true;
    } catch {
      // Timeout/abort, connection refused, CORS/PNA rejection, DNS, etc.
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
