import { PrismaClient } from "@prisma/client";
// Importing env here runs the fail-fast environment validation at server boot
// (prisma.ts is a Node-only module imported by every API route). A missing/invalid
// DATABASE_URL or AUTH_SECRET throws with a clear message instead of failing later
// with a cryptic Prisma/JWT error. NEVER import this from an edge module.
import { env } from "@/lib/env";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });

if (env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
