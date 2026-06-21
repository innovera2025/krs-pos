import { headers } from "next/headers";
import type { AuditAction } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Audit-log writer (auth Phase 3).
 *
 * Append-only security/event trail. Two hard rules make this safe to sprinkle
 * across the highest-stakes paths (login, refund/void, user admin):
 *
 *  1. BEST-EFFORT — `logAudit` NEVER throws. The `prisma.create(...).catch(...)`
 *     swallows any DB error (logging it to the server console) so a failed audit
 *     write can never fail the primary action (a sign-in, a refund, a user
 *     update). The caller does NOT await success semantics from it.
 *  2. NEVER inside a $transaction — always call it AFTER the primary action has
 *     committed. An audit write that shared the primary transaction could roll the
 *     primary action back (defeating rule 1) or be rolled back itself (losing the
 *     record). Both are wrong; keep it out of the transaction.
 *
 * The password hash is never an input here, so it can never leak into the trail.
 */

export type AuditInput = {
  action: AuditAction;
  actorId?: string | null;
  actorEmail?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  ip?: string | null;
  /** Small JSON string (or short text) for action-specific context. */
  detail?: string | null;
};

/**
 * Write one audit row. Fire-and-forget by contract: it returns a Promise that
 * always resolves (never rejects). Callers may `await` it to order the write
 * after the primary commit, but a rejection can never surface.
 */
export async function logAudit(data: AuditInput): Promise<void> {
  await prisma.auditLog
    .create({
      data: {
        action: data.action,
        actorId: data.actorId ?? null,
        actorEmail: data.actorEmail ?? null,
        targetType: data.targetType ?? null,
        targetId: data.targetId ?? null,
        ip: data.ip ?? null,
        detail: data.detail ?? null,
      },
    })
    .then(() => undefined)
    .catch((e) => {
      // Best-effort: never propagate. The primary action already succeeded.
      console.error("audit write failed:", e);
    });
}

/**
 * Best-effort client IP from the request headers (first hop of
 * x-forwarded-for). `headers()` is async in this Next version. Returns null when
 * unavailable; never throws (audit context must not break the primary path).
 */
export async function ipFromHeaders(): Promise<string | null> {
  try {
    const fwd = (await headers()).get("x-forwarded-for");
    const first = fwd?.split(",")[0]?.trim();
    return first && first.length > 0 ? first : null;
  } catch {
    return null;
  }
}
