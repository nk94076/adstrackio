import { prisma } from "@adstrackio/database";

/**
 * Truncates every application table between tests so integration tests
 * start from a clean slate without needing per-test transaction rollback
 * plumbing. Reads the table list from Postgres itself so it never drifts
 * from the Prisma schema.
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
