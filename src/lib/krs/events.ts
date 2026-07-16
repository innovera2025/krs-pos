// NODE-ONLY. In-memory KRS realtime event bus (krs-realtime-inbound P2).
//
// Pure in-process pub/sub — NO mssql, NO prisma, NO env imports. It exists solely
// to hand freshly-reconciled stock/product changes from a KRS poll cycle (the
// PUBLISHER: `src/lib/krs/stockReconcile.ts` / the ct-/rt-poll route — wired by the
// orchestrator at P1↔P2 join) to every connected `/pos` SSE stream (the
// SUBSCRIBERS: `src/app/api/events/route.ts`).
//
// ⚠️ SINGLE-INSTANCE ONLY (plan D7). This is an in-PROCESS bus. It fans out only to
// SSE clients served by THIS Node process. A multi-instance / multi-container deploy
// would need a shared broker (Redis pub/sub or equivalent) so a change reconciled on
// one instance reaches clients pinned to another. That is an EXPLICIT NON-GOAL: the
// app runs as one `app` container on a single Lightsail VPS (docker-compose.prod.yml).
// Do NOT assume this fans out across processes.
//
// FAIL-SAFE BY DESIGN: a lost broadcast (process restart mid-emit, a dropped SSE
// frame) is never a correctness bug — Postgres stays the source of truth and the
// `/pos` client's fetch-on-mount `/api/products` load is the authoritative fallback.
// A missed push only means the grid is briefly stale until the next event or refetch.

import type { KrsEvent } from "@/lib/krsEventTypes";

type KrsEventListener = (event: KrsEvent) => void;

// A plain Set (not node:events EventEmitter) is used deliberately: each open SSE
// connection registers one listener, and a busy shop can easily exceed EventEmitter's
// default `maxListeners` (10) — which would spew a spurious MaxListenersExceededWarning
// per extra cashier terminal. A Set has no such ceiling and gives an O(1) unsubscribe.
//
// The Set is stashed on globalThis so it survives BOTH dev hot-reload (which
// re-evaluates modules) AND any bundling that could otherwise hand the publisher
// route and the SSE subscriber route SEPARATE module instances — mirrors the
// singleton discipline in `src/lib/prisma.ts`. Stashing an empty Set on globalThis in
// production is harmless (no connections/secrets retained), so — unlike prisma's
// non-prod-only guard — it is stashed unconditionally to guarantee ONE shared bus.
const globalForKrsBus = globalThis as unknown as {
  krsEventBus: Set<KrsEventListener> | undefined;
};

const listeners: Set<KrsEventListener> =
  globalForKrsBus.krsEventBus ?? new Set<KrsEventListener>();

globalForKrsBus.krsEventBus = listeners;

/**
 * Broadcast one event to every currently-subscribed SSE stream. Synchronous,
 * non-blocking, best-effort: a throwing subscriber is swallowed so it can never
 * break the publish loop OR the KRS reconcile write path that called this. Never
 * awaited by any write path.
 *
 * ── EXACT one-liner(s) the orchestrator wires into P1 after join ──────────────
 * From `stockReconcile.ts`, after a successful/partial run, for the skus whose
 * `Product.stock` actually changed this cycle:
 *
 *   publishKrsEvent({
 *     type: "stock-update",
 *     items: changed.map((c) => ({ sku: c.sku, stock: c.newStock })),
 *   });
 *
 * When the product-refresh step ran (InventoryItem changed / scope=ALL):
 *
 *   publishKrsEvent({ type: "product-update", skus: refreshedSkus });
 *
 * At the end of each poll cycle (rt-poll route AND the demoted auto-sync safety net,
 * with `source` set accordingly):
 *
 *   publishKrsEvent({
 *     type: "sync-status",
 *     source: "rt-poll",           // or "auto-sync" from the demoted full reconcile
 *     at: new Date().toISOString(),
 *     itemsTouched,
 *   });
 */
export function publishKrsEvent(event: KrsEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A misbehaving subscriber must never break the broadcast or the KRS write
      // path that triggered it. Swallow and continue to the next listener.
    }
  }
}

/**
 * Register an SSE stream's forwarder. Returns an idempotent unsubscribe function the
 * caller MUST invoke on client disconnect (`request.signal` abort) so listeners never
 * leak across reconnects.
 */
export function subscribeKrsEvents(listener: KrsEventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Current subscriber count — diagnostics only (e.g. a future status readout). */
export function krsEventSubscriberCount(): number {
  return listeners.size;
}
