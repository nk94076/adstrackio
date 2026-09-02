import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { prisma } from "@adstrackio/database";

export const prismaPlugin = fp(async function prismaPlugin(fastify: FastifyInstance) {
  fastify.decorate("prisma", prisma);

  fastify.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
});
