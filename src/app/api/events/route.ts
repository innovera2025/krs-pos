import { requireUser } from "@/lib/auth";
import { subscribeKrsEvents } from "@/lib/krs/events";
import type { KrsEvent } from "@/lib/krsEventTypes";

/**
 * GET /api/events — Server-Sent Events stream of live KRS stock/product pushes
 * (krs-realtime-inbound P2).
 *
 * AUTH: `requireUser` — every signed-in role (cashiers included) needs this; it is a
 * read-only, non-sensitive live-update feed for the same audience as GET /api/products.
 *
 * TRANSPORT: a Next.js 14 route handler returning a `ReadableStream` framed as SSE:
 *   `event: <type>\ndata: <json>\n\n` per event, plus a `: ping\n\n` heartbeat comment
 * every 25s so idle proxies / load balancers don't reap the connection. Headers pin
 * `text/event-stream`, disable caching/transform, and set `X-Accel-Buffering: no` so
 * Caddy/nginx-style reverse proxies flush each chunk instead of buffering the stream.
 *
 * LIFECYCLE: on connect it subscribes to the in-process bus (`src/lib/krs/events.ts`);
 * on client disconnect (`request.signal` abort) it clears the heartbeat, unsubscribes,
 * and closes the controller — every subscribe path has exactly one unsubscribe, so no
 * listener or interval leaks across reconnects. Single-instance only (see events.ts).
 *
 * NEVER blocks a write path: this endpoint only READS from the bus; the reconcile
 * publisher fire-and-forgets into it and never awaits a subscriber.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Heartbeat cadence — a comment line keeps intermediaries from idling the stream out. */
const HEARTBEAT_MS = 25_000;

/**
 * Defensive per-event payload cap. A single reconcile broadcast is small (even a
 * full-catalog run is tens of KB), so 256KB is generous headroom; a pathologically
 * large frame is DROPPED rather than forwarded (it would blow client/proxy buffers).
 * The `/pos` fetch-on-mount fallback still reconciles correctness if a drop happens.
 */
const MAX_EVENT_BYTES = 256 * 1024;

export async function GET(req: Request) {
  const gate = await requireUser();
  if ("response" in gate) return gate.response;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      // Enqueue guarded against a controller already closed by a racing abort/close.
      const safeEnqueue = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The client vanished between the closed-check and the write — treat the
          // stream as closed so nothing else tries to enqueue.
          closed = true;
        }
      };

      // Open the stream immediately with a comment so headers flush through proxies
      // and the client's `open` fires without waiting for the first real event.
      safeEnqueue(": connected\n\n");

      const unsubscribe = subscribeKrsEvents((event: KrsEvent) => {
        const data = JSON.stringify(event);
        if (data.length > MAX_EVENT_BYTES) return; // drop oversized frame
        safeEnqueue(`event: ${event.type}\ndata: ${data}\n\n`);
      });

      const heartbeat = setInterval(() => {
        safeEnqueue(": ping\n\n");
      }, HEARTBEAT_MS);

      // Single cleanup choke point — idempotent, runs on client disconnect.
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed by the runtime — nothing to do.
        }
      };

      // If the request was already aborted before we registered, adding an abort
      // listener would never fire — clean up now. Otherwise clean up on disconnect.
      if (req.signal.aborted) {
        cleanup();
      } else {
        req.signal.addEventListener("abort", cleanup, { once: true });
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
