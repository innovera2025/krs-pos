-- CreateTable
CREATE TABLE "KrsWatermarkCursor" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "lastTxn" INTEGER NOT NULL DEFAULT 0,
    "lastEntryAt" TIMESTAMP(3),
    "lastApprovedAt" TIMESTAMP(3),
    "lastItemEntryAt" TIMESTAMP(3),
    "lastCycleAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KrsWatermarkCursor_pkey" PRIMARY KEY ("id")
);
