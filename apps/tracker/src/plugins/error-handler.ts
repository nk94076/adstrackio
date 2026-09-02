import fp from "fastify-plugin";
import type { FastifyError, FastifyInstance } from "fastify";
import { ApiError } from "@adstrackio/shared";

/**
 * Same consistent { error: { code, message, details } } shape as apps/api
 * (packages/shared/src/api-error.ts), for the tracker's error responses
 * (invalid redirection_url, unknown domain/link, etc). The tracker never
 * has a body to return on a successful request — it redirects — so this
 * only ever fires on the failure paths.
 */
export const errorHandlerPlugin = fp(async function errorHandlerPlugin(fastify: FastifyInstance) {
  fastify.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ApiError) {
      if (error.statusCode >= 500) {
        request.log.error({ err: error }, "tracker request failed with a server error");
      }
      reply.status(error.statusCode).send(error.toBody());
      return;
    }

    if (typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      const apiError = ApiError.validation(error.message);
      reply.status(apiError.statusCode).send(apiError.toBody());
      return;
    }

    request.log.error({ err: error }, "unhandled tracker error");
    const apiError = ApiError.internal();
    reply.status(apiError.statusCode).send(apiError.toBody());
  });

  fastify.setNotFoundHandler((_request, reply) => {
    const apiError = ApiError.notFound("Not found");
    reply.status(apiError.statusCode).send(apiError.toBody());
  });
});
