# KRS Sync Phase 0 REPORT — Contracts (spec only, no code)

- Date: 2026-06-22 · Feature: `krs-sync` · Phase: **P0 of 5 (P0–P4)**.
- Spec (this phase's deliverable): `process/features/krs-sync/references/krs-sync-spec_P0_22-06-26.md`
- P0 plan: `process/features/krs-sync/active/krs-sync-phase00-contracts_PLAN_22-06-26.md`
- Umbrella: `process/features/krs-sync/active/krs-sync-program_PLAN_22-06-26.md`
- Grounding: `process/features/krs-sync/references/krs-sync-grounding_22-06-26.md`
- Owner decisions baked in (2026-06-22): Admin-UI config · `KrsConnectionSettings` singleton · AES-256-GCM password · runtime `INFORMATION_SCHEMA` introspection (no DDL hand-over).
- **Status: ✅ VERIFIED — spec reviewed + coherent.** P0 produces **no production code**, so "verified" = reviewed + internally consistent + adversarially hardened, not a runtime gate. **2 adversarial reviews → 13 findings → 11 applied, 2 deferred.** No `src/`, `prisma/schema.prisma`, migration, build, or prisma command was touched (DOC-ONLY scope honored). Spec is **awaiting owner review** (§12) before P1 begins.

## What the contract decided
P0 is the single source of truth that removes implementation ambiguity from P1–P4. It pins, with no code:

- **`KrsConnectionSettings` model (§1)** — a Postgres singleton (`id @default("singleton")`, mirroring `ShopSettings`) holding *connection config only* (host/port/database/username/encryptedPassword/ssl/engine/syncMode). It does NOT open a second Prisma datasource; the live `mssql` pool is opened by `src/lib/krs/client.ts` (P1), never via the Prisma singleton. New §1.2.1 pins server-side Zod bounds for every field.
- **AES-256-GCM encryption (§2)** — password is the only secret in the POS DB. Key = `KRS_CONFIG_ENC_KEY` (32 bytes, base64), git-ignored `.env` only, validated **lazily at the crypto callsite** (fail-fast on missing/wrong-length, never a plaintext fallback). Stored format now `v1:<iv>:<authTag>:<ciphertext>` with a fixed AAD; masking forbids returning the blob on GET **and** PATCH; plaintext never logged.
- **Env contract (§3)** — exactly ONE new var (`KRS_CONFIG_ENC_KEY`). All the old `KRS_HOST/PORT/DB/USER/PASS/...` cred vars are explicitly forbidden — they live in the DB model now.
- **Outbound mapping (§4)** — conceptual POS-event→KRS-table map (checkout→`sales`+`sale_items`, stock→`stock_movements`, refund/void→negative `sales` + positive `stock_movements` reversal, tax-invoice→`sales`). Exact column names are discovered at P1 introspection; the design's 7-row `mapOut` baseline (incl. the intentionally-unmapped `vat_code`) is recorded.
- **Inbound mapping (§5)** — pull-on-demand only; upsert `Product` on the unique SKU. Flags the `products.vat_rate → Product.vat` gap (POS has no `vat` column today — open question, no P0 schema change).
- **Introspection (§6)** — `GET /api/krs/schema` (admin-only) queries `INFORMATION_SCHEMA.COLUMNS` over a fixed table allow-list (no injection surface) and drives the Field Mapping UI with real metadata.
- **Idempotency + dedup (§7)** — `<naturalRef>_<jobType>` key on `SyncJob.idempotencyKey @unique`; POS-side sync-log dedup is primary, KRS natural-key is fallback. At-most-once invariant.
- **Fail-open + outbox (§8)** — KRS write failure never blocks/rolls back checkout; KRS writes never enlist in the Prisma `$transaction`; `SyncJob` gains outbox fields (`payload`, `idempotencyKey`, `attempts`, `lastError`, `nextAttemptAt`, `lockedAt`) in the P2 migration; dispatcher/retry state machine over the existing `SyncJobStatus` enum.
- **`mssql` version + dev verify (§9)** — pin `mssql ^11` (bundles `tedious`); dev against an ephemeral Docker SQL Server, but **P2–P4 gates require the owner's real test instance**.
- **Verification (§10)**, **open questions (§11)**, **approval checkpoint (§12)**, **P1 deliverables/touchpoints (§13)**.

Architectural invariants (do-not-relitigate): fail-open · cross-engine separation · secret hygiene.

## Adversarial review — 13 findings (11 applied, 2 deferred)
Two reviews ran: a **STRIDE+OWASP security lens** on the AES-GCM-at-rest password handling and the admin-entered connection params, and an **integration-correctness lens** on the fail-open invariant, idempotency, outbox state machine, and refund/void sign conventions. Every applied finding was cross-checked against the real codebase before folding it in.

### Applied (11)
1. **(MED, security) GCM had no AAD.** Folded into §2.3/§2.4: encrypt/decrypt now bind a fixed AAD `Buffer.from("krs.connection.password.v1")`, so a blob from any other field encrypted under the same key cannot cross-decrypt into the password slot — fails closed on AAD mismatch.
2. **(MED, security) No SSRF/injection bounds on host/database/username.** Folded into a new **§1.2.1** Zod contract (host ≤253 + hostname/IP charset, database/username bounded + conservative charset rejecting connection-string metachars, port 1–65535, password 1–256). SSRF stance stated explicitly: KRS is a *deliberate* admin-configured outbound target so a private-IP denylist is infeasible, but every `host`/`port` change writes a `KRS_SETTINGS_CHANGED` audit event. Mirrors the repo's existing `ShopSettingsPatchBodySchema` rigor (`src/lib/schemas/`).
3. **(MED, security) No key-vintage marker in the stored format.** Folded into §2.2/§2.6: a leading `v1` version tag, asserted on decrypt, distinguishes "wrong key vintage" from "tampered" and enables an old+new-key rotation window.
4. **(LOW, security) Write-path could echo plaintext / leak via Zod message.** Folded into §2.5: the PATCH response uses the same `passwordSet`-only projection as GET; password Zod messages must not interpolate the value; §10 P1 gate adds the assertion.
5. **(LOW, security) Raw mssql/tedious error object can embed the password under non-redacted keys.** Folded into §2.5: the KRS client must construct a SANITIZED error (`host/port/database/username/code/message`) and never hand the raw driver error/config to the logger. Verified against `src/lib/logger.ts` — pino redacts `*.password`/`*.secret` by key name only, so the finding is real.
6. **(LOW, security) Decrypt didn't validate hex segments before `Buffer.from`.** Folded into §2.4 step 3: regex-validate each segment + assert IV=24/tag=32 hex chars before constructing Buffers, turning a malformed blob into a clean `corrupt ciphertext` error.
7. **(CRITICAL, integration) SyncJob enqueue could be lost after the Order commit.** Folded into §8.1 with **fix (a) — enqueue INSIDE the checkout `$transaction`** (`tx.syncJob.create`). Verified this IS the established repo pattern: the existing tax-invoice path already does `tx.syncJob.create` inside its transaction (`src/app/api/orders/[id]/route.ts` L307). This supersedes the old "enqueue after commit / fire-and-enqueue" wording, eliminating the rolling-deploy crash window. Fix (b) reconciliation query added to the P4 runbook as defense-in-depth.
8. **(HIGH, integration) Dispatcher claim was not specified as atomic.** Folded into §8.3: the claim MUST be a single atomic compare-and-swap `UPDATE ... WHERE id=? AND (lockedAt IS NULL OR stale) RETURNING id`; SELECT-then-UPDATE explicitly forbidden; a 0-row result means already-claimed → abort.
9. **(HIGH, integration) Stock reversal for refund/void was unspecified.** Folded into §4.1/§4.3/§7.1: a `orderNumber + "_STOCK_REVERSAL"` job writes a positive `stock_movements` row (using the existing `STOCK_ADJ` `SyncJobType` — verified the enum already has it), else KRS stock permanently diverges after every void. Owner-confirm flag added (KRS may self-reverse).
10. **(HIGH, integration) Dedup pre-check depends on the atomic claim.** Folded into §7.2 + §8.3 as an explicit cross-reference: the read-then-act dedup is only race-safe behind the atomic claim.
11. **(MED, integration) Stale-lock reclaim + non-null idempotencyKey + sign conventions.** Folded into §8.3 (10-min stale-lock reclaim, attempts not double-counted, RETRYING self-healing rationale for the FAILED-only NavRail badge), §8.1 (non-null `idempotencyKey` invariant + P2 review gate, since Postgres allows multiple NULLs under `@unique`), and §4.3 (refund/void sign conventions: negative grand_total + tax_amount, header-only, payment_type = original tender — marked TO BE CONFIRMED at P1).

### Deferred (2 — noted, not applied)
- **(MED, security) Re-auth/confirmation on host change.** Deferred — for a single-store admin tool this is heavier than warranted; the **audit-log event on host change** (applied, finding 2) is the right floor. Reconsider if KRS ever becomes multi-tenant.
- **(LOW, integration) `syncMode` dispatcher gating** was raised as a finding to fix in §8.3, but resolving *how* `realtime`/`daily`/`manual` gate the dispatcher is genuinely an **owner decision**, not a P0 contract default — so it's recorded as **Open Question §11 Q9** (with an explicit "P2 must not silently default to dispatch-immediately") rather than pinned. This is a routing-to-the-owner deferral, not a rejection.

No finding was rejected as wrong; the two deferrals are scope/sequencing calls (one is a heavier control than a single-store tool needs, one is an owner decision surfaced as an open question).

## Codebase cross-checks performed (read-only)
- `src/lib/logger.ts` — confirmed pino `redact` is key-name-based (`*.password`/`*.secret`), validating finding 5.
- `src/lib/schemas/_shared.ts` + `shopSettings.ts` — confirmed the `parseBody`/`conciseIssues` + bounded-Zod pattern that §1.2.1 mirrors.
- `src/app/api/orders/route.ts` (L647–711) — confirmed the checkout `$transaction` writes Order + atomic stock decrement + `StockMovement`; `logAudit` is best-effort AFTER commit. Validates the CRITICAL finding's context and the in-transaction-enqueue fix.
- `src/app/api/orders/[id]/route.ts` (L307) — confirmed the tax-invoice path already does `tx.syncJob.create` inside its transaction → the in-transaction outbox fix is the established pattern, not new design.
- `prisma/schema.prisma` — confirmed `SyncJob` current fields + `SyncJobType` already has `STOCK_ADJ` (so the stock-reversal fix needs no new enum value) and `SyncJobStatus` enum used by §8.3.

## P0 status
**VERIFIED (spec-level).** The contract is internally coherent, adversarially hardened on both the security and integration axes, and grounded in the real codebase patterns. P0 wrote no code, so there is nothing to build/run — the gate is "reviewed + coherent," which is met. The spec remains **AWAITING OWNER REVIEW (§12)**: P1 does not start until the owner signs off, and several open questions (§11, now 11 items) are routed to the owner / P1 introspection.

## Next action
- **Owner reviews the spec** `process/features/krs-sync/references/krs-sync-spec_P0_22-06-26.md` and approves §12 (note especially the post-review §8.1/§8.3 changes and §1.2.1 bounds). P1 is gated on this approval.
- Then **P1 = the functional Connection screen + `KrsConnectionSettings` model + AES-256-GCM encryption + `INFORMATION_SCHEMA` introspection**, per §13 touchpoints. The P1 phase plan is written *after* this spec is approved (suggested path: `process/features/krs-sync/active/krs-sync-phase01-connection_PLAN_22-06-26.md`).
- **P1 verification needs the owner's real KRS test SQL Server channel** (host/port/db/creds entered via the Admin UI). The ephemeral Docker SQL Server (§9.2) is sufficient for P1 dev/build, but the authoritative connection + introspection verification — and ALL of P2–P4 — requires the owner's real instance.

## Files
- Edited: `process/features/krs-sync/references/krs-sync-spec_P0_22-06-26.md` (review folded in; header changelog + §12 acknowledgement added).
- Created: `process/features/krs-sync/reports/krs-sync-phase00-contracts_REPORT_22-06-26.md` (this report).
- Untouched (DOC-ONLY honored): all `src/`, `prisma/schema.prisma`, migrations; no build/prisma run.
</content>
</invoke>
