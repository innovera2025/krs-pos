"use client";

import { ProductImportMappingSection } from "./ProductImportMappingSection";

/**
 * Field Mapping tab (KRS Data Link). Renders ONLY the REAL, persisted product-import
 * mapping editor: pick a KRS source table + map each KRS column → POS Product field,
 * saved via /api/krs/mappings and used by the "ดึงสินค้าจาก KRS" pull + the inbound
 * auto-sync.
 *
 * The earlier static/mockup sections were removed (2026-06-24): the POS↔KRS flow
 * diagram, the outbound POS→KRS field table, the GL account/payment mappings, and the
 * non-persisting sync-mode / stock-method toggles. They displayed demo data and KRS
 * tables that do NOT exist in the real ERP (e.g. `sales`, `stock_movements`) and did
 * not read or write anything — so they were misleading. Real outbound (POS→KRS)
 * mapping will be built in Phase 2 against the vendor's actual write interface
 * (see process/features/krs-sync/references/krs-writeback-spec-request_23-06-26.md).
 */
export function FieldMappingTab() {
  return (
    <div className="flex flex-col gap-4">
      <ProductImportMappingSection />
    </div>
  );
}
