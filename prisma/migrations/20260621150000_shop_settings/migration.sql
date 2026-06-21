-- Admin-configurable receipt print size: a singleton ShopSettings row.
-- Defaults (80mm width, height AUTO) match the previous hardcoded `@page { size: 80mm auto }`
-- so deploying is a no-op behaviorally. Additive only — one new table, no FKs.
CREATE TABLE "ShopSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "receiptWidthMm" INTEGER NOT NULL DEFAULT 80,
    "receiptHeightAuto" BOOLEAN NOT NULL DEFAULT true,
    "receiptHeightMm" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ShopSettings_pkey" PRIMARY KEY ("id")
);
