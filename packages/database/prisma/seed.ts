import argon2 from "argon2";
import { PrismaClient } from "../generated/client/index.js";

const prisma = new PrismaClient();

/**
 * Local development seed only. Creates one demo organization, owner user,
 * and membership so a freshly migrated database is immediately usable from
 * the dashboard. Never run against production data.
 */
async function main() {
  const email = "owner@example.com";
  const password = "ChangeMe123!";

  const passwordHash = await argon2.hash(password);

  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      passwordHash,
      name: "Demo Owner",
    },
  });

  const organization = await prisma.organization.upsert({
    where: { slug: "demo-org" },
    update: {},
    create: {
      name: "Demo Organization",
      slug: "demo-org",
    },
  });

  await prisma.organizationMember.upsert({
    where: { userId_organizationId: { userId: user.id, organizationId: organization.id } },
    update: {},
    create: {
      userId: user.id,
      organizationId: organization.id,
      role: "OWNER",
    },
  });

  console.warn(`Seeded demo organization "${organization.slug}" with owner ${email}`);
  console.warn(`Demo login password: ${password} (development only — change before real use)`);
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
