import type { FastifyInstance, FastifyReply } from "fastify";
import type { Env } from "@adstrackio/config";
import { createSessionToken, SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from "@adstrackio/auth";
import { loginSchema, registerSchema } from "@adstrackio/validation";
import { authenticateUser, registerUser } from "./auth.service.js";

/**
 * Rate limiting is a production defense against credential stuffing and
 * brute force. In tests every request comes from the same simulated
 * client (Fastify's `inject()` has no real per-request IP), so a single
 * test file registering more than ~10 accounts would otherwise trip the
 * production limit and fail for reasons unrelated to what it's testing.
 * The limiter itself is covered by manual/integration verification against
 * a running server, not by the application test suite.
 */
function authRateLimit(env: Env) {
  return env.NODE_ENV === "test"
    ? { max: 1000, timeWindow: "1 minute" }
    : { max: 10, timeWindow: "1 minute" };
}

async function issueSession(
  reply: FastifyReply,
  env: Env,
  userId: string,
  activeOrganizationId?: string,
) {
  const token = await createSessionToken({
    secret: env.AUTH_SECRET,
    payload: { userId, activeOrganizationId },
  });

  reply.setCookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function registerAuthRoutes(fastify: FastifyInstance, opts: { env: Env }) {
  fastify.post(
    "/auth/register",
    { config: { rateLimit: authRateLimit(opts.env) } },
    async (request, reply) => {
      const input = registerSchema.parse(request.body);
      const { user, organizationId } = await registerUser(fastify.prisma, input);

      await issueSession(reply, opts.env, user.id, organizationId ?? undefined);

      reply.status(201);
      return { user, organizationId };
    },
  );

  fastify.post(
    "/auth/login",
    { config: { rateLimit: authRateLimit(opts.env) } },
    async (request, reply) => {
      const input = loginSchema.parse(request.body);
      const user = await authenticateUser(fastify.prisma, input);

      await issueSession(reply, opts.env, user.id);

      return { user };
    },
  );

  fastify.post("/auth/logout", async (_request, reply) => {
    // Sessions are stateless JWTs in Phase 1 (see packages/auth/src/session.ts);
    // logout clears the client's cookie but cannot revoke a token that has
    // already been copied elsewhere. Documented in docs/architecture/security.md.
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    reply.status(204);
  });

  fastify.get(
    "/auth/me",
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const memberships = await fastify.prisma.organizationMember.findMany({
        where: { userId: request.user!.id },
        include: { organization: { select: { id: true, name: true, slug: true } } },
      });

      return { user: request.user, memberships };
    },
  );
}
