-- Phase 4 (4a) — Thai tax invoice (ใบกำกับภาษี): yearly sequential-number counter + buyer branch code.

-- Atomic, gapless yearly tax-invoice number counter (mirrors DailyOrderCounter).
-- Bumped via INSERT … ON CONFLICT DO UPDATE … RETURNING inside the request-tax tx.
CREATE TABLE "TaxInvoiceCounter" (
    "year" TEXT NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "TaxInvoiceCounter_pkey" PRIMARY KEY ("year")
);

-- Buyer RD branch designation for a full §86/4 tax invoice ("00000" = สำนักงานใหญ่/HQ).
ALTER TABLE "Customer" ADD COLUMN "buyerBranchCode" TEXT NOT NULL DEFAULT '00000';

-- §86/4(7): the date the tax invoice was ISSUED (stamped at request-tax, distinct from the sale date).
ALTER TABLE "Order" ADD COLUMN "taxIssuedAt" TIMESTAMP(3);

-- DB backstop: a tax-invoice number must be unique (nullable → many NULLs allowed for un-issued bills).
CREATE UNIQUE INDEX "Order_accountingDocNo_key" ON "Order"("accountingDocNo");
