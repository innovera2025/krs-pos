-- Migration: add_orderitem_reward (loyalty program, Phase 3B — redeem a reward for a
-- free item at POS)
--
-- ADDITIVE only: three new nullable/defaulted columns on "OrderItem" so a redeemed
-- reward's free unit can be attributed + reported on its cart line. No backfill and no
-- destructive change — every existing OrderItem reads rewardId/rewardName NULL and
-- rewardDiscount 0.00. Hand-authored (mirrors 20260720000000_add_promo_get_amount_off)
-- for the local DDL-less app-role fallback.
--
--  - rewardId       : the applied Reward id — a PLAIN String snapshot (NO FK; same
--                     historical-immutability stance as OrderItem.promotionId).
--  - rewardName     : the Reward display name at sale time (receipt line).
--  - rewardDiscount : the free-unit value (baht) folded into lineTotal for this line —
--                     Decimal(10,2), DEFAULT 0 so it never breaks the money contract.

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN "rewardId" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "rewardName" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "rewardDiscount" DECIMAL(10,2) NOT NULL DEFAULT 0;
