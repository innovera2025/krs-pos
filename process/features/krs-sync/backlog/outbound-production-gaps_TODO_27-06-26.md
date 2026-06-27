# KRS Outbound — Production Gaps / Pending Work (TODO)

**Created:** 27-06-26
**Status:** Outbound is **LIVE on prod** (cash sales → KRS `db_ACC_SNP`, owner-confirmed as the production DB on 2026-06-27). `KRS_OUTBOUND_ENABLED=true`, dispatcher polls every 30s. First real write verified end-to-end (`SalesInvoiceHdr` TransactionNo=2 / `SC-2606-0002`, VAT split 51.40+3.60=55, stock cut, no double-write). The burned-anchor P0 idempotency handled a real crash-window-5 in prod.

This file records the **deferred outbound work** the owner asked to pause (2026-06-27) while a UI task is done first. Pick up from here.

---

## Operating envelope TODAY (what is safe to sell)
- ✅ **Cash sale · walk-in · 1+ lines · NO line discount** → writes correctly.
- 🔴 **NOT yet handled — these will diverge/fail in KRS until wired** (see below).

## Pending work (priority order)

### 1. STOCK_REVERSAL — refund / void (HIGHEST)
A POS refund/void does NOT reverse the sale in KRS → KRS stock + revenue stay overstated. Need a REVERSAL SyncJob (jobType) that posts a reversing `InventoryFlow` (InOut=+1) + reversing journal/credit-note into KRS, idempotent (its own burned anchor). Until then: **reverse such transactions manually in KRS.**

### 2. Line-discount mapping
Per-line discount (`SalePayloadItem.lineDiscount`) is captured in the snapshot but not yet mapped into the `SalesInvoiceDtl` / VAT base. Verify against a vendor sample before enabling discounted-line sales.

### 3. Non-cash payment types (transfer / card / mixed)
Writeback currently models a CASH sale (CashValue=total, cash journal DR). Non-cash tenders need the correct GL account / payment mapping.

### 4. Real customer mapping
Writeback uses a default `CustCode=C0001` for walk-in. A selected POS customer is NOT mapped to the KRS `CustOrSuppCode`. Wire `payload.customerCode/customerName/customerAddress` → KRS customer (and decide create-vs-link behavior).

### 5. Dispatch run-lock (double-write hardening — IN OUR CONTROL)
`runDispatch` has no app-level single-flight lock (unlike `runAutoSync`, autoSync.ts:116-150). Practical double-write risk is LOW in the current single-app + 30s-cron + 25s-request-timeout config (writeKrsSale finishes/fails well under the 10-min stale-lock window, so the next cron skips a still-locked job), but a run-lock removes the residual window-9 (alive-but-slow concurrent dispatcher) without touching KRS schema. Recommended before higher concurrency / multiple app instances.

### 6. UNIQUE constraint on KRS (vendor-coordinated belt-and-suspenders)
`UNIQUE(TransactionNo)` on `SalesInvoiceHdr` and `InventoryFlowHdr` is the only SERVER-SIDE guard against window-9. INVASIVE on a third-party ERP — check for existing duplicates + coordinate with the KRS vendor first (could break KRS's own software or fail on existing data). Consider a FILTERED unique index scoped to POS-written rows instead of a blanket constraint.

### 7. NEEDS_RECONCILE UI surfacing
A `NEEDS_RECONCILE` SyncJob currently renders "Unknown" and is dropped from KPI counts. Update the local `SyncJobStatus` union (`src/types/index.ts`) + `SYNC_JOB_META` + `STATUS_COUNT_KEY` + `STATUS_ORDER` + `EMPTY_COUNTS` + `SyncCountsDTO` together (will need TS2741-safe exhaustiveness).

### 8. Least-privilege KRS write login (replace `sa`)
Outbound currently authenticates as `sa` (sysadmin). Request a dedicated least-privilege write login from the vendor/DBA.

---

## Operational reference
- **Disable (back to dormant):** `cd ~/krs-pos && sed -i 's/^KRS_OUTBOUND_ENABLED=true/KRS_OUTBOUND_ENABLED=false/' .env && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --wait app`
- **`.env` password gotcha:** the KRS `sa` password contains `$` and `()`. In docker-compose `.env`, **single-quote the value** (`KRS_SANDBOX_PASS='...'`) — compose mangles a bare `$` and `$$`-escaping was also wrong on this compose version. Read it back for scripts with `eval "$(grep '^KRS_SANDBOX_' .env)"`.
- **KRS verify queries:** mssql is bundled into the Next standalone server.js (not requireable from `/app`); run ad-hoc KRS SELECTs via the **migrate image**: `docker compose run --rm --no-deps -e KRS_SANDBOX_HOST -e KRS_SANDBOX_PORT -e KRS_SANDBOX_DB -e KRS_SANDBOX_USER -e KRS_SANDBOX_PASS -e KRS_SANDBOX_SSL -e KRS_SANDBOX_TRUST_CERT --entrypoint node migrate`.
- **Enable is owner-run:** the auto-mode classifier hard-blocks the agent from flipping `KRS_OUTBOUND_ENABLED`/writing creds to prod — agent supplies the script, owner runs it on the box; agent does read-only verify.

See `process/features/krs-sync/active/krs-writeback-idempotency_PLAN_27-06-26.md` (completed) and the `krs-sync-program-state` memory for the full design + history.
