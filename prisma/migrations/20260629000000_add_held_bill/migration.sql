-- Migration: add_held_bill (พักบิล / hold-bill feature)
-- Additive only. One new table holding a server-side SNAPSHOT of an in-progress cart so
-- a cashier can park a sale and resume it later. No existing table altered, no backfill,
-- no FK (customerId is plain TEXT — no cascade), no constraint changes on other models.
-- Existing flows (checkout, orders, money/stock, auth) are untouched. The cartJson is a
-- JSONB display/restore snapshot; checkout still recomputes all money/stock server-side
-- on a resumed bill (the snapshot's prices are never trusted).

-- CreateTable
CREATE TABLE "HeldBill" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "cartJson" JSONB NOT NULL,
    "customerId" TEXT,
    "discountType" TEXT NOT NULL,
    "discountValue" DOUBLE PRECISION NOT NULL,
    "taxRequested" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "branchId" TEXT NOT NULL DEFAULT 'BR-01',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HeldBill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HeldBill_createdById_createdAt_idx" ON "HeldBill"("createdById", "createdAt");
