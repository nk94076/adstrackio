import type { FastifyInstance } from "fastify";
import { ApiError } from "@adstrackio/shared";
import { createConversionSchema, idempotencyKeySchema, listConversionsQuerySchema } from "@adstrackio/validation";
import { actorIdOf } from "../../plugins/api-key-auth.js";
import { withIdempotencyKey } from "../idempotency/idempotency.service.js";
import {
  approveConversion,
  createConversionInTx,
  getConversion,
  listConversions,
  rejectConversion,
  reverseConversion,
} from "./conversions.service.js";

const CONVERSION_CREATE_SCOPE = "conversion.create";

function parseIdempotencyKeyHeader(request: { headers: Record<string, unknown> }): string | undefined {
  const raw = request.headers["idempotency-key"];
  if (raw === undefined) {
    return undefined;
  }
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") {
    throw ApiError.validation("Idempotency-Key must be a single string value");
  }
  return idempotencyKeySchema.parse(value);
}

/**
 * Conversion ingestion (POST) is dual-auth (Phase 11) — a dashboard
 * session (MEMBER+, matching this codebase's existing event-ingestion
 * model) or a public API key carrying WRITE or CONVERSIONS scope. Status
 * decisions (approve/reject/reverse) remain ADMIN-equivalent, gated at
 * WRITE or CONVERSIONS scope for the API-key path — approving
 * revenue-bearing state is a bigger blast radius than reporting an event
 * happened, same reasoning Phase 6 applied to campaign/tracking-link
 * lifecycle actions. Reads accept READ or CONVERSIONS scope.
 */
export async function registerConversionRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/organizations/:organizationId/conversions",
    { preHandler: [fastify.authenticateEither, fastify.requireOrgAccess("VIEWER", ["READ", "CONVERSIONS"])] },
    async (request) => {
      const { organizationId } = request.params as { organizationId: string };
      const query = listConversionsQuerySchema.parse(request.query);
      const conversions = await listConversions(fastify.prisma, organizationId, query);
      return { conversions };
    },
  );

  fastify.post(
    "/organizations/:organizationId/conversions",
    {
      preHandler: [
        fastify.authenticateEither,
        fastify.requireOrgAccess("MEMBER", ["WRITE", "CONVERSIONS"]),
      ],
    },
    async (request, reply) => {
      const { organizationId } = request.params as { organizationId: string };
      const input = createConversionSchema.parse(request.body);
      const idempotencyKey = parseIdempotencyKeyHeader(request);
      const actorUserId = actorIdOf(request);

      const { responseBody, replayed } = await withIdempotencyKey(
        fastify.prisma,
        {
          organizationId,
          scope: CONVERSION_CREATE_SCOPE,
          key: idempotencyKey,
          requestBody: input,
        },
        async (tx) => {
          const conversion = await createConversionInTx(tx, actorUserId, organizationId, input);
          return { responseBody: { conversion }, resourceId: conversion.id };
        },
      );

      reply.status(201);
      if (replayed) {
        reply.header("Idempotency-Replayed", "true");
      }
      return responseBody;
    },
  );

  fastify.get(
    "/organizations/:organizationId/conversions/:conversionId",
    { preHandler: [fastify.authenticateEither, fastify.requireOrgAccess("VIEWER", ["READ", "CONVERSIONS"])] },
    async (request) => {
      const { organizationId, conversionId } = request.params as {
        organizationId: string;
        conversionId: string;
      };
      const conversion = await getConversion(fastify.prisma, organizationId, conversionId);
      return { conversion };
    },
  );

  for (const action of [
    { path: "approve", fn: approveConversion },
    { path: "reject", fn: rejectConversion },
    { path: "reverse", fn: reverseConversion },
  ] as const) {
    fastify.post(
      `/organizations/:organizationId/conversions/:conversionId/${action.path}`,
      {
        preHandler: [
          fastify.authenticateEither,
          fastify.requireOrgAccess("ADMIN", ["WRITE", "CONVERSIONS"]),
        ],
      },
      async (request) => {
        const { organizationId, conversionId } = request.params as {
          organizationId: string;
          conversionId: string;
        };
        const conversion = await action.fn(fastify.prisma, actorIdOf(request), organizationId, conversionId);
        return { conversion };
      },
    );
  }
}
