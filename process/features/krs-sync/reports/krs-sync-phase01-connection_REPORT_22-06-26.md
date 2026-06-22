# KRS Sync — Phase 1 (Connection layer + functional Connection screen) — REPORT

- Date: 2026-06-22 · Feature: krs-sync · Plan: `active/krs-sync-phase01-connection_PLAN_22-06-26.md` · Spec: `references/krs-sync-spec_P0_22-06-26.md`
- Migration: **`20260622093831_krs_connection_settings`** (new `KrsConnectionSettings` singleton + `AuditAction.KRS_SETTINGS_CHANGED`). Additive.
- Status: ✅ **Code-complete + verified locally (Gates 1–5). Adversarial review (security + code) folded in. Gate 6 (the owner's real KRS SQL Server) is the only remaining check — done by entering the real connection in the Connection screen.**

## What was built
Made the previously-fake KRS Connection screen REAL (P0 spec §1/§2/§6). New `src/lib/krs/`: **`crypto.ts`** (AES-256-GCM, key `KRS_CONFIG_ENC_KEY` 32-byte base64, fixed AAD, fresh IV, `v1:iv:tag:ct`, hex-validated, fail-closed; `KrsKeyError` for a missing key), **`client.ts`** (pooled `mssql@12` client — STRICTLY separate from the Prisma singleton; `testConnection`/`testConnectionWithInput`/`introspectSchema` over a FIXED table allow-list; sanitized errors), `index.ts`. **`KrsConnectionSettings`** singleton model (host/port/database/username/`encryptedPassword`/`ssl`/`trustServerCert`/engine/syncMode). Admin API (all `requireAdmin`): `GET/PATCH /api/krs/settings` (Zod SSRF/charset bounds; password encrypted on write, **masked** as `passwordSet` on read; `KRS_SETTINGS_CHANGED` audit on any connection-param/credential change), `POST /api/krs/test-connection`, `GET /api/krs/schema` (INFORMATION_SCHEMA introspection). Functional `ConnectionTab` (loads config, password input + show/hide, Save→PATCH, real Test Connection, TLS toggles) + `connectionTypes.ts` flipped MySQL/3306 → **SQL Server/1433/`sqlserver://`**. `mssql@^12.5.5` + `@types/mssql` added.

## Adversarial review (security + code) — all confirmed findings folded in
- **TLS trust gap (MED/HIGH, both reviewers):** the binary `ssl` toggle forced cert verification, so a self-signed on-prem KRS could only connect with encryption OFF (cleartext). **Fixed:** added `trustServerCert` (default true) → `toConfig` does `trustServerCertificate: ssl ? trustServerCert : true`, giving 3 usable modes (verify / encrypt+trust-self-signed / off) + a UI toggle. **Re-smoke proved all 3 modes** (trust connects ENCRYPTED to a self-signed server; verify rejects it).
- **Stuck "testing" state (HIGH):** switching tabs mid-test left the parent `testing` flag stuck (guarded by an unmount ref). **Fixed:** parent-state setters now always run; the unmount guard wraps only local state + toasts.
- **Raw driver error to client (MED, security F1):** `test-connection` echoed the raw mssql/tedious message (host/login enumeration). **Fixed:** driver `code` → a safe Thai/EN message allow-list; full message stays server-side only. **Verified:** the verify-mode failure returned a safe message, no leak.
- **Also fixed:** `POOL_MIN` 2→0 (no idle pre-open on throwaway pools); schema route no longer double-reads/decrypts (introspect accepts a pre-built config); missing-key surfaces a distinct `KrsKeyError` message; audit now covers credential/ssl/trust changes (value-free `passwordChanged` boolean); corrected stale pool-size UI copy + the "SIMULATED/MySQL" JSDoc.

## Verification (orchestrator — all isolated; dev :3000 / dev DB :5432 untouched)
- **Gate 1:** `type-check` green; production **build** green (isolated mirror dir, own `.next`) — all `/api/krs/*` routes compiled.
- **Gate 2:** migration applies cleanly on ephemeral Postgres (table + enum + `trustServerCert`).
- **Gate 3:** crypto **9/9** (round-trip incl. utf8/emoji/colons; fresh-IV; tamper/AAD/version/malformed-hex all fail closed) + key fail-fast (no plaintext fallback).
- **Gate 4:** **live mssql smoke 13/13** against Azure SQL Edge (arm64) — PATCH→encrypt (DB stores `v1:…`, never plaintext), GET masking (no password/`encryptedPassword`), **real connect** (`connected:true`, ~60ms), **INFORMATION_SCHEMA introspection** of mock tables, seller→**403**, bad-host charset→**400**. Post-fix **TLS 3-mode re-smoke** (off/trust/verify) + sanitized-error all confirmed.
- **Gate 5:** **e2e 14/14** (incl. /data render) — no regression from the data-page rewire.
- **Gate 6 (PENDING — owner):** connect to the REAL KRS SQL Server via the Connection screen; confirms the real schema (answers P0 §11 Q1–Q4: actual table/column names, `price_list`/`stock_balance` shape, products `barcode`, tax-invoice target).

## Security posture (verified)
KRS password AES-256-GCM-encrypted at rest (proven: DB holds `v1:…`, never plaintext); masked on every read; every KRS route `requireAdmin`; SSRF/connection-string-injection blocked by Zod charset bounds; errors sanitized to the client; encryption-key fail-fast before any write; no secret in logs/responses/audit. Cross-engine separation intact (KRS uses `mssql`, never the Prisma singleton; no `$transaction` enlistment).

## Owner actions / notes
- **Gate 6:** open the admin Connection screen → enter the real KRS host/port/db/user/**password**/TLS → Save → Test Connection → it introspects the real schema. (For a self-signed on-prem cert: SSL on + "Trust self-signed cert" on.)
- **Migration:** `20260622093831_krs_connection_settings` is verified on ephemeral only; the **dev DB (:5432) + prod still need `npx prisma migrate deploy`** (additive, non-destructive) — owner action (the running dev stack was intentionally not touched).
- **Server env:** set `KRS_CONFIG_ENC_KEY` (`openssl rand -base64 32`) in `.env` before configuring KRS (without it, Save fails closed — never stores plaintext).
- Minor/deferred: cert-rejection currently maps to the generic "host/port/timeout" safe message (a cert-specific hint would be nicer — non-blocking); pre-existing dep advisories (vitest/next, NOT from mssql) remain a separate hardening item.

## P1 → P2 boundary (deferred, as planned)
P2 = the `SyncJob` outbox extension (payload/idempotencyKey/attempts/lastError/nextAttemptAt/lockedAt) + the dispatcher (atomic claim + retry/backoff) + checkout/refund/void enqueue **inside** the Postgres `$transaction` (fail-open) + wiring the Field Mapping tab to the live `/api/krs/schema`. P1 touched NO checkout/orders code.
