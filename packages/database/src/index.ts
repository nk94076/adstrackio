import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __adstrackioPrisma: PrismaClient | undefined;
}

/**
 * Shared Prisma client singleton. In development, processes can be reloaded
 * (e.g. by a watcher) without restarting the whole runtime, which would
 * otherwise exhaust Postgres connections by creating a new PrismaClient per
 * reload — so the instance is cached on `globalThis`.
 */
export const prisma: PrismaClient =
  globalThis.__adstrackioPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__adstrackioPrisma = prisma;
}

export * from "@prisma/client";
