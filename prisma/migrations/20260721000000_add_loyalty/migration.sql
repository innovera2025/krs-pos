-- Migration: add_loyalty (loyalty program, Phase 1A — Membership + Loyalty Points)
-- ADDITIVE only: a new PointsTransaction table + PointsTxType enum, additive columns on
-- Customer / Order / ShopSettings, three new AuditAction enum values, and a raw PARTIAL
-- UNIQUE index enforcing phone uniqueness ONLY among members. No backfill and no
-- destructive change; every added column is defaulted so existing rows read cleanly.
--
-- Postgres note (mirrors 20260714080426_add_promotions): a NEW enum type (PointsTxType)
-- may be USED immediately in the same migration (the CREATE TABLE below); the "cannot use
-- a newly ADDED enum value in the same transaction that adds it" rule applies ONLY to
-- ALTER TYPE ... ADD VALUE — and the three AuditAction values added here are NOT
-- referenced anywhere in this migration, so this is safe (identical to the promotions
-- migration's AuditAction additions).

-- CreateEnum
CREATE TYPE "PointsTxType" AS ENUM ('EARN', 'REDEEM', 'ADJUST', 'REVERSAL');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'MEMBER_ENROLLED';
ALTER TYPE "AuditAction" ADD VALUE 'POINTS_ADJUSTED';
ALTER TYPE "AuditAction" ADD VALUE 'LOYALTY_SETTINGS_CHANGED';

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "isMember" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "memberSince" TIMESTAMP(3),
ADD COLUMN     "pointsBalance" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "pointsEarned" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pointsRedeemed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pointsRedemptionDiscount" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "earnBahtPerPoint" INTEGER NOT NULL DEFAULT 25,
ADD COLUMN     "loyaltyEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "minRedeemPoints" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "redeemPointValueSatang" INTEGER NOT NULL DEFAULT 10;

-- CreateTable
CREATE TABLE "PointsTransaction" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "orderId" TEXT,
    "type" "PointsTxType" NOT NULL,
    "points" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "note" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PointsTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PointsTransaction_customerId_createdAt_idx" ON "PointsTransaction"("customerId", "createdAt");

-- AddForeignKey
ALTER TABLE "PointsTransaction" ADD CONSTRAINT "PointsTransaction_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Partial UNIQUE index (loyalty program, Phase 1A) — RAW SQL because Prisma cannot express
-- a partial/filtered unique index natively. Enforces phone uniqueness ONLY among members
-- (isMember = true AND phone IS NOT NULL), so pre-existing null/duplicate NON-member phones
-- stay valid while a member's phone is a true key. A duplicate member phone raises SQLSTATE
-- 23505 on this constraint, which the customers API maps to 409 MEMBER_PHONE_TAKEN.
CREATE UNIQUE INDEX "Customer_phone_member_key" ON "Customer"("phone") WHERE "isMember" = true AND "phone" IS NOT NULL;
