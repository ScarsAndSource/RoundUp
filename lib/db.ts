// lib/db.ts
// Prisma singleton — reuses the same client instance across hot reloads in dev.
// FIX #18: validateEnv() call ensures DATABASE_URL is present before PrismaClient init.

import { PrismaClient } from "@prisma/client";
import { validateEnv } from "./env";

validateEnv();

const globalForPrisma = globalThis as unknown as { _prisma?: PrismaClient };

export const db =
  globalForPrisma._prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["error", "warn"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma._prisma = db;
}
