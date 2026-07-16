/**
 * KRS realtime SSE event types (krs-realtime-inbound P2) — ISOMORPHIC, TYPE-ONLY.
 *
 * ⚠️ This module must have ZERO runtime imports and export ONLY `type`/`interface`
 * declarations. It is intentionally shared by BOTH:
 *   - the NODE-ONLY in-memory bus (`src/lib/krs/events.ts`, `publishKrsEvent`), and
 *   - the CLIENT EventSource hook (`src/lib/useKrsEvents.ts`).
 * `events.ts` is NODE-ONLY (it is the server pub/sub), so the client CANNOT import
 * it — hence the payload contracts live here, in a runtime-free module both sides
 * can safely pull into their bundle.
 *
 * The discriminant `type` field doubles as the SSE `event:` name on the wire
 * (`event: stock-update\ndata: <json>\n\n`), so the client's
 * `addEventListener("stock-update", …)` name and this union stay in lockstep.
 */

/**
 * One product's post-reconcile stock in a `stock-update` broadcast.
 * `stock` is the GLOBAL `Product.stock` value (Σ per-warehouse, per plan D4).
 * `warehouse` is an OPTIONAL per-warehouse breakdown a warehouse-aware consumer
 * could pick its own slice from; the current `/pos` client patches by the global
 * `stock` (see the warehouse-scoping note in `src/lib/useKrsEvents.ts`).
 */
export type KrsStockUpdateItem = {
  sku: string;
  stock: number;
  warehouse?: { code: string; qty: number }[];
};

/** Stock changed for one or more skus after a KRS reconcile cycle. */
export type KrsStockUpdateEvent = {
  type: "stock-update";
  items: KrsStockUpdateItem[];
};

/**
 * Product master (name / price / active / image) changed for these skus — the
 * `/pos` client responds with a simple, rare full `/api/products` refetch rather
 * than a targeted field patch (kept simple on purpose; product edits are rare).
 */
export type KrsProductUpdateEvent = {
  type: "product-update";
  skus: string[];
};

/**
 * A reconcile cycle completed. Informational only (drives an optional "live"
 * indicator / the P3 status surface); carries no stock payload. `source`
 * distinguishes the realtime poller from the demoted full-reconcile safety net.
 */
export type KrsSyncStatusEvent = {
  type: "sync-status";
  source: "rt-poll" | "auto-sync";
  /** ISO-8601 instant the cycle finished. */
  at: string;
  itemsTouched: number;
};

/** The full SSE event union. `type` is both the discriminant and the wire event name. */
export type KrsEvent =
  | KrsStockUpdateEvent
  | KrsProductUpdateEvent
  | KrsSyncStatusEvent;

/** Every valid SSE event name (the `type` discriminant). */
export type KrsEventType = KrsEvent["type"];
