-- AlterEnum
ALTER TYPE "StockMovementType" ADD VALUE 'KRS_SYNC';

-- CreateTable
CREATE TABLE "KrsStockSnapshot" (
    "itemCode" TEXT NOT NULL,
    "lastQty" DECIMAL(12,4) NOT NULL,
    "lockedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KrsStockSnapshot_pkey" PRIMARY KEY ("itemCode")
);
