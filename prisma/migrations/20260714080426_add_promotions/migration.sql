-- CreateEnum
CREATE TYPE "PromotionType" AS ENUM ('PRODUCT_DISCOUNT', 'FIXED_PRICE', 'BUY_X_GET_Y', 'BILL_THRESHOLD');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'PROMOTION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'PROMOTION_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'PROMOTION_ACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'PROMOTION_DEACTIVATED';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "billPromotionId" TEXT,
ADD COLUMN     "billPromotionName" TEXT,
ADD COLUMN     "promoBillDiscount" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "promoDiscount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "promotionId" TEXT,
ADD COLUMN     "promotionName" TEXT;

-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "type" "PromotionType" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "branchId" TEXT NOT NULL DEFAULT 'BR-01',
    "percentOff" DECIMAL(5,2),
    "amountOffSatang" INTEGER,
    "fixedPriceSatang" INTEGER,
    "buyQty" INTEGER,
    "getQty" INTEGER,
    "getDiscountPercent" INTEGER,
    "minSubtotalSatang" INTEGER,
    "productIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Promotion_code_key" ON "Promotion"("code");

-- CreateIndex
CREATE INDEX "Promotion_isActive_startsAt_endsAt_idx" ON "Promotion"("isActive", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "OrderItem_promotionId_idx" ON "OrderItem"("promotionId");
