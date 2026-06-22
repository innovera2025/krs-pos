-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'KRS_SETTINGS_CHANGED';

-- CreateTable
CREATE TABLE "KrsConnectionSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 1433,
    "database" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "encryptedPassword" TEXT,
    "ssl" BOOLEAN NOT NULL DEFAULT true,
    "trustServerCert" BOOLEAN NOT NULL DEFAULT true,
    "engine" TEXT NOT NULL DEFAULT 'SQLSERVER',
    "syncMode" TEXT NOT NULL DEFAULT 'realtime',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KrsConnectionSettings_pkey" PRIMARY KEY ("id")
);
