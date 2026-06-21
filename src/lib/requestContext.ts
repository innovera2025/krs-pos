import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * Per-request correlation context (Phase 3 observability — D1).
 *
 * ⚠️ NODE-ONLY. This module imports `node:async_hooks` + `node:crypto`, which do
 * NOT exist in the Edge runtime. It must NEVER be imported from an Edge module
 * (`src/middleware.ts`, `src/auth.config.ts`) or any client component — doing so
 * would break the edge-safe split. The request id originates in the (edge-safe)
 * middleware via the `x-request-id` request header; this Node-side helper merely
 * reads that header (or mints a fallback) and stashes it in AsyncLocalStorage so
 * the pino logger's `mixin()` can attach it to every log line automatically.
 *
 * Pure Node stdlib — no third-party deps.
 */

/** The shape carried for the lifetime of one request. */
type RequestStore = { requestId: string };

/**
 * Process-wide AsyncLocalStorage singleton. Every log line emitted while inside
 * `runWithRequestId(...)` can read the active `requestId` via `getRequestId()`
 * (used by the logger's mixin), so logs are correlated without threading the id
 * through every function signature.
 */
const als = new AsyncLocalStorage<RequestStore>();

/**
 * Run `fn` with a request id bound to the current async context.
 *
 * The id is read from the incoming `x-request-id` header (set by the edge
 * middleware, which itself reuses an inbound id or mints one). When the header is
 * absent (e.g. a direct call that bypassed middleware, or a route the matcher
 * does not cover) a fresh UUID is generated so every request always has an id.
 *
 * Wrap a route handler BODY in this call; all existing logic runs unchanged
 * inside `fn`, and any logger line emitted within it auto-includes the id.
 */
export function runWithRequestId<T>(
  req: Request,
  fn: () => T | Promise<T>
): T | Promise<T> {
  const incoming = req.headers.get("x-request-id");
  const requestId =
    incoming && incoming.length > 0 ? incoming : randomUUID();
  return als.run({ requestId }, fn);
}

/**
 * The request id for the active async context, or `undefined` when called
 * outside any `runWithRequestId(...)` scope (e.g. at server boot). The logger's
 * mixin coalesces `undefined` to an empty object so a boot-time log line is still
 * valid JSON without a `requestId` field.
 */
export function getRequestId(): string | undefined {
  return als.getStore()?.requestId;
}
