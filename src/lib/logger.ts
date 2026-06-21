import pino from "pino";
import { getRequestId } from "@/lib/requestContext";

/**
 * Structured application logger (Phase 3 observability — D2 + D4).
 *
 * ⚠️ NODE-ONLY. `pino` is a Node logging library; it must NEVER be imported from
 * an Edge module (`src/middleware.ts`, `src/auth.config.ts`) or a client
 * component. The edge middleware does its own (edge-safe) `crypto.randomUUID()`
 * for the `x-request-id` header and never touches this module.
 *
 * D4 — standalone-safe transport: this logger does NOT configure an in-process
 * pino `transport: {...}`. A transport spawns a worker thread, which breaks Next's
 * `output: "standalone"` file tracing (the worker entrypoint is not traced into
 * the standalone bundle). Instead we write raw JSON to stdout in ALL environments.
 * For human-readable dev output, pipe through pino-pretty via the `dev:pretty`
 * npm script (`next dev | pino-pretty`) — pino-pretty is a devDependency used
 * only across that pipe, never required in-process, so the production standalone
 * image stays clean and worker-free.
 */

/**
 * Log level from the environment. Defaults to "info"; "debug" in development so
 * local runs are chattier without changing production verbosity. Read directly
 * from `process.env` (not the validated `env` module) to avoid coupling the
 * logger to env validation — a bad LOG_LEVEL simply falls back to the NODE_ENV
 * default rather than failing boot.
 */
function resolveLevel(): string {
  const explicit = process.env.LOG_LEVEL;
  if (explicit && explicit.length > 0) return explicit;
  return process.env.NODE_ENV === "development" ? "debug" : "info";
}

export const logger = pino({
  level: resolveLevel(),
  // Minimal base: keep the standard pid/hostname only. The per-line requestId is
  // attached by the mixin below (not base) so it reflects the ACTIVE async
  // context at log time, not a value captured once at logger construction.
  base: { pid: process.pid },
  // Redaction (D2): strip secrets/PII from any logged object before it is
  // serialized. Covers password/secret anywhere in the tree, the Authorization +
  // Cookie request headers (via the `err`/`req` serializers or explicit objects),
  // and Thai-tax PII (taxId/phone). Paths use pino's wildcard syntax.
  redact: [
    "*.password",
    "*.secret",
    "req.headers.authorization",
    "req.headers.cookie",
    "*.taxId",
    "*.phone",
  ],
  // mixin (D2): every log line auto-includes the active request's correlation id
  // pulled from AsyncLocalStorage. Outside a request scope getRequestId() returns
  // undefined → emit {} so the line is still valid JSON with no requestId field.
  mixin() {
    const requestId = getRequestId();
    return requestId ? { requestId } : {};
  },
});
