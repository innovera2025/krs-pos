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
 * WAREHOUSE-SCOPING (RESOLVED 17-07-26): `KrsStockUpdateItem.stock` is the GLOBAL
 * `Product.stock`, but each item ALSO carries an optional per-warehouse `warehouse`
 * breakdown (`{ code, qty }[]`) for the warehouses that moved this cycle. GET /api/products
 * overrides display stock with the signed-in user's warehouse on-hand server-side, and the
 * `/pos` patch handler (`patchStockBySku`) now MIRRORS that convention: a warehouse-ASSIGNED
 * user patches from the breakdown row matching their `warehouseCode` when present, and an
 * UNASSIGNED user (or an item with no breakdown for that warehouse) falls back to the global
 * `stock`. This keeps a warehouse-scoped screen from flipping to the global figure on a live
 * push (the previous off-by-one until the next refetch). Postgres + the mount fetch remain the
 * authoritative fallback; a dropped frame is still only ever an eventual-consistency nuance.
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
