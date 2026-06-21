import { NextResponse } from "next/server";
import type { z } from "zod";

/**
 * Shared request-body validation helpers (production-readiness Phase 1, theme #3).
 *
 * ⚠️ NODE-ONLY SERVER MODULES. The schemas in this directory use `z.nativeEnum`
 * over `@prisma/client` enums and are imported only from route handlers (Node
 * runtime). Do NOT import them from a client component, `src/auth.config.ts`, or
 * `src/middleware.ts` — that would pull Prisma into the edge/client bundle.
 *
 * Contract: validation failures return the SAME `{ error, code }` shape the rest
 * of the API uses, with `code: "VALIDATION"` and a CONCISE `issues` array so the
 * client can surface field-level messages without us leaking a huge Zod dump.
 */

/** A trimmed-down view of a Zod issue — path + message only (no internals). */
export type ConciseIssue = { path: string; message: string };

/** Reduce Zod issues to `{ path, message }` (concise; never the full Zod object). */
export function conciseIssues(error: z.ZodError): ConciseIssue[] {
  return error.issues.map((i) => ({
    path: i.path.join("."),
    message: i.message,
  }));
}

/**
 * Validate `data` against `schema`. On success returns `{ data }`. On failure
 * returns `{ response }` carrying a ready-to-return 400 in the established
 * `{ error, code, issues }` shape — mirroring the `requireUser`/`requireAdmin`
 * discriminated-result idiom so callers do:
 *
 *   const parsed = parseBody(Schema, raw);
 *   if ("response" in parsed) return parsed.response;
 *   const { data } = parsed;
 */
export function parseBody<S extends z.ZodTypeAny>(
  schema: S,
  data: unknown
): { data: z.infer<S> } | { response: NextResponse } {
  const result = schema.safeParse(data);
  if (!result.success) {
    return {
      response: NextResponse.json(
        {
          error: "ข้อมูลไม่ถูกต้อง",
          code: "VALIDATION",
          issues: conciseIssues(result.error),
        },
        { status: 400 }
      ),
    };
  }
  return { data: result.data };
}
