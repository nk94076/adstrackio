import "fastify";
import type { PrismaClient } from "@adstrackio/database";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}
