-- CreateTable
CREATE TABLE "KrsFieldMapping" (
    "function" TEXT NOT NULL,
    "sourceTable" TEXT NOT NULL,
    "fieldMap" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KrsFieldMapping_pkey" PRIMARY KEY ("function")
);
