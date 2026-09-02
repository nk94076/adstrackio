import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  ApiError,
  TrackingResolutionError,
  TransparentRedirectValidationError,
  hashIp,
  resolveBotRoutingAction,
  validateTransparentRedirectUrl,
  type BotDetectionEngine,
  type BotDetectionHeaderSignals,
  type GeoLocationProvider,
  type TrackingResolver,
  type UserAgentParser,
} from "@adstrackio/shared";
import { classifyWithSafeFallback } from "../bot-detection/classify-with-fallback.js";
import { generateClickId } from "./click-id.js";
import { recordClick } from "./tracker.service.js";

export interface TrackerRouteOptions {
  resolver: TrackingResolver;
  botDetectionEngine: BotDetectionEngine;
  userAgentParser: UserAgentParser;
  geoLocationProvider: GeoLocationProvider;
  ipHashSalt: string;
}

/** Strips a port suffix from the Host header (e.g. "track.example.com:8443"
 * in a non-standard-port deployment) and lowercases it — a registered
 * TrackingDomain hostname never itself contains a port (Phase 2 rejects
 * that at creation), so this is normalizing the *request*, not the stored
 * value, to the same shape. */
function normalizeRequestHostname(hostname: string): string {
  return hostname.split(":")[0]!.toLowerCase();
}

/** Fastify/Node header values are `string | string[] | undefined`; these
 * headers are never legitimately repeated, so the first value (if any) is
 * used and anything else normalizes to `undefined` — never an array or
 * empty string treated as "present." */
function headerString(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && raw.trim() ? raw : undefined;
}

/** Extracts only the small, explicit set of headers the detection engine
 * is allowed to see (packages/shared/src/bot-detection.ts) — never the
 * full raw header set. */
function extractDetectionHeaderSignals(request: FastifyRequest): BotDetectionHeaderSignals {
  return {
    accept: headerString(request.headers.accept),
    acceptLanguage: headerString(request.headers["accept-language"]),
    secFetchMode: headerString(request.headers["sec-fetch-mode"]),
    secFetchSite: headerString(request.headers["sec-fetch-site"]),
    secFetchDest: headerString(request.headers["sec-fetch-dest"]),
  };
}

function mapResolutionError(error: TrackingResolutionError): ApiError {
  if (error.reason === "link_inactive") {
    // 410 Gone: this slug existed and was deliberately retired, distinct
    // from "never existed" (404) — see docs/architecture/security.md.
    return new ApiError("NOT_FOUND", 410, "This tracking link is no longer active");
  }
  // Every other failure (unknown/unverified/inactive domain, unknown link)
  // gets a uniform 404. Distinguishing "domain exists but isn't verified"
  // from "domain doesn't exist" to an anonymous caller would be an
  // unnecessary information leak about which hostnames are registered.
  return ApiError.notFound("Not found");
}

export async function registerTrackerRoutes(
  fastify: FastifyInstance,
  options: TrackerRouteOptions,
) {
  fastify.get("/:slug", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const hostname = normalizeRequestHostname(request.hostname);

    request.log.info({ hostname, slug }, "tracker request");

    const query = request.query as Record<string, unknown>;
    const rawRedirectionUrl = query.redirection_url;

    if (typeof rawRedirectionUrl !== "string") {
      request.log.warn({ hostname, slug }, "invalid transparent destination");
      throw ApiError.validation("redirection_url query parameter is required");
    }

    let redirectTarget: string;
    try {
      redirectTarget = validateTransparentRedirectUrl(rawRedirectionUrl);
    } catch (error) {
      if (error instanceof TransparentRedirectValidationError) {
        request.log.warn(
          { hostname, slug, reason: error.message },
          "invalid transparent destination",
        );
        throw ApiError.validation(error.message);
      }
      throw error;
    }

    let resolution;
    try {
      resolution = await options.resolver.resolve({ hostname, slug });
    } catch (error) {
      if (error instanceof TrackingResolutionError) {
        request.log.warn(
          { hostname, slug, reason: error.reason },
          error.reason.startsWith("domain") ? "domain resolution failure" : "link resolution failure",
        );
        throw mapResolutionError(error);
      }
      throw error;
    }

    const clickId = generateClickId();
    const userAgentHeader = request.headers["user-agent"];
    const userAgent = typeof userAgentHeader === "string" ? userAgentHeader : undefined;
    const refererHeader = request.headers.referer;
    const referrer = typeof refererHeader === "string" ? refererHeader : undefined;
    const ipHash = hashIp(request.ip, options.ipHashSalt);

    // Bot classification is entirely server-computed from server-observed
    // request data (User-Agent + a small explicit set of other headers,
    // via the injected BotDetectionEngine) — there is no request field
    // that can assert its own bot/human status, override the score, or
    // supply its own reason codes. classifyWithSafeFallback guarantees a
    // classification is always produced, even if the engine throws,
    // rejects, or hangs (see its doc comment) — detection failure must
    // never crash or stall the redirect.
    const classification = await classifyWithSafeFallback(options.botDetectionEngine, {
      clickId,
      userAgent,
      ipHash,
      headers: extractDetectionHeaderSignals(request),
    });

    // The routing action is resolved purely from the classification and
    // the campaign's own configured policy (packages/shared's
    // resolveBotRoutingAction) — never from any request-supplied value.
    // BOT always maps to SAFE_PAGE and HUMAN always maps to TARGET;
    // SUSPICIOUS/UNKNOWN follow whatever policy the campaign has
    // configured (TARGET by default — see Campaign.suspiciousTrafficPolicy
    // / unknownTrafficPolicy).
    const routingAction = resolveBotRoutingAction(
      classification.classification,
      resolution.botTrafficPolicy,
    );

    request.log.info(
      {
        clickId,
        trackingLinkId: resolution.trackingLinkId,
        classification: classification.classification,
        reasonCodes: classification.reasonCodes,
        routingAction,
      },
      "bot classification",
    );

    await recordClick(
      fastify.prisma,
      {
        id: clickId,
        organizationId: resolution.organizationId,
        campaignId: resolution.campaignId,
        trackingLinkId: resolution.trackingLinkId,
        userAgent,
        referrer,
        ipHash,
        ip: request.ip,
        classification,
      },
      {
        userAgentParser: options.userAgentParser,
        geoLocationProvider: options.geoLocationProvider,
      },
    );

    switch (routingAction) {
      case "SAFE_PAGE": {
        if (!resolution.safePageUrl) {
          request.log.info({ clickId, routedTo: "controlled-404" }, "redirect decision");
          throw ApiError.notFound("Not found");
        }
        request.log.info({ clickId, routedTo: "safe-page" }, "redirect decision");
        reply.redirect(resolution.safePageUrl, 302);
        return;
      }
      case "BLOCK": {
        // Same controlled, no-hidden-destination response as "SAFE_PAGE
        // configured but unset" — BLOCK never guesses a destination and
        // never falls back to the transparent one.
        request.log.info({ clickId, routedTo: "blocked" }, "redirect decision");
        throw ApiError.notFound("Not found");
      }
      case "TARGET": {
        request.log.info({ clickId, routedTo: "transparent-destination" }, "redirect decision");
        reply.redirect(redirectTarget, 302);
        return;
      }
    }
  });
}
