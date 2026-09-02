import { prisma } from "@adstrackio/database";

/**
 * Truncates every application table between tests. Same approach as
 * apps/api/test/db-reset.ts, intentionally duplicated rather than shared
 * across app boundaries — apps/tracker is a separate deployable and its
 * test infrastructure shouldn't depend on apps/api's.
 */
export async function resetDatabase(): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename != '_prisma_migrations'
  `;

  if (tables.length === 0) {
    return;
  }

  const quoted = tables.map((t) => `"${t.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
}
