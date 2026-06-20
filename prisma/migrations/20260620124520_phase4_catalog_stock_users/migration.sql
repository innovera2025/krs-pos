-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('RECEIVE', 'SALE', 'ADJUST');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "branchId" TEXT NOT NULL DEFAULT 'BR-01';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "branchId" TEXT NOT NULL DEFAULT 'BR-01';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "branchId" TEXT NOT NULL DEFAULT 'BR-01',
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "qty" INTEGER NOT NULL,
    "reference" TEXT,
    "branchId" TEXT NOT NULL DEFAULT 'BR-01',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
