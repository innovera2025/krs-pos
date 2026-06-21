import { z } from "zod";
import { logger } from "@/lib/logger";

/**
 * Fail-fast environment validation (production-readiness Phase 1, theme #6).
 *
 * ⚠️ NODE-ONLY. This module is imported from `src/lib/prisma.ts` and `src/auth.ts`
 * — both Node-runtime server modules — so the validation runs at SERVER BOOT (the
 * first time either is imported in a server process). It must NEVER be imported
 * from an Edge module (`src/middleware.ts`, `src/auth.config.ts`) or any client
 * component: importing it there would pull Zod into the edge/client bundle and
 * break the edge-safe split that keeps Prisma/bcrypt out of middleware.
 *
 * Behavior:
 *  - Missing/invalid `DATABASE_URL` or `AUTH_SECRET` → THROW at module load with a
 *    clear, actionable message (the app should not boot half-broken — without this
 *    a missing DATABASE_URL boots fine then fails every API call with a cryptic
 *    Prisma error, and a missing AUTH_SECRET fails silently at first session use).
 *  - `NODE_ENV` is an optional enum, defaulting to "development".
 *  - `AUTH_URL` / `AUTH_TRUST_HOST` are Auth.js deployment knobs (NOT validated as
 *    required). In production, a missing `AUTH_URL` is WARNED (not thrown) — behind
 *    a reverse proxy Auth.js needs it (or AUTH_TRUST_HOST) to infer the base URL.
 */
const EnvSchema = z.object({
  // The Prisma connection string. Prisma itself reads process.env.DATABASE_URL;
  // we validate it here so a missing/garbage value fails loudly at boot instead of
  // on the first query. Must look like a Postgres URL.
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine(
      (v) => v.startsWith("postgres://") || v.startsWith("postgresql://"),
      "DATABASE_URL must be a PostgreSQL connection string (postgres:// or postgresql://)"
    ),
  // Auth.js v5 session-signing secret. The JWT session cookie is signed/encrypted
  // with it; a missing/short secret is a real security defect, not a warning.
  AUTH_SECRET: z
    .string()
    .min(1, "AUTH_SECRET is required")
    .min(16, "AUTH_SECRET must be at least 16 characters"),
  // Runtime mode. Optional — defaults to development. docker-compose sets it to
  // production for the app service.
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  // Auth.js base-URL override. OPTIONAL — Auth.js infers the origin in dev; behind
  // a reverse proxy / at a non-default origin it must be set explicitly. Not
  // validated as required here; a production-without-AUTH_URL case is warned below.
  AUTH_URL: z.string().optional(),
  // Auth.js "trust the host header" flag. OPTIONAL — relevant when the app runs
  // behind a reverse proxy WITHOUT an explicit AUTH_URL. Documented in .env.example;
  // not validated as required.
  AUTH_TRUST_HOST: z.string().optional(),
});

function loadEnv(): z.infer<typeof EnvSchema> {
  // `next build` imports server modules (prisma/auth) for page-data collection, but
  // the build does NO DB query and signs NO session — runtime secrets aren't needed
  // then. Skip the fail-fast during the Next build phase so the production image can
  // build WITHOUT baking in (or faking) DATABASE_URL/AUTH_SECRET. The guard still
  // runs at real server boot (NEXT_PHASE is unset / != build), so a misconfigured
  // RUNTIME still fails fast. No fake secret literal lives here (values default to "").
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return {
      DATABASE_URL: process.env.DATABASE_URL ?? "",
      AUTH_SECRET: process.env.AUTH_SECRET ?? "",
      NODE_ENV:
        (["development", "test", "production"] as const).find(
          (m) => m === process.env.NODE_ENV
        ) ?? "development",
      AUTH_URL: process.env.AUTH_URL,
      AUTH_TRUST_HOST: process.env.AUTH_TRUST_HOST,
    };
  }

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Build a single, readable message listing every offending variable so an
    // operator sees exactly what to fix at boot.
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration. Fix these variables (see .env.example):\n${issues}`
    );
  }

  const env = parsed.data;

  // Production deploy hint (warn, never throw): behind a proxy Auth.js needs
  // AUTH_URL (or AUTH_TRUST_HOST) to build correct callback/redirect URLs.
  if (env.NODE_ENV === "production" && !env.AUTH_URL) {
    logger.warn(
      "[env] NODE_ENV=production but AUTH_URL is not set. Behind a reverse proxy, " +
        "set AUTH_URL (or AUTH_TRUST_HOST) so Auth.js can infer the correct base URL."
    );
  }

  return env;
}

/**
 * The validated, typed environment. Importing this module runs the validation
 * once at server boot (throws on a fatal misconfiguration).
 */
export const env = loadEnv();
