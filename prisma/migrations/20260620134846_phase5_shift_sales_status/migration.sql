-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('PENDING', 'DAILY', 'SYNCED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('OPEN', 'CLOSED');

-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'VOIDED';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "accountingDocNo" TEXT,
ADD COLUMN     "shiftId" TEXT,
ADD COLUMN     "syncStatus" "SyncStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "taxRequested" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL,
    "shiftNumber" TEXT NOT NULL,
    "status" "ShiftStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "openingFloat" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "countedCash" DECIMAL(10,2),
    "cashierId" TEXT,
    "branchId" TEXT NOT NULL DEFAULT 'BR-01',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shift_shiftNumber_key" ON "Shift"("shiftNumber");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_cashierId_fkey" FOREIGN KEY ("cashierId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
