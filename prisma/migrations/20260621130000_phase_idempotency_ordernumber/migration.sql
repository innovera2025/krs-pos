-- Sub-phase C: idempotency + collision-safe orderNumber.

-- AlterTable: client-generated idempotency key (nullable → multiple NULLs allowed in Postgres).
ALTER TABLE "Order" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex: unique replay key.
CREATE UNIQUE INDEX "Order_idempotencyKey_key" ON "Order"("idempotencyKey");

-- CreateTable: atomic per-Bangkok-day order-number counter (race-free via INSERT ... ON CONFLICT).
CREATE TABLE "DailyOrderCounter" (
    "day" TEXT NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "DailyOrderCounter_pkey" PRIMARY KEY ("day")
);
