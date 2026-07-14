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

  // --- Seller identity for the Thai full tax invoice (Phase 4, owner decision
  // D2: ENV-based). ALL OPTIONAL at boot — a deploy that never issues a tax
  // invoice (and CI/e2e) must still boot, so these are NOT fail-fast required
  // here. SHAPE is validated when present; issue-time enforcement (a 422
  // SELLER_NOT_CONFIGURED when SELLER_TAX_ID/NAME/ADDRESS are unset) happens in
  // the request-tax route, not at boot. NEVER put a real/fabricated TIN in
  // .env.example — only a CHANGE_ME placeholder.
  //
  // SELLER_TAX_ID — the seller's 13-digit Revenue-Department TIN. When set it
  // must be EXACTLY 13 digits (the §86/4 mandatory particular). When unset, the
  // request-tax route refuses to mint a number.
  SELLER_TAX_ID: z
    .string()
    .regex(/^\d{13}$/, "SELLER_TAX_ID must be exactly 13 digits")
    .optional(),
  // SELLER_NAME — the seller's registered legal name (§86/4 particular). Length
  // cap (FIX 6) mirrors the shape-validation rigor of SELLER_TAX_ID/BRANCH_CODE —
  // a runaway value is a misconfiguration, not a legal name.
  SELLER_NAME: z
    .string()
    .min(1)
    .max(200, "SELLER_NAME must be at most 200 characters")
    .optional(),
  // SELLER_ADDRESS — the seller's registered address (§86/4 particular). Length
  // cap (FIX 6) bounds the env-sourced value.
  SELLER_ADDRESS: z
    .string()
    .min(1)
    .max(300, "SELLER_ADDRESS must be at most 300 characters")
    .optional(),
  // SELLER_BRANCH_CODE — the seller's 5-digit RD branch designation. "00000" =
  // สำนักงานใหญ่ (head office). When set it must be exactly 5 digits. Defaulted
  // to HQ in sellerConfig when unset (HQ is the safe single-branch default).
  SELLER_BRANCH_CODE: z
    .string()
    .regex(/^\d{5}$/, "SELLER_BRANCH_CODE must be exactly 5 digits")
    .optional(),
  // SELLER_BRANCH_LABEL — the human branch label (e.g. "สำนักงานใหญ่" or
  // "สาขาสีลม"). Free text; defaulted in sellerConfig when unset. Length cap
  // (FIX 6) bounds the env-sourced value.
  SELLER_BRANCH_LABEL: z
    .string()
    .min(1)
    .max(100, "SELLER_BRANCH_LABEL must be at most 100 characters")
    .optional(),

  // --- KRS sync — AES-256-GCM key for encrypting KrsConnectionSettings.encryptedPassword
  // (krs-sync P1, P0 spec §2.1/§3.3). OPTIONAL at boot: a non-KRS deploy (and
  // CI/e2e) must still boot, so this is NOT a fail-fast boot requirement. The
  // authoritative fail-fast (missing/empty/wrong-length) lives at the encrypt/
  // decrypt callsite in src/lib/krs/crypto.ts, fired at first KRS write/connect —
  // NOT here. Shape is recorded only so the validated `env` object carries it.
  // When set it must decode to exactly 32 bytes (base64); crypto.ts enforces that.
  KRS_CONFIG_ENC_KEY: z.string().optional(),

  // --- KRS auto-sync (inbound auto-pull, krs-sync). Three knobs for the
  // scheduled delta-pull endpoint POST /api/krs/auto-sync. ALL OPTIONAL at boot
  // (a deploy that never enables auto-sync, and CI/e2e, must still boot). SHAPE is
  // validated when present; the operational gates (missing secret → 503, disabled
  // → 422) are enforced at the endpoint, not here.
  //
  // KRS_SYNC_TRIGGER_SECRET — the shared bearer secret the cron scheduler sends as
  // `Authorization: Bearer <value>` to the auto-sync endpoint. Min 32 chars when
  // present (high-entropy: openssl rand -hex 32). When unset, the endpoint returns
  // 503 (not configured). NEVER logged or returned.
  KRS_SYNC_TRIGGER_SECRET: z
    .string()
    .min(32, "KRS_SYNC_TRIGGER_SECRET must be at least 32 characters")
    .optional(),
  // KRS_AUTO_SYNC_ENABLED — kill switch. The auto-sync endpoint runs ONLY when
  // this is exactly "true"; any other value (including the default) returns 422.
  // Opt-in by design.
  KRS_AUTO_SYNC_ENABLED: z.enum(["true", "false"]).default("false"),
  // KRS_AUTO_SYNC_WAREHOUSE — optional sp_Onhand @Warehouse filter. Empty/unset =
  // all warehouses (NULL). Passed as a BOUND mssql parameter, never concatenated;
  // the ≤20 cap mirrors the KRS warehouse-code format (e.g. "WHFG").
  KRS_AUTO_SYNC_WAREHOUSE: z
    .string()
    .max(20, "KRS_AUTO_SYNC_WAREHOUSE must be at most 20 characters")
    .optional(),

  // --- KRS outbound write-back (krs-sync P2 — POS → KRS cash-sale outbox/dispatcher).
  // ALL OPTIONAL at boot (a deploy that never enables outbound, and CI/e2e, must still
  // boot). The feature is OFF by default; the SyncJob outbox row is still enqueued at
  // checkout regardless of the flag, but the dispatcher only performs the KRS write
  // when KRS_OUTBOUND_ENABLED === "true". Track A ships safely with everything unset.
  //
  // KRS_OUTBOUND_ENABLED — kill switch for the actual KRS write. The dispatcher
  // skips the write (re-queues the claimed job) for any value other than "true".
  // Opt-in by design (mirrors KRS_AUTO_SYNC_ENABLED).
  KRS_OUTBOUND_ENABLED: z.enum(["true", "false"]).default("false"),
  // KRS_DISCOUNT_WRITE_ENABLED — kill switch for writing DISCOUNTED sales to KRS. When
  // not exactly "true", the dispatcher HOLDS any bill that carries a discount
  // (salePayloadHasDiscount) — re-queued PENDING without counting an attempt — so no
  // discounted bill reaches KRS until the net-out mapping is verified in the sandbox. A
  // zero-discount bill is unaffected. Opt-in by design (mirrors KRS_OUTBOUND_ENABLED);
  // the OWNER flips it after sandbox verification (an agent must never flip it).
  KRS_DISCOUNT_WRITE_ENABLED: z.enum(["true", "false"]).default("false"),
  // KRS_DISPATCH_SECRET — the shared bearer secret the dispatch cron sidecar sends as
  // `Authorization: Bearer <value>` to POST /api/krs/dispatch. Min 32 chars when
  // present (high-entropy: openssl rand -hex 32). When unset, the endpoint returns
  // 503 (not configured). NEVER logged, echoed, or returned (mirrors the auto-sync
  // trigger secret).
  KRS_DISPATCH_SECRET: z
    .string()
    .min(32, "KRS_DISPATCH_SECRET must be at least 32 characters")
    .optional(),
  // KRS_SANDBOX_* — the SEPARATE sandbox MS SQL Server connection the outbound write
  // targets. Deliberately NOT the production KrsConnectionSettings DB row used by
  // inbound sync (P0 spec mandate: the write target must be a separate sandbox so a
  // verification run can never touch production KRS). The sandbox client reads these
  // env vars directly; sandboxClient.buildSandboxConfig() returns null when the
  // required ones (host/db/user/pass) are unset, so the write refuses cleanly. SHAPE
  // is validated when present; the password is plaintext (sandbox, not prod) — NEVER
  // logged. Track A plumbs these through; no live connection is made.
  KRS_SANDBOX_HOST: z
    .string()
    .max(255, "KRS_SANDBOX_HOST must be at most 255 characters")
    .optional(),
  KRS_SANDBOX_PORT: z
    .string()
    .regex(/^\d{1,5}$/, "KRS_SANDBOX_PORT must be a numeric port")
    .optional(),
  KRS_SANDBOX_DB: z
    .string()
    .max(255, "KRS_SANDBOX_DB must be at most 255 characters")
    .optional(),
  KRS_SANDBOX_USER: z
    .string()
    .max(255, "KRS_SANDBOX_USER must be at most 255 characters")
    .optional(),
  KRS_SANDBOX_PASS: z.string().optional(),
  KRS_SANDBOX_SSL: z.enum(["true", "false"]).default("true"),
  KRS_SANDBOX_TRUST_CERT: z.enum(["true", "false"]).default("true"),

  // --- KRS product-image HTTP (product images mapped by KRS PictureName). The
  // product master carries a raw image FILENAME on Product.imageUrl (from KRS
  // PictureName); the POS is served over HTTPS so the browser cannot load the
  // plain-HTTP image directly (mixed content), so the Node route
  // GET /api/products/image proxies + disk-caches the file from the plain-HTTP KRS
  // box. ALL OPTIONAL at boot (a deploy that never serves product images, and
  // CI/e2e, must still boot). The route reads these LAZILY at request time and has
  // baked-in defaults, so images load with no extra prod env. Host + company are
  // env-FIXED (never request-controlled) — no secret is involved (open HTTP).
  //
  // KRS_IMAGE_BASE_URL — base URL of the image store. Optional; the route applies
  // the default 'http://43.229.134.162/update' in code when unset. Full URL:
  // `{KRS_IMAGE_BASE_URL}/{KRS_IMAGE_COMPANY}/Image/Drawing/{PictureName}`.
  KRS_IMAGE_BASE_URL: z.string().optional(),
  // KRS_IMAGE_COMPANY — the company segment in the image path. Defaults to "SNP".
  KRS_IMAGE_COMPANY: z
    .string()
    .max(64, "KRS_IMAGE_COMPANY must be at most 64 characters")
    .default("SNP"),
  // KRS_IMAGE_CACHE_DIR — local directory the route caches downloaded images in.
  // Defaults to "/tmp/krs-images" (ephemeral; fine for the current ~1 image).
  KRS_IMAGE_CACHE_DIR: z
    .string()
    .max(512, "KRS_IMAGE_CACHE_DIR must be at most 512 characters")
    .default("/tmp/krs-images"),
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
      // Seller identity (Phase 4) — passed through unvalidated during the build
      // phase (no tax invoice is issued at build time); real shape validation +
      // issue-time enforcement happen at runtime.
      SELLER_TAX_ID: process.env.SELLER_TAX_ID,
      SELLER_NAME: process.env.SELLER_NAME,
      SELLER_ADDRESS: process.env.SELLER_ADDRESS,
      SELLER_BRANCH_CODE: process.env.SELLER_BRANCH_CODE,
      SELLER_BRANCH_LABEL: process.env.SELLER_BRANCH_LABEL,
      // KRS encryption key (krs-sync P1) — passed through unvalidated during the
      // build phase (no KRS write/connect happens at build time); the real
      // length validation lives at the crypto.ts callsite at runtime.
      KRS_CONFIG_ENC_KEY: process.env.KRS_CONFIG_ENC_KEY,
      // KRS auto-sync knobs (krs-sync inbound auto-pull) — passed through
      // unvalidated during the build phase (the auto-sync endpoint never runs at
      // build time); real shape validation + the endpoint gates apply at runtime.
      KRS_SYNC_TRIGGER_SECRET: process.env.KRS_SYNC_TRIGGER_SECRET,
      KRS_AUTO_SYNC_ENABLED:
        process.env.KRS_AUTO_SYNC_ENABLED === "true" ? "true" : "false",
      KRS_AUTO_SYNC_WAREHOUSE: process.env.KRS_AUTO_SYNC_WAREHOUSE,
      // KRS outbound write-back knobs (krs-sync P2) — passed through unvalidated
      // during the build phase (the dispatcher/checkout outbox never runs at build
      // time); real shape validation + the endpoint/dispatcher gates apply at
      // runtime. Enum fields normalize to the "true"/"false" string so the build
      // object matches the parsed type exactly.
      KRS_OUTBOUND_ENABLED:
        process.env.KRS_OUTBOUND_ENABLED === "true" ? "true" : "false",
      KRS_DISCOUNT_WRITE_ENABLED:
        process.env.KRS_DISCOUNT_WRITE_ENABLED === "true" ? "true" : "false",
      KRS_DISPATCH_SECRET: process.env.KRS_DISPATCH_SECRET,
      KRS_SANDBOX_HOST: process.env.KRS_SANDBOX_HOST,
      KRS_SANDBOX_PORT: process.env.KRS_SANDBOX_PORT,
      KRS_SANDBOX_DB: process.env.KRS_SANDBOX_DB,
      KRS_SANDBOX_USER: process.env.KRS_SANDBOX_USER,
      KRS_SANDBOX_PASS: process.env.KRS_SANDBOX_PASS,
      KRS_SANDBOX_SSL:
        process.env.KRS_SANDBOX_SSL === "false" ? "false" : "true",
      KRS_SANDBOX_TRUST_CERT:
        process.env.KRS_SANDBOX_TRUST_CERT === "false" ? "false" : "true",
      // KRS product-image HTTP knobs — passed through unvalidated during the build
      // phase (the image route never runs at build time); real shape validation +
      // the route's lazy defaults apply at runtime. The defaulted fields mirror the
      // schema defaults (?? applies only when the env var is unset); KRS_IMAGE_BASE_URL
      // is optional here — the route applies its code default when unset.
      KRS_IMAGE_BASE_URL: process.env.KRS_IMAGE_BASE_URL,
      KRS_IMAGE_COMPANY: process.env.KRS_IMAGE_COMPANY ?? "SNP",
      KRS_IMAGE_CACHE_DIR: process.env.KRS_IMAGE_CACHE_DIR ?? "/tmp/krs-images",
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
