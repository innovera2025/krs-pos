# Watermark discovery (P0 addendum, vendor-free variant) — 16-07-26

- Program: `krs-realtime-inbound_PLAN_16-07-26.md` · Script: `scripts/krs-watermark-discovery.cjs` (read-only, run in the migrate image on the VPS)
- Owner decision 16-07-26: **proceed WITHOUT any KRS-side change** (no Change Tracking DDL) → detector = watermark polling. CT remains a future drop-in upgrade (letter in `krs-ct-vendor-request_P0_16-07-26.md` still worth sending with Q1-Q9).

## Findings (live server, 16-07-26 ~16:45 UTC)

| Table | rows | cols | Usable change signals (MAX observed) |
|---|---|---|---|
| `dbo.InventoryFlowHdr` | 20 | 75 | **`EntryDate`** (recent — doc creation) · **`ApprovedDate`** (recent — approval moment, incl. late approvals of old docs = the exact event that moves sp_Onhand) · `TransactionNo` (running number, max 20) · dead: IsClosedDate/IsApprovedDate/ImportDate/... (all NULL) |
| `dbo.InventoryFlowDtl` | 1,050 | 71 | only `InOutDate` (date-only, not a modified-time) → Dtl changes are detected **via their Hdr** (Txn/EntryDate/ApprovedDate); silent Dtl-only edits fall to the sweep |
| `dbo.InventoryItem` | 4,009 | 102 | `EntryDate` (recent) — new items detectable; **price/name edits may not bump it** → item-master edits ride the existing ~60s import sweep (acceptable; stock is the realtime target) |

## Detector contract (feeds P1)

Single cheap probe every ~2s (one round-trip, 4 scalar aggregates over tiny tables):
```sql
SELECT
  (SELECT MAX(TransactionNo) FROM dbo.InventoryFlowHdr) AS maxTxn,
  (SELECT MAX(EntryDate)     FROM dbo.InventoryFlowHdr) AS maxEntry,
  (SELECT MAX(ApprovedDate)  FROM dbo.InventoryFlowHdr) AS maxApproved,
  (SELECT MAX(EntryDate)     FROM dbo.InventoryItem)    AS maxItemEntry;
```
Any watermark advanced vs the stored cursor → fetch affected docs
(`WHERE TransactionNo > @txn OR EntryDate > @entry OR ApprovedDate > @approved`), join
`InventoryFlowDtl` for the DISTINCT (ItemCode, Warehouse) set → per-item **warehouse-scoped**
`sp_Onhand` refresh (never global — Q9) → update POS stock + push SSE. `maxItemEntry` advanced →
import just those items via the existing product-import path.

**Coverage:** new docs + approvals (the normal shop events) = realtime 2-4s; un-approve/edit/delete
of existing rows without a new Approved/Entry stamp = caught by the demoted full-reconcile sweep
(≤60s). This bound is explicit and accepted by the owner.

**Cursor storage:** watermark cursor row in Postgres (txn int + 3 timestamps), advanced only after a
cycle fully applies — crash-safe replay (re-processing the same docs is idempotent because the
refresh re-reads scoped sp_Onhand truth rather than applying deltas).
