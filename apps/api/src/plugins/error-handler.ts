import fp from "fastify-plugin";
import type { FastifyError, FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { ApiError } from "@adstrackio/shared";

/**
 * Central error handler producing a consistent { error: { code, message,
 * details } } body for every failure path. Unexpected errors are logged in
 * full server-side but never leak internals (stack traces, driver errors)
 * to the client.
 */
export const errorHandlerPlugin = fp(async function errorHandlerPlugin(fastify: FastifyInstance) {
  fastify.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ApiError) {
      if (error.statusCode >= 500) {
        request.log.error({ err: error }, "request failed with a server error");
      }
      reply.status(error.statusCode).send(error.toBody());
      return;
    }

    if (error instanceof ZodError) {
      const apiError = ApiError.validation("Request validation failed", error.flatten());
      reply.status(apiError.statusCode).send(apiError.toBody());
      return;
    }

    // Fastify's own schema validation errors carry a statusCode of 400.
    if ("validation" in error && error.validation) {
      const apiError = ApiError.validation(error.message);
      reply.status(apiError.statusCode).send(apiError.toBody());
      return;
    }

    if (error.statusCode === 429) {
      const apiError = ApiError.rateLimited();
      reply.status(apiError.statusCode).send(apiError.toBody());
      return;
    }

    // Any other Fastify-internal client error (malformed JSON, an empty
    // body sent with a JSON content-type, an unsupported media type, ...)
    // still deserves its real status code and message rather than being
    // flattened into a generic 500.
    if (typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      const apiError = ApiError.validation(error.message);
      reply.status(apiError.statusCode).send(apiError.toBody());
      return;
    }

    request.log.error({ err: error }, "unhandled error");
    const apiError = ApiError.internal();
    reply.status(apiError.statusCode).send(apiError.toBody());
  });

  fastify.setNotFoundHandler((_request, reply) => {
    const apiError = ApiError.notFound("Route not found");
    reply.status(apiError.statusCode).send(apiError.toBody());
  });
});
