-- Migration: add_promo_get_amount_off (promotions — BUY_X_GET_Y ฿-off reward)
-- Additive only: one new nullable Int column on "Promotion". No backfill, no
-- constraint changes. Stores the per-rewarded-unit baht discount in SATANG for the
-- new BUY_X_GET_Y "ลดเป็นจำนวนเงิน" reward mode. NULL on every existing row = the
-- promotion uses getDiscountPercent (percent/ฟรี) as before; exactly one of the two
-- reward fields is ever populated (enforced at the API boundary, not the DB).
ALTER TABLE "Promotion" ADD COLUMN "getAmountOffSatang" INTEGER;
