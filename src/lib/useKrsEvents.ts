"use client";

import { useEffect, useRef } from "react";
import type { KrsStockUpdateItem } from "@/lib/krsEventTypes";

/**
 * `/pos` client subscription to the KRS realtime SSE feed (krs-realtime-inbound P2).
 *
 * Opens a single `EventSource("/api/events")` for the component's lifetime (the
 * browser sends the same-origin NextAuth session cookie automatically — no extra
 * credentials wiring) and routes named events to the caller's handlers:
 *   - `stock-update`  → `onStockUpdate(items)` — patch the grid in place by sku.
 *   - `product-update`→ `onProductUpdate(skus)` — a rare full `/api/products` refetch.
 *   - `sync-status`   → ignored here (P3's admin status surface owns it).
 *
 * ⚠️ WAREHOUSE-SCOPING NOTE: `KrsStockUpdateItem.stock` is the GLOBAL `Product.stock`.
 * For a warehouse-ASSIGNED user, GET /api/products overrides display stock with that
 * warehouse's on-hand server-side, so patching by the global `stock` can briefly
 * diverge from the warehouse figure until the next `product-update` refetch /
 * navigation. That is an eventual-consistency display nuance (never a checkout-
 * correctness issue) flagged for the P1↔P2 wiring decision (publish per-warehouse-
 * resolved stock, or make the client warehouse-aware) — not resolved in this hook.
 *
 * RECONNECT: EventSource auto-reconnects on its own, but we take EXPLICIT control so
 * the backoff is capped-exponential (1s → 30s) and a permanently-dead endpoint can't
 * hot-spin: on `error` we close the socket and reschedule with a doubling delay,
 * resetting to 1s once a connection re-opens healthily. Torn down fully on unmount.
 */

type KrsEventHandlers = {
  onStockUpdate: (items: KrsStockUpdateItem[]) => void;
  onProductUpdate: (skus: string[]) => void;
};

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export function useKrsEvents(handlers: KrsEventHandlers): void {
  // Keep the latest handlers in a ref so the effect can run ONCE (stable connection)
  // without reconnecting every render when the caller passes inline callbacks.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (typeof EventSource === "undefined") return; // SSR / unsupported env

    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoff = INITIAL_BACKOFF_MS;
    let disposed = false; // set on unmount — stops any further reconnect scheduling

    const connect = (): void => {
      if (disposed) return;
      const source = new EventSource("/api/events");
      es = source;

      source.addEventListener("open", () => {
        backoff = INITIAL_BACKOFF_MS; // healthy connection → reset the backoff
      });

      source.addEventListener("stock-update", (ev) => {
        try {
          const parsed = JSON.parse((ev as MessageEvent).data) as {
            items?: KrsStockUpdateItem[];
          };
          if (Array.isArray(parsed.items)) {
            handlersRef.current.onStockUpdate(parsed.items);
          }
        } catch {
          /* ignore a malformed frame — the next event / refetch self-corrects */
        }
      });

      source.addEventListener("product-update", (ev) => {
        try {
          const parsed = JSON.parse((ev as MessageEvent).data) as {
            skus?: string[];
          };
          handlersRef.current.onProductUpdate(
            Array.isArray(parsed.skus) ? parsed.skus : []
          );
        } catch {
          /* ignore a malformed frame */
        }
      });

      source.addEventListener("error", () => {
        // Take over the reconnect ourselves: close this socket (stopping the browser's
        // own fixed-interval retry) and reschedule with capped-exponential backoff.
        source.close();
        if (es === source) es = null;
        if (disposed) return;
        if (reconnectTimer !== null) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      });
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      if (es !== null) es.close();
    };
  }, []);
}
