import type { FastifyInstance } from "fastify";
import {
  createReferralConfigurationSchema,
  reviewReferralProofSchema,
  submitReferralProofSchema,
} from "@adstrackio/validation";
import {
  activateReferralConfiguration,
  createReferralConfiguration,
  getReferralConfiguration,
  listReferralConfigurations,
} from "./referral-configurations.service.js";
import {
  listReferralProofs,
  reviewReferralProof,
  submitReferralProof,
} from "./referral-proofs.service.js";

export async function registerReferralRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/organizations/:organizationId/referral-configurations",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("VIEWER")] },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const referralConfigurations = await listReferralConfigurations(
        fastify.prisma,
        organizationId,
      );
      return { referralConfigurations };
    },
  );

  fastify.post(
    "/organizations/:organizationId/referral-configurations",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("MEMBER")] },
    async (request, reply) => {
      const { organizationId } = request.params as { organizationId: string };
      const input = createReferralConfigurationSchema.parse(request.body);
      const configuration = await createReferralConfiguration(
        fastify.prisma,
        request.user!.id,
        organizationId,
        input,
      );
      reply.status(201);
      return { referralConfiguration: configuration };
    },
  );

  fastify.get(
    "/organizations/:organizationId/referral-configurations/:configurationId",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("VIEWER")] },
    async (request) => {
      const { organizationId, configurationId } = request.params as {
        organizationId: string;
        configurationId: string;
      };
      const configuration = await getReferralConfiguration(
        fastify.prisma,
        organizationId,
        configurationId,
      );
      return { referralConfiguration: configuration };
    },
  );

  fastify.post(
    "/organizations/:organizationId/referral-configurations/:configurationId/activate",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("ADMIN")] },
    async (request) => {
      const { organizationId, configurationId } = request.params as {
        organizationId: string;
        configurationId: string;
      };
      const configuration = await activateReferralConfiguration(
        fastify.prisma,
        request.user!.id,
        organizationId,
        configurationId,
      );
      return { referralConfiguration: configuration };
    },
  );

  fastify.get(
    "/organizations/:organizationId/referral-configurations/:configurationId/proofs",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("VIEWER")] },
    async (request) => {
      const { organizationId, configurationId } = request.params as {
        organizationId: string;
        configurationId: string;
      };
      const proofs = await listReferralProofs(fastify.prisma, organizationId, configurationId);
      return { proofs };
    },
  );

  fastify.post(
    "/organizations/:organizationId/referral-configurations/:configurationId/proofs",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("MEMBER")] },
    async (request, reply) => {
      const { organizationId, configurationId } = request.params as {
        organizationId: string;
        configurationId: string;
      };
      const input = submitReferralProofSchema.parse(request.body);
      const proof = await submitReferralProof(
        fastify.prisma,
        request.user!.id,
        organizationId,
        configurationId,
        input,
      );
      reply.status(201);
      return { proof };
    },
  );

  fastify.post(
    "/organizations/:organizationId/referral-configurations/:configurationId/proofs/:proofId/review",
    { preHandler: [fastify.authenticate, fastify.requireOrganizationMember("ADMIN")] },
    async (request) => {
      const { organizationId, configurationId, proofId } = request.params as {
        organizationId: string;
        configurationId: string;
        proofId: string;
      };
      const input = reviewReferralProofSchema.parse(request.body);
      const proof = await reviewReferralProof(
        fastify.prisma,
        request.user!.id,
        organizationId,
        configurationId,
        proofId,
        input,
      );
      return { proof };
    },
  );
}
