-- AlterEnum: money-trail counterpart to ORDER_REFUNDED / ORDER_VOIDED (logged on checkout success).
ALTER TYPE "AuditAction" ADD VALUE 'ORDER_CREATED';

-- Financial / inventory integrity CHECK constraints (Sub-phase B).
-- The DB becomes the last line of defence: even a logic regression cannot persist
-- negative stock/prices/totals. NOTE: "StockMovement"."qty" intentionally allows
-- negative values (SALE = outbound) and gets NO check.
ALTER TABLE "Product"     ADD CONSTRAINT "Product_stock_nonneg_chk"        CHECK ("stock" >= 0);
ALTER TABLE "Product"     ADD CONSTRAINT "Product_price_nonneg_chk"        CHECK ("price" >= 0);
ALTER TABLE "Order"       ADD CONSTRAINT "Order_total_nonneg_chk"          CHECK ("total" >= 0);
ALTER TABLE "OrderItem"   ADD CONSTRAINT "OrderItem_quantity_pos_chk"      CHECK ("quantity" > 0);
ALTER TABLE "OrderItem"   ADD CONSTRAINT "OrderItem_unitPrice_nonneg_chk"  CHECK ("unitPrice" >= 0);
ALTER TABLE "OrderItem"   ADD CONSTRAINT "OrderItem_lineTotal_nonneg_chk"  CHECK ("lineTotal" >= 0);
ALTER TABLE "PaymentLine" ADD CONSTRAINT "PaymentLine_amount_nonneg_chk"   CHECK ("amount" >= 0);
