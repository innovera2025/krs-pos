-- Migration: add_rewards (loyalty program, Phase 3A — Reward catalog + admin CRUD)
-- ADDITIVE only: a new Reward table + isActive index, and four new AuditAction enum
-- values (REWARD_CREATED / REWARD_UPDATED / REWARD_ACTIVATED / REWARD_DEACTIVATED).
-- No backfill and no destructive change. Hand-authored (mirrors 20260721000000_add_loyalty)
-- for the local DDL-less app-role fallback.
--
-- Postgres note (mirrors 20260721000000_add_loyalty): the four AuditAction values added
-- here are NOT referenced anywhere in THIS migration (the Reward table below does not use
-- the AuditAction type), so adding them via ALTER TYPE ... ADD VALUE is safe — the "cannot
-- use a newly ADDED enum value in the same transaction that adds it" rule does not apply.

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'REWARD_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'REWARD_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'REWARD_ACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'REWARD_DEACTIVATED';

-- CreateTable
CREATE TABLE "Reward" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pointsCost" INTEGER NOT NULL,
    "productId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reward_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Reward_isActive_idx" ON "Reward"("isActive");
