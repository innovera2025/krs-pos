import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { KrsSettingsPatchBodySchema } from "@/lib/schemas/krsSettings";
import { parseBody } from "@/lib/schemas/_shared";
import { encrypt } from "@/lib/krs/crypto";
import { logAudit, ipFromHeaders } from "@/lib/auditLog";
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";
import type { KrsConnectionSettingsDTO } from "@/types";

/**
 * KRS connection settings API (krs-sync P1). Singleton, mirrors the ShopSettings
 * route pattern (`runWithRequestId` + `requireAdmin` + `parseBody` + Prisma upsert
 * + typed `select`).
 *
 *  GET   — requireAdmin. Returns the settings with a derived `passwordSet` boolean;
 *          the Prisma `select` includes `encryptedPassword` for the boolean derive
 *          ONLY, and the response projection drops it. The plaintext/ciphertext is
 *          NEVER transmitted (P0 spec §2.5).
 *  PATCH — requireAdmin. Zod-validated (§1.2.1 SSRF/injection bounds). When a
 *          `password` is supplied it is AES-256-GCM encrypted server-side (fail-fast
 *          if KRS_CONFIG_ENC_KEY is missing/invalid); omitting it keeps the existing
 *          stored password. A change to `host` (or `port`) writes a best-effort
 *          KRS_SETTINGS_CHANGED audit AFTER the upsert commits. The response uses
 *          the SAME `passwordSet`-only projection as GET — it NEVER echoes the
 *          submitted plaintext or the stored blob (§2.5 write-path masking, R4).
 *
 * ⚠️ The route handlers are admin-only; `requireAdmin` is the real authorization
 * boundary (defense-in-depth), not middleware.
 */

/** The single KrsConnectionSettings row id (singleton). */
const SINGLETON_ID = "singleton";

/**
 * Internal projection. Includes `encryptedPassword` so the route can derive
 * `passwordSet` — it is dropped before the row reaches any JSON response. The
 * RESPONSE projection below (`toDTO`) is what the client ever sees.
 */
const KRS_SETTINGS_SELECT = {
  host: true,
  port: true,
  database: true,
  username: true,
  encryptedPassword: true,
  ssl: true,
  trustServerCert: true,
  engine: true,
  syncMode: true,
} as const;

type KrsSettingsRow = {
  host: string;
  port: number;
  database: string;
  username: string;
  encryptedPassword: string | null;
  ssl: boolean;
  trustServerCert: boolean;
  engine: string;
  syncMode: string;
};

/** Project an internal row → the masked DTO. `encryptedPassword` is reduced to a
 *  `passwordSet` boolean and never copied through. */
function toDTO(row: KrsSettingsRow): KrsConnectionSettingsDTO {
  return {
    host: row.host,
    port: row.port,
    database: row.database,
    username: row.username,
    passwordSet: row.encryptedPassword !== null,
    ssl: row.ssl,
    trustServerCert: row.trustServerCert,
    engine: row.engine,
    syncMode: row.syncMode,
  };
}

// GET /api/krs/settings — read the KRS connection singleton (admin-only).
//
// Returns `{ settings: null }` when no row exists yet (fresh/unconfigured deploy).
export async function GET(req: Request) {
  return runWithRequestId(req, async () => {
    const gate = await requireAdmin();
    if ("response" in gate) return gate.response;

    try {
      const row = await prisma.krsConnectionSettings.findUnique({
        where: { id: SINGLETON_ID },
        select: KRS_SETTINGS_SELECT,
      });
      return NextResponse.json({ settings: row ? toDTO(row) : null });
    } catch (err) {
      logger.error({ err }, "GET /api/krs/settings failed");
      return NextResponse.json(
        { error: "Could not load KRS settings", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

// PATCH /api/krs/settings — upsert the KRS connection singleton (admin-only).
export async function PATCH(req: Request) {
  return runWithRequestId(req, async () => {
    const gate = await requireAdmin();
    if ("response" in gate) return gate.response;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body", code: "BAD_REQUEST" },
        { status: 400 }
      );
    }

    const parsed = parseBody(KrsSettingsPatchBodySchema, raw);
    if ("response" in parsed) return parsed.response;
    const data = parsed.data;

    try {
      // Load the existing row first so we can (a) decide whether any connection
      // field changed (for the audit), and (b) leave `encryptedPassword` untouched
      // when no new password was submitted.
      const existing = await prisma.krsConnectionSettings.findUnique({
        where: { id: SINGLETON_ID },
        select: {
          host: true,
          port: true,
          username: true,
          database: true,
          ssl: true,
          trustServerCert: true,
        },
      });

      // Encrypt the password ONLY when one was submitted (fail-fast on a
      // missing/invalid KRS_CONFIG_ENC_KEY happens inside encrypt()). When omitted,
      // the update leaves the stored `encryptedPassword` as-is.
      const encryptedPassword =
        data.password !== undefined ? encrypt(data.password) : undefined;

      const row = await prisma.krsConnectionSettings.upsert({
        where: { id: SINGLETON_ID },
        update: {
          host: data.host,
          port: data.port,
          database: data.database,
          username: data.username,
          ssl: data.ssl,
          trustServerCert: data.trustServerCert,
          engine: data.engine,
          syncMode: data.syncMode,
          // Only include the key when a new password was provided — otherwise the
          // existing ciphertext is preserved.
          ...(encryptedPassword !== undefined ? { encryptedPassword } : {}),
        },
        create: {
          id: SINGLETON_ID,
          host: data.host,
          port: data.port,
          database: data.database,
          username: data.username,
          ssl: data.ssl,
          trustServerCert: data.trustServerCert,
          engine: data.engine,
          syncMode: data.syncMode,
          encryptedPassword: encryptedPassword ?? null,
        },
        select: KRS_SETTINGS_SELECT,
      });

      // Best-effort audit AFTER the upsert commits (never inside a transaction).
      // The compensating control for the no-private-IP-denylist SSRF stance
      // (§1.2.1): a change to ANY connection-defining field — host/port/username/
      // database/ssl/trustServerCert — OR a new password is detectable in the audit
      // trail (security H1-hardening: credential & TLS changes matter, not just the
      // host/port). A brand-new row (no `existing`) is recorded as a change.
      // `detail` stays VALUE-FREE for the password: only a `passwordChanged`
      // boolean, NEVER the password itself (§2.5).
      const passwordChanged = data.password !== undefined;
      const connectionChanged =
        !existing ||
        existing.host !== data.host ||
        existing.port !== data.port ||
        existing.username !== data.username ||
        existing.database !== data.database ||
        existing.ssl !== data.ssl ||
        existing.trustServerCert !== data.trustServerCert;
      if (connectionChanged || passwordChanged) {
        const session = gate.session;
        await logAudit({
          action: "KRS_SETTINGS_CHANGED",
          actorId: session.user?.id ?? null,
          actorEmail: session.user?.email ?? null,
          targetType: "KrsConnectionSettings",
          targetId: SINGLETON_ID,
          ip: await ipFromHeaders(),
          // Value-free: record WHICH fields changed, never the password value.
          detail: JSON.stringify({
            newHost: data.host,
            newPort: data.port,
            newUsername: data.username,
            newDatabase: data.database,
            ssl: data.ssl,
            trustServerCert: data.trustServerCert,
            passwordChanged,
          }),
        });
      }

      return NextResponse.json({ settings: toDTO(row) });
    } catch (err) {
      // `err` here is from crypto/DB, NOT the request body, so it cannot contain
      // the submitted plaintext password. (The logger also redacts `*.password`.)
      logger.error({ err }, "PATCH /api/krs/settings failed");
      return NextResponse.json(
        { error: "Could not save KRS settings", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}
